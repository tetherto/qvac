import crypto from 'node:crypto'
import { z } from 'zod'
import type { Tool } from '@qvac/sdk'
import {
  responseFormat,
  toolDef,
  normalizeToolParameters,
  extractResponseFormat,
  extractGenerationParams,
  type GenerationParams,
  type ResponseFormat
} from './common.js'

export const responsesBody = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.unknown())]),
  instructions: z.string().optional(),
  stream: z.boolean().optional(),
  store: z.boolean().optional(),
  previous_response_id: z.string().optional(),
  conversation: z.unknown().optional(),
  background: z.boolean().optional(),
  tools: z.array(toolDef).optional(),
  text: z.unknown().optional(),
  response_format: responseFormat.optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_output_tokens: z.number().int().optional(),
  max_tokens: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  parallel_tool_calls: z.boolean().optional()
}).passthrough()

export const responsesIdParams = z.object({ id: z.string().min(1) })

export const responsesListInputItemsQuery = z.object({
  limit: z.coerce.number().int().optional(),
  after: z.string().optional()
})

export const RESPONSES_UNSUPPORTED_PARAMS = [
  'logit_bias',
  'user',
  'seed',
  'logprobs',
  'top_logprobs',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'truncation',
  'service_tier',
  'reasoning'
] as const

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

export function extractResponsesResponseFormat (body: Record<string, unknown>): ResponseFormat | undefined {
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

export function openaiResponsesToolsToSdk (tools: ResponsesFunctionTool[] | undefined): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools
    .map((t): Tool | null => {
      if (t.type === 'function') {
        const name = typeof t.name === 'string' ? t.name : ''
        if (!name) return null
        return {
          type: 'function',
          name,
          description: typeof t.description === 'string' ? t.description : '',
          parameters: normalizeToolParameters(t.parameters ?? { type: 'object', properties: {} }) as Tool['parameters']
        }
      }
      throw new UnsupportedToolTypeError(t.type)
    })
    .filter((t): t is Tool => t !== null)
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

export const RESPONSES_HISTORY_MAX_DEPTH = 32

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

export type ResponsesBody = z.infer<typeof responsesBody>

export interface SdkResponsesArgs {
  history: Array<{ role: string; content: string }>
  tools: Tool[] | undefined
  generationParams: GenerationParams | undefined
  responseFormat: ResponseFormat | undefined
  storeEnabled: boolean
  previousResponseId: string | undefined
  inputItems: unknown[]
  metadata: Record<string, unknown> | undefined
  temperature: number | undefined
  topP: number | undefined
  maxOutputTokens: number | undefined
  parallelToolCalls: boolean
  stream: boolean
}

export function toSdkResponsesArgs (body: ResponsesBody): SdkResponsesArgs {
  const { previousResponseId, storeEnabled } = validateResponsesStatefulOptions(body as Record<string, unknown>)
  const tools = openaiResponsesToolsToSdk(body.tools as Parameters<typeof openaiResponsesToolsToSdk>[0])
  const responseFmt = extractResponsesResponseFormat(body as Record<string, unknown>)
  const instructions = typeof body.instructions === 'string' ? body.instructions : undefined
  const inputItems = normalizeResponsesInputItemsForStorage(body.input)
  const history = openaiResponsesInputToHistory(body.input, instructions)

  const meta = body.metadata
  const metadata = meta !== undefined && meta !== null && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : undefined

  const parallel = body.parallel_tool_calls
  const parallelToolCalls = typeof parallel === 'boolean' ? parallel : true

  return {
    history,
    tools,
    generationParams: extractGenerationParams(body as Record<string, unknown>, 'max_output_tokens'),
    responseFormat: responseFmt,
    storeEnabled,
    previousResponseId,
    inputItems,
    metadata,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    maxOutputTokens: typeof body.max_output_tokens === 'number'
      ? body.max_output_tokens
      : (typeof body.max_tokens === 'number' ? body.max_tokens : undefined),
    parallelToolCalls,
    stream: Boolean(body.stream)
  }
}
