import crypto from 'node:crypto'
import type { Logger } from '../../../logger.js'
import type { SDKTool, SDKToolCall, SDKGenerationParams, SDKResponseFormat, SDKDiffusionParams } from '../../core/sdk.js'
import type { VectorStoreExpiresAfter, VectorStoreMeta } from './vector-stores-store.js'

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

export class UnsupportedImageOutputError extends Error {
  /** OpenAI-style error code returned to the client. */
  readonly code: string
  constructor (code: string, message: string) {
    super(message)
    this.name = 'UnsupportedImageOutputError'
    this.code = code
  }
}

export class InvalidImageStrengthError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidImageStrengthError'
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

const IMAGE_ADVISORY_PARAMS = [
  'quality', 'style', 'moderation', 'partial_images', 'user', 'input_fidelity'
] as const

/**
 * Log warnings for OpenAI image params we accept but do not forward to the SDK.
 * These are advisory hints (style/quality/etc.) — they do not change the bytes
 * the client receives, so silently ignoring them is acceptable.
 *
 * Output-shaping params (`output_format`, `output_compression`, `background`)
 * are NOT in this list — they would change the bytes, so they are rejected
 * loudly via {@link assertSupportedImageOutputParams} instead.
 *
 * `stream` is handled by each route directly, not warned here.
 */
export function logImageUnsupportedParams (body: Record<string, unknown>, logger: Logger): void {
  for (const param of IMAGE_ADVISORY_PARAMS) {
    if (body[param] !== undefined) {
      logger.warn(`Ignoring unsupported OpenAI image param: ${param}=${JSON.stringify(body[param])}`)
    }
  }
}

/**
 * Reject OpenAI image params we cannot honor without changing the response bytes.
 * This server only emits PNG with no alpha-control; any of these would silently
 * produce the wrong output, so we fail loudly with a 4xx instead.
 *
 * - `output_format` other than `"png"` (jpeg/webp not supported)
 * - `output_compression` (only meaningful with jpeg/webp)
 * - `background` (transparent/opaque/auto — no alpha channel control)
 */
export function assertSupportedImageOutputParams (body: Record<string, unknown>): void {
  const outputFormat = body['output_format']
  if (outputFormat !== undefined && outputFormat !== null && outputFormat !== 'png') {
    throw new UnsupportedImageOutputError(
      'unsupported_output_format',
      `output_format=${JSON.stringify(outputFormat)} is not supported; this server only emits PNG. Omit the field or pass "png".`
    )
  }
  const outputCompression = body['output_compression']
  if (outputCompression !== undefined && outputCompression !== null) {
    throw new UnsupportedImageOutputError(
      'unsupported_output_compression',
      'output_compression is not supported; this server only emits PNG (lossless), where output_compression has no meaning.'
    )
  }
  const background = body['background']
  if (background !== undefined && background !== null) {
    throw new UnsupportedImageOutputError(
      'unsupported_background',
      `background=${JSON.stringify(background)} is not supported; this server has no alpha-channel control.`
    )
  }
}

// ============== Vector Stores ==============

interface OpenAIVectorStoreObject {
  id: string
  object: 'vector_store'
  created_at: number
  name: string | null
  usage_bytes: number
  file_counts: {
    in_progress: number
    completed: number
    failed: number
    cancelled: number
    total: number
  }
  status: 'completed' | 'in_progress' | 'expired'
  expires_after: VectorStoreExpiresAfter | null
  expires_at: number | null
  last_active_at: number
  metadata: Record<string, string>
}

export interface VectorStoreRagInfo {
  exists: boolean
  open?: boolean
}

export function vectorStoreToOpenAI (
  meta: VectorStoreMeta,
  ragInfo?: VectorStoreRagInfo
): OpenAIVectorStoreObject {
  const exists = ragInfo?.exists === true
  const status: 'completed' | 'in_progress' = exists ? 'completed' : 'in_progress'
  return {
    id: meta.id,
    object: 'vector_store',
    created_at: Math.floor(meta.createdAt / 1000),
    name: meta.name,
    usage_bytes: 0,
    file_counts: {
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: 0
    },
    status,
    expires_after: meta.expiresAfter,
    expires_at: meta.expiresAt === null ? null : Math.floor(meta.expiresAt / 1000),
    last_active_at: Math.floor(meta.lastActiveAt / 1000),
    metadata: { ...meta.metadata }
  }
}

interface OpenAISearchResultItem {
  file_id: string
  filename: string
  score: number
  attributes: Record<string, string>
  content: Array<{ type: 'text'; text: string }>
}

interface OpenAISearchResultsPage {
  object: 'vector_store.search_results.page'
  search_query: string
  data: OpenAISearchResultItem[]
  has_more: false
  next_page: null
}

export interface RagSearchResultLike {
  id: string
  content: string
  score: number
}

/**
 * Optional lookup from RAG chunk id back to the original upload's identity.
 * When unknown (eg. pre-restart chunks, disk-only workspaces), the caller
 * falls back to the chunk id, matching today's behavior.
 */
export type ChunkAttributionLookup = (chunkId: string) => { fileId: string; fileName: string } | null

export function searchResultsToOpenAI (
  results: RagSearchResultLike[],
  query: string,
  lookup?: ChunkAttributionLookup
): OpenAISearchResultsPage {
  return {
    object: 'vector_store.search_results.page',
    search_query: query,
    data: results.map((r) => {
      const attribution = lookup ? lookup(r.id) : null
      return {
        file_id: attribution?.fileId ?? r.id,
        filename: attribution?.fileName ?? r.id,
        score: r.score,
        attributes: {},
        content: [{ type: 'text', text: r.content }]
      }
    }),
    has_more: false,
    next_page: null
  }
}

export class InvalidExpiresAfterError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidExpiresAfterError'
  }
}

export function parseExpiresAfter (raw: unknown): VectorStoreExpiresAfter | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidExpiresAfterError('"expires_after" must be an object.')
  }
  const obj = raw as Record<string, unknown>
  const anchor = obj['anchor']
  if (anchor !== 'last_active_at') {
    throw new InvalidExpiresAfterError('"expires_after.anchor" must be "last_active_at".')
  }
  const days = obj['days']
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
    throw new InvalidExpiresAfterError('"expires_after.days" must be a positive integer.')
  }
  return { anchor: 'last_active_at', days }
}

export class InvalidMetadataError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidMetadataError'
  }
}

const MAX_METADATA_KEYS = 16
const MAX_METADATA_KEY_LENGTH = 64
const MAX_METADATA_VALUE_LENGTH = 512

export function parseMetadata (raw: unknown): Record<string, string> | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidMetadataError('"metadata" must be an object of string values.')
  }
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length > MAX_METADATA_KEYS) {
    throw new InvalidMetadataError(`"metadata" has more than ${MAX_METADATA_KEYS} keys.`)
  }
  const out: Record<string, string> = {}
  for (const key of keys) {
    if (key.length > MAX_METADATA_KEY_LENGTH) {
      throw new InvalidMetadataError(`"metadata" key "${key}" exceeds ${MAX_METADATA_KEY_LENGTH} characters.`)
    }
    const value = obj[key]
    if (typeof value !== 'string') {
      throw new InvalidMetadataError(`"metadata.${key}" must be a string.`)
    }
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new InvalidMetadataError(`"metadata.${key}" exceeds ${MAX_METADATA_VALUE_LENGTH} characters.`)
    }
    out[key] = value
  }
  return out
}

// ── OpenAI Responses API (POST /v1/responses) ─────────────────────────────

export class UnsupportedToolTypeError extends Error {
  readonly toolType: string

  constructor (toolType: string) {
    super(`Unsupported tool type "${toolType}" for Responses API.`)
    this.name = 'UnsupportedToolTypeError'
    this.toolType = toolType
  }
}

export class InvalidResponsesConversationError extends Error {
  constructor () {
    super('"conversation" is not supported by this server (no Conversation persistence).')
    this.name = 'InvalidResponsesConversationError'
  }
}

export class InvalidResponsesBackgroundError extends Error {
  constructor () {
    super('"background": true is not supported; only synchronous responses are available.')
    this.name = 'InvalidResponsesBackgroundError'
  }
}

const RESPONSES_UNSUPPORTED_PARAMS = [
  'service_tier',
  'safety_identifier',
  'prompt_cache_key',
  'truncation',
  'top_logprobs',
  'include',
  'reasoning',
  'modalities',
  'audio',
  'tool_choice'
] as const

export function logResponsesUnsupportedParams (body: Record<string, unknown>, logger: Logger): void {
  for (const param of RESPONSES_UNSUPPORTED_PARAMS) {
    if (body[param] !== undefined) {
      logger.info(`Ignoring unsupported Responses param: ${param}=${JSON.stringify(body[param])}`)
    }
  }
  const text = body['text']
  if (text !== null && text !== undefined && typeof text === 'object' && !Array.isArray(text)) {
    const verbosity = (text as Record<string, unknown>)['verbosity']
    if (verbosity !== undefined) {
      logger.info(`Ignoring unsupported Responses param: text.verbosity=${JSON.stringify(verbosity)}`)
    }
  }
  // The Responses spec defines `max_output_tokens`, not `max_tokens`. Accept both for forgiveness
  // (the route maps `max_tokens` as a fallback) but warn so consumers migrate.
  if (body['max_tokens'] !== undefined && body['max_output_tokens'] === undefined) {
    logger.warn('"max_tokens" on /v1/responses is non-spec; use "max_output_tokens".')
  }
}

export function validateResponsesStatefulOptions (body: Record<string, unknown>): {
  previousResponseId: string | undefined
  storeEnabled: boolean
} {
  if (body['conversation'] !== undefined && body['conversation'] !== null) {
    throw new InvalidResponsesConversationError()
  }
  if (body['background'] === true) {
    throw new InvalidResponsesBackgroundError()
  }
  const prev = body['previous_response_id']
  const previousResponseId = typeof prev === 'string' && prev.length > 0 ? prev : undefined
  const storeEnabled = body['store'] !== false
  return { previousResponseId, storeEnabled }
}

export function extractResponsesGenerationParams (body: Record<string, unknown>): SDKGenerationParams | undefined {
  const params: SDKGenerationParams = {}

  if (typeof body['temperature'] === 'number') params.temp = body['temperature']
  if (typeof body['top_p'] === 'number') params.top_p = body['top_p']
  if (typeof body['seed'] === 'number') params.seed = body['seed']
  if (typeof body['frequency_penalty'] === 'number') params.frequency_penalty = body['frequency_penalty']
  if (typeof body['presence_penalty'] === 'number') params.presence_penalty = body['presence_penalty']

  if (typeof body['max_tokens'] === 'number') params.predict = body['max_tokens']
  if (typeof body['max_output_tokens'] === 'number') params.predict = body['max_output_tokens']

  if (typeof body['reasoning_budget'] === 'boolean') params.reasoning_budget = body['reasoning_budget']

  return Object.keys(params).length > 0 ? params : undefined
}

export function extractResponsesResponseFormat (body: Record<string, unknown>): SDKResponseFormat | undefined {
  const top = body['response_format']
  if (top !== undefined && top !== null) {
    return extractResponseFormat({ response_format: top } as Record<string, unknown>)
  }
  const text = body['text']
  if (text !== null && text !== undefined && typeof text === 'object' && !Array.isArray(text)) {
    const fmt = (text as Record<string, unknown>)['format']
    if (fmt !== undefined && fmt !== null) {
      return extractResponseFormat({ response_format: fmt } as Record<string, unknown>)
    }
  }
  return undefined
}

interface ResponsesFunctionTool {
  type: string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
}

export function openaiResponsesToolsToSdk (tools: ResponsesFunctionTool[] | undefined): SDKTool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools
    .map((t): SDKTool | null => {
      if (t.type === 'function') {
        const name = typeof t.name === 'string' ? t.name : ''
        if (!name) return null
        return {
          type: 'function',
          name,
          description: typeof t.description === 'string' ? t.description : '',
          parameters: normalizeToolParameters(t.parameters ?? { type: 'object', properties: {} })
        }
      }
      if (t.type === 'web_search' || t.type === 'file_search' || t.type === 'code_interpreter') {
        throw new UnsupportedToolTypeError(t.type)
      }
      throw new UnsupportedToolTypeError(t.type)
    })
    .filter((t): t is SDKTool => t !== null)
}

function inputTextPart (text: string): Record<string, unknown> {
  return { type: 'input_text', text }
}

function normalizeInputItemId (item: Record<string, unknown>, index: number): Record<string, unknown> {
  if (typeof item['id'] === 'string' && item['id'].length > 0) return item
  return { ...item, id: `item_${index}_${crypto.randomUUID()}` }
}

function responsesFunctionCallItemToAssistantContent (item: Record<string, unknown>): string {
  const name = typeof item['name'] === 'string' ? item['name'] : ''
  const rawArgs = item['arguments']
  const argsStr = typeof rawArgs === 'string'
    ? rawArgs
    : (rawArgs !== null && rawArgs !== undefined ? JSON.stringify(rawArgs) : '{}')
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsStr) as Record<string, unknown>
  } catch {
    args = {}
  }
  const callObj = { name, arguments: args }
  return `<tool_call>\n${JSON.stringify(callObj)}\n</tool_call>`
}

export function normalizeResponsesInputItemsForStorage (input: unknown): unknown[] {
  if (typeof input === 'string') {
    return [{
      type: 'message',
      id: `item_0_${crypto.randomUUID()}`,
      role: 'user',
      content: [inputTextPart(input)]
    }]
  }
  if (!Array.isArray(input)) {
    return [{
      type: 'message',
      id: `item_0_${crypto.randomUUID()}`,
      role: 'user',
      content: [inputTextPart('')]
    }]
  }
  return input.map((raw, i) => {
    if (typeof raw === 'string') {
      return {
        type: 'message',
        id: `item_${i}_${crypto.randomUUID()}`,
        role: 'user',
        content: [inputTextPart(raw)]
      }
    }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return normalizeInputItemId(raw as Record<string, unknown>, i)
    }
    return { type: 'message', id: `item_${i}_${crypto.randomUUID()}`, role: 'user', content: [inputTextPart('')] }
  })
}

export function openaiResponsesInputToHistory (
  input: unknown,
  instructions: string | undefined
): Array<{ role: string; content: string }> {
  const history: Array<{ role: string; content: string }> = []

  if (typeof instructions === 'string' && instructions.length > 0) {
    history.push({ role: 'system', content: instructions })
  }

  if (typeof input === 'string') {
    history.push({ role: 'user', content: input })
    return history
  }

  if (!Array.isArray(input)) {
    history.push({ role: 'user', content: '' })
    return history
  }

  for (const raw of input) {
    if (typeof raw === 'string') {
      history.push({ role: 'user', content: raw })
      continue
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const t = item['type']
    if (t === 'message') {
      const role = typeof item['role'] === 'string' ? item['role'] : 'user'
      const content = item['content']
      history.push({ role, content: flattenResponsesContent(content) })
      continue
    }
    if (t === 'input_text') {
      const text = typeof item['text'] === 'string' ? item['text'] : ''
      history.push({ role: 'user', content: text })
      continue
    }
    if (t === 'function_call_output') {
      const out = item['output']
      const text = typeof out === 'string'
        ? out
        : (out !== null && out !== undefined ? JSON.stringify(out) : '')
      history.push({ role: 'tool', content: text })
      continue
    }
    if (t === 'function_call') {
      history.push({ role: 'assistant', content: responsesFunctionCallItemToAssistantContent(item) })
    }
  }

  return history
}

function flattenResponsesContent (content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const p of content) {
    if (typeof p === 'string') {
      parts.push(p)
      continue
    }
    if (p === null || typeof p !== 'object' || Array.isArray(p)) continue
    const o = p as Record<string, unknown>
    if (o['type'] === 'input_text' && typeof o['text'] === 'string') parts.push(o['text'])
  }
  return parts.join('\n')
}

export interface StoredResponseLike {
  inputItems: unknown[]
  responseObject: Record<string, unknown>
}

/**
 * Default cap for `historyPrefixFromStoredResponse` chain walks.
 * Prevents pathological recursion if a malformed `previous_response_id` cycle is ever stored,
 * and bounds work for very long chains. 32 mirrors typical chat-app history depth.
 */
export const RESPONSES_HISTORY_MAX_DEPTH = 32

/**
 * Build the chat history that should precede the current request when chaining
 * via `previous_response_id`.
 *
 * If a `resolve` callback is provided, this walks the chain via
 * `responseObject.previous_response_id` and prepends earlier turns first
 * (oldest → newest). Without `resolve`, only the immediate stored turn is used
 * — kept that way so the legacy single-step callers and unit tests still work.
 *
 * Each `StoredResponse.inputItems` only carries that turn's NEW input
 * (`normalizeResponsesInputItemsForStorage(body['input'])`), so without the
 * walk a chain of depth ≥ 3 would silently lose grandparent history.
 */
export function historyPrefixFromStoredResponse (
  stored: StoredResponseLike,
  resolve?: (id: string) => StoredResponseLike | undefined,
  maxDepth: number = RESPONSES_HISTORY_MAX_DEPTH
): Array<{ role: string; content: string }> {
  const prefix: Array<{ role: string; content: string }> = []

  if (resolve && maxDepth > 0) {
    const prevId = stored.responseObject['previous_response_id']
    if (typeof prevId === 'string' && prevId.length > 0) {
      const prev = resolve(prevId)
      if (prev) {
        prefix.push(...historyPrefixFromStoredResponse(prev, resolve, maxDepth - 1))
      }
    }
  }

  for (const raw of stored.inputItems) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (item['type'] === 'message') {
      const role = typeof item['role'] === 'string' ? item['role'] : 'user'
      prefix.push({ role, content: flattenResponsesContent(item['content']) })
    } else if (item['type'] === 'input_text') {
      const text = typeof item['text'] === 'string' ? item['text'] : ''
      prefix.push({ role: 'user', content: text })
    } else if (item['type'] === 'function_call_output') {
      const out = item['output']
      const text = typeof out === 'string'
        ? out
        : (out !== null && out !== undefined ? JSON.stringify(out) : '')
      prefix.push({ role: 'tool', content: text })
    } else if (item['type'] === 'function_call') {
      prefix.push({ role: 'assistant', content: responsesFunctionCallItemToAssistantContent(item) })
    }
  }

  const output = stored.responseObject['output']
  const outputText = stored.responseObject['output_text']

  if (Array.isArray(output) && output.length > 0) {
    for (const out of output) {
      if (out === null || typeof out !== 'object' || Array.isArray(out)) continue
      const o = out as Record<string, unknown>
      if (o['type'] === 'message' && o['role'] === 'assistant') {
        const text = extractOutputTextFromMessage(o)
        prefix.push({ role: 'assistant', content: text })
      } else if (o['type'] === 'function_call') {
        const name = typeof o['name'] === 'string' ? o['name'] : ''
        const args = typeof o['arguments'] === 'string' ? o['arguments'] : JSON.stringify(o['arguments'] ?? {})
        prefix.push({
          role: 'assistant',
          content: `<tool_call>\n${JSON.stringify({ name, arguments: safeJsonParse(args) })}\n</tool_call>`
        })
      }
    }
    return prefix
  }

  if (typeof outputText === 'string' && outputText.length > 0) {
    prefix.push({ role: 'assistant', content: outputText })
  }

  return prefix
}

function safeJsonParse (s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}

function extractOutputTextFromMessage (msg: Record<string, unknown>): string {
  const content = msg['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const p of content) {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) continue
    const o = p as Record<string, unknown>
    if (o['type'] === 'output_text' && typeof o['text'] === 'string') parts.push(o['text'])
  }
  return parts.join('')
}

// ─── /v1/images/edits (multipart) helpers ─────────────────────────────────

/**
 * Turn multipart text fields into a JSON-like object so we can reuse
 * `extractImageGenerationParams` for shared validation and diffusion mapping.
 */
export function coerceMultipartFields (fields: Map<string, string>): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const [k, v] of fields.entries()) {
    const trimmed = v.trim()
    if (k === 'n' || k === 'seed') {
      if (/^-?\d+$/.test(trimmed)) {
        obj[k] = parseInt(trimmed, 10)
      } else {
        obj[k] = v
      }
      continue
    }
    if (k === 'stream') {
      if (trimmed === 'true' || trimmed === 'false') {
        obj[k] = trimmed === 'true'
      } else {
        obj[k] = v
      }
      continue
    }
    if (k === 'strength') {
      const f = parseFloat(trimmed)
      if (!Number.isNaN(f)) {
        obj[k] = f
      } else {
        obj[k] = v
      }
      continue
    }
    obj[k] = v
  }
  return obj
}

export function extractImageEditParams (
  body: Record<string, unknown>,
  imageBuffer: Uint8Array,
  modelId: string
): SDKDiffusionParams {
  const params = extractImageGenerationParams(body, modelId)
  params.init_image = imageBuffer

  const strengthRaw = body['strength']
  if (strengthRaw !== undefined && strengthRaw !== null) {
    if (typeof strengthRaw !== 'number' || Number.isNaN(strengthRaw)) {
      throw new InvalidImageStrengthError(
        `"strength" must be a number in [0, 1] (got ${JSON.stringify(strengthRaw)}).`
      )
    }
    if (strengthRaw < 0 || strengthRaw > 1) {
      throw new InvalidImageStrengthError(
        `"strength" must be in [0, 1] (got ${strengthRaw}).`
      )
    }
    params.strength = strengthRaw
  }

  return params
}

export function logImageEditExtraWarnings (
  _body: Record<string, unknown>,
  opts: { extraImageCount: number },
  logger: Logger
): void {
  if (opts.extraImageCount > 0) {
    logger.warn(`image[] received ${opts.extraImageCount + 1} files; using only the first`)
  }
}
