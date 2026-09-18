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
    json_schema: z
      .object({
        name: z.string().optional(),
        schema: z.record(z.string(), z.unknown())
      })
      .passthrough()
  })
])

export const toolDef = z
  .object({
    type: z.string(),
    function: z
      .object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional()
      })
      .optional()
  })
  .passthrough()

const textContentPart = z
  .object({
    type: z.literal('text'),
    text: z.string()
  })
  .passthrough()

const imageContentPart = z
  .object({
    type: z.literal('image_url'),
    image_url: z.union([z.string(), z.object({ url: z.string() }).passthrough()])
  })
  .passthrough()

export const messageContentPart = z.discriminatedUnion('type', [textContentPart, imageContentPart])
export type MessageContentPart = z.infer<typeof messageContentPart>

export const chatMessage = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.null(), z.array(messageContentPart)]).optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string(),
          type: z.string(),
          function: z.object({ name: z.string(), arguments: z.string() })
        })
      )
      .optional(),
    tool_call_id: z.string().optional()
  })
  .passthrough()

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
  remove_thinking_from_context?: boolean
  /** `auto` | `none` | `required` | a declared tool's name. */
  tool_choice?: string
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

export function normalizeToolParameters(params: Record<string, unknown>): Record<string, unknown> {
  const props = params['properties'] as Record<string, Record<string, unknown>> | undefined
  if (!props) return params

  const normalized: Record<string, Record<string, unknown>> = {}
  for (const [key, prop] of Object.entries(props)) {
    normalized[key] = { ...prop, type: normalizeType(prop['type']) }
  }

  return { ...params, properties: normalized }
}

function normalizeType(type: unknown): string {
  if (typeof type === 'string' && VALID_TYPES.has(type)) return type
  if (Array.isArray(type)) {
    const primary = type.find(
      (t): t is string => typeof t === 'string' && t !== 'null' && VALID_TYPES.has(t)
    )
    return primary ?? 'string'
  }
  return 'string'
}

export function openaiToolsToSdk(tools: OpenAITool[] | undefined): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools
    .map((t): Tool | null => {
      if (t.type !== 'function' || !t.function) return null
      const fn = t.function
      return {
        type: 'function',
        name: fn.name,
        description: fn.description ?? '',
        parameters: normalizeToolParameters(
          fn.parameters ?? { type: 'object', properties: {} }
        ) as Tool['parameters']
      }
    })
    .filter((t): t is Tool => t !== null)
}

export class InvalidResponseFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidResponseFormatError'
  }
}

export class UnsupportedImageContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedImageContentError'
  }
}

export class InvalidToolChoiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidToolChoiceError'
  }
}

const TOOL_CHOICE_MODES = new Set(['auto', 'none', 'required'])

/**
 * OpenAI `tool_choice` accepts either a mode string or an object naming one
 * function. Chat nests the name under `function`; Responses flattens it onto
 * the object itself. Both collapse to the bare name the SDK takes.
 */
export const toolChoice = z.union([
  z.string(),
  z
    .object({
      type: z.string(),
      function: z.object({ name: z.string() }).passthrough().optional(),
      name: z.string().optional()
    })
    .passthrough()
])

/**
 * Translate OpenAI `tool_choice` into the SDK's string form, rejecting what
 * the SDK would reject anyway so the caller gets a 400 instead of a 500 out
 * of `completion()`.
 */
export function extractToolChoice(
  body: Record<string, unknown>,
  tools: Tool[] | undefined
): string | undefined {
  const raw = body['tool_choice']
  if (raw === undefined || raw === null) return undefined

  const choice = toolChoiceToSdk(raw)

  if (choice === 'none' || choice === 'auto') return choice

  if (!tools || tools.length === 0) {
    throw new InvalidToolChoiceError(
      `"tool_choice" ${JSON.stringify(choice)} requires at least one entry in "tools".`
    )
  }
  if (choice !== 'required' && !tools.some((tool) => tool.name === choice)) {
    throw new InvalidToolChoiceError(
      `"tool_choice" names ${JSON.stringify(choice)}, which is not one of the declared tools.`
    )
  }
  return choice
}

/**
 * Fold a resolved `tool_choice` into the generation params, which are
 * `undefined` when the request set none of the other knobs.
 */
export function withToolChoice(
  params: GenerationParams | undefined,
  choice: string | undefined
): GenerationParams | undefined {
  if (choice === undefined) return params
  return { ...(params ?? {}), tool_choice: choice }
}

function toolChoiceToSdk(raw: unknown): string {
  if (typeof raw === 'string') {
    if (TOOL_CHOICE_MODES.has(raw)) return raw
    throw new InvalidToolChoiceError(
      `"tool_choice" must be "auto", "none", "required", or an object naming a function ` +
        `(got ${JSON.stringify(raw)}).`
    )
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidToolChoiceError('"tool_choice" must be a string or an object.')
  }

  const obj = raw as Record<string, unknown>
  if (obj['type'] !== 'function') {
    throw new InvalidToolChoiceError(
      `"tool_choice.type" must be "function" (got ${JSON.stringify(obj['type'])}).`
    )
  }

  // Chat: { type, function: { name } }. Responses: { type, name }.
  const nested = obj['function']
  const nestedName =
    typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)['name']
      : undefined
  const name = typeof nestedName === 'string' ? nestedName : obj['name']

  if (typeof name !== 'string' || name.length === 0) {
    throw new InvalidToolChoiceError(
      '"tool_choice" must carry a non-empty function name ("function.name" or "name").'
    )
  }
  // The SDK encodes mode and target in one string, so a tool actually named
  // `auto`/`none`/`required` would read back as the mode and quietly invert the
  // request -- targeting `none` would disable tool calling. The object form is
  // unambiguous here and nowhere downstream, so the collision is caught here.
  if (TOOL_CHOICE_MODES.has(name)) {
    throw new InvalidToolChoiceError(
      `"tool_choice" cannot target a tool named ${JSON.stringify(name)}: the name is reserved ` +
        `for the "auto" / "none" / "required" modes. Rename the tool to target it.`
    )
  }
  return name
}

export function extractResponseFormat(body: Record<string, unknown>): ResponseFormat | undefined {
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
    if (
      typeof schemaWrapper !== 'object' ||
      schemaWrapper === null ||
      Array.isArray(schemaWrapper)
    ) {
      throw new InvalidResponseFormatError('"response_format.json_schema" must be an object.')
    }
    const wrapper = schemaWrapper as Record<string, unknown>
    const name = wrapper['name']
    const schema = wrapper['schema']
    if (typeof name !== 'string' || name.length === 0) {
      throw new InvalidResponseFormatError(
        '"response_format.json_schema.name" must be a non-empty string.'
      )
    }
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      throw new InvalidResponseFormatError(
        '"response_format.json_schema.schema" must be an object.'
      )
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

export function extractGenerationParams(
  body: Record<string, unknown>,
  altTokenField?: string
): GenerationParams | undefined {
  const params: GenerationParams = {}

  if (typeof body['temperature'] === 'number') params.temp = body['temperature']
  if (typeof body['top_p'] === 'number') params.top_p = body['top_p']
  if (typeof body['seed'] === 'number') params.seed = body['seed']
  if (typeof body['frequency_penalty'] === 'number') {
    params.frequency_penalty = body['frequency_penalty']
  }
  if (typeof body['presence_penalty'] === 'number') {
    params.presence_penalty = body['presence_penalty']
  }

  if (typeof body['max_tokens'] === 'number') params.predict = body['max_tokens']
  if (altTokenField && typeof body[altTokenField] === 'number') {
    params.predict = body[altTokenField] as number
  }

  if (typeof body['reasoning_budget'] === 'boolean') {
    params.reasoning_budget = body['reasoning_budget'] ? -1 : 0
  } else if (body['reasoning_budget'] === -1 || body['reasoning_budget'] === 0) {
    params.reasoning_budget = body['reasoning_budget']
  }

  if (typeof body['remove_thinking_from_context'] === 'boolean') {
    params.remove_thinking_from_context = body['remove_thinking_from_context']
  }

  return Object.keys(params).length > 0 ? params : undefined
}
