import type { Logger } from '../../../logger.js'
import type { SDKTool, SDKToolCall, SDKGenerationParams, SDKResponseFormat, SDKDiffusionParams } from '../../core/sdk.js'

interface OpenAIMessage {
  role: string
  content: string | null | undefined
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface OpenAITool {
  type: string
  function?: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

interface OpenAIToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

interface OpenAIToolCallDelta extends OpenAIToolCall {
  index: number
}

export function openaiMessagesToHistory (messages: OpenAIMessage[]): Array<{ role: string; content: string }> {
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      return { role: 'assistant', content: synthesizeToolCallContent(msg.tool_calls) }
    }

    return {
      role: msg.role,
      content: typeof msg.content === 'string'
        ? msg.content
        : (msg.content ?? '').toString()
    }
  })
}

function synthesizeToolCallContent (toolCalls: NonNullable<OpenAIMessage['tool_calls']>): string {
  return toolCalls.map((tc) => {
    let args: Record<string, unknown>
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>
    } catch {
      args = {}
    }

    const callObj = { name: tc.function.name, arguments: args }
    return `<tool_call>\n${JSON.stringify(callObj)}\n</tool_call>`
  }).join('\n')
}

export function openaiToolsToSdk (tools: OpenAITool[] | undefined): SDKTool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools
    .map((t): SDKTool | null => {
      if (t.type !== 'function' || !t.function) return null
      const fn = t.function
      return {
        type: 'function',
        name: fn.name,
        description: fn.description ?? '',
        parameters: normalizeToolParameters(fn.parameters ?? { type: 'object', properties: {} })
      }
    })
    .filter((t): t is SDKTool => t !== null)
}

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])

function normalizeToolParameters (params: Record<string, unknown>): Record<string, unknown> {
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

export function sdkToolCallsToOpenai (toolCalls: SDKToolCall[] | null | undefined): OpenAIToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string'
        ? tc.arguments
        : JSON.stringify(tc.arguments)
    }
  }))
}

export function sdkToolCallsToOpenaiDeltas (toolCalls: SDKToolCall[] | null | undefined): OpenAIToolCallDelta[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc, i) => ({
    index: i,
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string'
        ? tc.arguments
        : JSON.stringify(tc.arguments)
    }
  }))
}

export function extractGenerationParams (body: Record<string, unknown>): SDKGenerationParams | undefined {
  const params: SDKGenerationParams = {}

  if (typeof body['temperature'] === 'number') params.temp = body['temperature']
  if (typeof body['top_p'] === 'number') params.top_p = body['top_p']
  if (typeof body['seed'] === 'number') params.seed = body['seed']
  if (typeof body['frequency_penalty'] === 'number') params.frequency_penalty = body['frequency_penalty']
  if (typeof body['presence_penalty'] === 'number') params.presence_penalty = body['presence_penalty']

  if (typeof body['max_tokens'] === 'number') params.predict = body['max_tokens']
  if (typeof body['max_completion_tokens'] === 'number') params.predict = body['max_completion_tokens']

  if (typeof body['reasoning_budget'] === 'boolean') params.reasoning_budget = body['reasoning_budget']

  return Object.keys(params).length > 0 ? params : undefined
}

export class InvalidResponseFormatError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidResponseFormatError'
  }
}

export function extractResponseFormat (body: Record<string, unknown>): SDKResponseFormat | undefined {
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
    const result: SDKResponseFormat = {
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

const UNSUPPORTED_PARAMS = [
  'n', 'logprobs', 'stop', 'top_logprobs',
  'logit_bias', 'parallel_tool_calls', 'stream_options'
] as const

export function logUnsupportedParams (body: Record<string, unknown>, logger: Logger): void {
  for (const param of UNSUPPORTED_PARAMS) {
    if (body[param] !== undefined) {
      logger.warn(`Ignoring unsupported OpenAI param: ${param}=${JSON.stringify(body[param])}`)
    }
  }
}

// ─── /v1/images/generations helpers ────────────────────────────────────────

export class InvalidImageSizeError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidImageSizeError'
  }
}

export class InvalidImagePromptError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidImagePromptError'
  }
}

export class InvalidImageBatchCountError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidImageBatchCountError'
  }
}

export type ParsedImageSize =
  | { width: number; height: number }
  | { auto: true }
  | null

const SIZE_PATTERN = /^(\d+)x(\d+)$/

/**
 * Parse OpenAI `size` request field.
 * - undefined / missing → null (caller uses SDK defaults)
 * - "auto" → { auto: true }
 * - "WIDTHxHEIGHT" → { width, height } (both must be positive multiples of 8)
 * - anything else → throws InvalidImageSizeError
 */
export function parseImageSize (size: unknown): ParsedImageSize {
  if (size === undefined || size === null || size === '') return null
  if (typeof size !== 'string') {
    throw new InvalidImageSizeError('"size" must be a string like "1024x1024" or "auto".')
  }
  if (size === 'auto') return { auto: true }

  const match = SIZE_PATTERN.exec(size)
  if (!match) {
    throw new InvalidImageSizeError(`"size" must be "WIDTHxHEIGHT" or "auto" (got ${JSON.stringify(size)}).`)
  }

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new InvalidImageSizeError(`"size" dimensions must be positive integers (got ${JSON.stringify(size)}).`)
  }
  if (width % 8 !== 0 || height % 8 !== 0) {
    throw new InvalidImageSizeError(`"size" dimensions must be multiples of 8 (got ${width}x${height}).`)
  }

  return { width, height }
}

/**
 * Build the SDK diffusion call parameters from an OpenAI /v1/images/generations body.
 * Throws InvalidImagePromptError / InvalidImageSizeError / InvalidImageBatchCountError on bad input.
 *
 * `n` is forwarded as `batch_count` with no upper bound — the SDK / underlying
 * diffusion addon governs how large a batch is feasible. Only `n < 1` or
 * non-integer values are rejected here.
 */
export function extractImageGenerationParams (
  body: Record<string, unknown>,
  modelId: string
): SDKDiffusionParams {
  const prompt = body['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new InvalidImagePromptError('"prompt" is required and must be a non-empty string.')
  }

  const params: SDKDiffusionParams = { modelId, prompt }

  const parsedSize = parseImageSize(body['size'])
  if (parsedSize && 'width' in parsedSize) {
    params.width = parsedSize.width
    params.height = parsedSize.height
  }

  if (typeof body['seed'] === 'number' && Number.isInteger(body['seed'])) {
    params.seed = body['seed']
  }

  if (body['n'] !== undefined) {
    const n = body['n']
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new InvalidImageBatchCountError(`"n" must be a positive integer (got ${JSON.stringify(n)}).`)
    }
    params.batch_count = n
  }

  return params
}

const IMAGE_UNSUPPORTED_PARAMS = [
  'quality', 'style', 'background', 'moderation',
  'output_compression', 'partial_images', 'user'
] as const

/**
 * Log warnings for OpenAI image-generation params we accept but do not forward to the SDK.
 *
 * `output_format` is warned with extra context because the response body is always PNG
 * (the response object echoes `output_format: "png"` so clients can detect mismatch).
 * `stream` is handled by the route itself (single-event SSE), so it is not warned here.
 */
export function logImageUnsupportedParams (body: Record<string, unknown>, logger: Logger): void {
  for (const param of IMAGE_UNSUPPORTED_PARAMS) {
    if (body[param] !== undefined) {
      logger.warn(`Ignoring unsupported OpenAI image param: ${param}=${JSON.stringify(body[param])}`)
    }
  }

  const outputFormat = body['output_format']
  if (typeof outputFormat === 'string' && outputFormat !== 'png') {
    logger.warn(`output_format=${outputFormat} is not supported; returning PNG.`)
  }
}

/**
 * Encode raw image bytes as a `data:` URL for `response_format: "url"` requests.
 * Defaults to PNG since the SDK diffusion addon emits PNG.
 */
export function encodeImageDataUrl (buf: Uint8Array, mime: string = 'image/png'): string {
  const base64 = Buffer.from(buf).toString('base64')
  return `data:${mime};base64,${base64}`
}
