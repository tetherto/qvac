import { z } from 'zod'
import type { Tool } from '@qvac/sdk'

// ─── Wire-shape zod building blocks ────────────────────────────────────

export const errorResponse = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string()
  })
})

export const modelObject = z.object({
  id: z.string(),
  object: z.literal('model'),
  created: z.number(),
  owned_by: z.string()
})

export const responseFormat = z.union([
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string().optional(),
      schema: z.record(z.string(), z.unknown())
    }).passthrough()
  })
])

export const toolDef = z.object({
  type: z.string(),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional()
  }).optional()
}).passthrough()

export const chatMessage = z.object({
  role: z.string(),
  content: z.union([z.string(), z.null()]).optional(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.string(),
    function: z.object({ name: z.string(), arguments: z.string() })
  })).optional(),
  tool_call_id: z.string().optional()
}).passthrough()

// ─── SDK-side types ───────────────────────────────────────────────────

export interface GenerationParams {
  temp?: number
  top_p?: number
  top_k?: number
  predict?: number
  seed?: number
  frequency_penalty?: number
  presence_penalty?: number
  repeat_penalty?: number
  reasoning_budget?: -1 | 0
}

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema'
      json_schema: {
        name: string
        description?: string
        schema: Record<string, unknown>
        strict?: boolean
      }
    }

// ─── Input-side mappers shared across domains ─────────────────────────

interface OpenAITool {
  type: string
  function?: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])

export function normalizeToolParameters (params: Record<string, unknown>): Record<string, unknown> {
  const props = params['properties'] as Record<string, Record<string, unknown>> | undefined
  if (!props) return params

  const normalized: Record<string, Record<string, unknown>> = {}
  for (const [key, prop] of Object.entries(props)) {
    normalized[key] = { ...prop, type: normalizeType(prop['type']) }
  }

  return { ...params, properties: normalized }
}

function normalizeType (type: unknown): string {
  if (typeof type === 'string' && VALID_TYPES.has(type)) return type
  if (Array.isArray(type)) {
    const primary = type.find((t): t is string => typeof t === 'string' && t !== 'null' && VALID_TYPES.has(t))
    return primary ?? 'string'
  }
  return 'string'
}

export function openaiToolsToSdk (tools: OpenAITool[] | undefined): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools
    .map((t): Tool | null => {
      if (t.type !== 'function' || !t.function) return null
      const fn = t.function
      return {
        type: 'function',
        name: fn.name,
        description: fn.description ?? '',
        parameters: normalizeToolParameters(fn.parameters ?? { type: 'object', properties: {} }) as Tool['parameters']
      }
    })
    .filter((t): t is Tool => t !== null)
}

export class InvalidResponseFormatError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidResponseFormatError'
  }
}

export function extractResponseFormat (body: Record<string, unknown>): ResponseFormat | undefined {
  const raw = body['response_format']
  if (raw === undefined || raw === null) return undefined

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidResponseFormatError('"response_format" must be an object.')
  }

  const obj = raw as Record<string, unknown>
  const type = obj['type']

  if (type === 'text') return { type: 'text' }
  if (type === 'json_object') return { type: 'json_object' }

  if (type === 'json_schema') {
    const schemaWrapper = obj['json_schema']
    if (typeof schemaWrapper !== 'object' || schemaWrapper === null || Array.isArray(schemaWrapper)) {
      throw new InvalidResponseFormatError('"response_format.json_schema" must be an object.')
    }
    const wrapper = schemaWrapper as Record<string, unknown>
    const name = wrapper['name']
    const schema = wrapper['schema']
    if (typeof name !== 'string' || name.length === 0) {
      throw new InvalidResponseFormatError('"response_format.json_schema.name" must be a non-empty string.')
    }
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      throw new InvalidResponseFormatError('"response_format.json_schema.schema" must be an object.')
    }
    const result: ResponseFormat = {
      type: 'json_schema',
      json_schema: {
        name,
        schema: schema as Record<string, unknown>
      }
    }
    if (typeof wrapper['description'] === 'string') {
      result.json_schema.description = wrapper['description']
    }
    if (typeof wrapper['strict'] === 'boolean') {
      result.json_schema.strict = wrapper['strict']
    }
    return result
  }

  throw new InvalidResponseFormatError(
    `"response_format.type" must be one of "text", "json_object", "json_schema" (got ${JSON.stringify(type)}).`
  )
}

export function extractGenerationParams (
  body: Record<string, unknown>,
  altTokenField?: string
): GenerationParams | undefined {
  const params: GenerationParams = {}

  if (typeof body['temperature'] === 'number') params.temp = body['temperature']
  if (typeof body['top_p'] === 'number') params.top_p = body['top_p']
  if (typeof body['seed'] === 'number') params.seed = body['seed']
  if (typeof body['frequency_penalty'] === 'number') params.frequency_penalty = body['frequency_penalty']
  if (typeof body['presence_penalty'] === 'number') params.presence_penalty = body['presence_penalty']

  if (typeof body['max_tokens'] === 'number') params.predict = body['max_tokens']
  if (altTokenField && typeof body[altTokenField] === 'number') params.predict = body[altTokenField] as number

  if (typeof body['reasoning_budget'] === 'boolean') {
    params.reasoning_budget = body['reasoning_budget'] ? -1 : 0
  }

  return Object.keys(params).length > 0 ? params : undefined
}
