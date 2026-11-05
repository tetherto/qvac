import crypto from 'node:crypto'
import { z } from 'zod'
import type { Tool } from '@qvac/sdk'
import {
  responseFormat,
  toolDef,
  toolChoice,
  normalizeToolParameters,
  extractResponseFormat,
  extractGenerationParams,
  extractToolChoice,
  withToolChoice,
  parseToolCallArguments,
  hoistInstructions,
  nameToolResults,
  withParallelToolCalls,
  type GenerationParams,
  type ResponseFormat,
  type ToolTurnFields
} from '@/lib/api/extensions/openai/schemas/common'

export const responsesBody = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.unknown())]),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    store: z.boolean().optional(),
    previous_response_id: z.string().optional(),
    conversation: z.unknown().optional(),
    background: z.boolean().optional(),
    tools: z.array(toolDef).optional(),
    tool_choice: toolChoice.optional(),
    text: z.unknown().optional(),
    response_format: responseFormat.optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_output_tokens: z.number().int().optional(),
    max_tokens: z.number().int().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    parallel_tool_calls: z.boolean().optional()
  })
  .passthrough()

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
  'reasoning',
  'remove_thinking_from_context'
] as const

export class InvalidResponsesConversationError extends Error {
  constructor() {
    super('"conversation" is not supported by this server (no Conversation persistence).')
    this.name = 'InvalidResponsesConversationError'
  }
}

export class InvalidResponsesBackgroundError extends Error {
  constructor() {
    super('"background": true is not supported; only synchronous responses are available.')
    this.name = 'InvalidResponsesBackgroundError'
  }
}

export function validateResponsesStatefulOptions(body: Record<string, unknown>): {
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

export function extractResponsesResponseFormat(
  body: Record<string, unknown>
): ResponseFormat | undefined {
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

interface ResponsesTool {
  type: string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  defer_loading?: boolean
  tools?: ResponsesTool[]
}

/** The tool a client declared inside a `namespace`, keyed by the name the model sees. */
export type ToolNamespaces = ReadonlyMap<string, { namespace: string; name: string }>

export interface ResponsesTools {
  tools: Tool[] | undefined
  namespaces: ToolNamespaces
  /** Built-in tool types (`web_search`, …) this server cannot run; left out of the request. */
  skippedTypes: string[]
}

export class InvalidResponsesToolsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidResponsesToolsError'
  }
}

// The model sees one flat list, and names repeat across namespaces (Codex
// declares `js` in two MCP servers), so a namespaced tool gets a qualified name.
// It keeps the inner name as is, so distinct tools never share one.
export function qualifiedToolName(namespace: string, name: string): string {
  return `${namespace}__${name}`
}

function functionTool(t: ResponsesTool, name: string, deferLoading = t.defer_loading): Tool {
  return {
    type: 'function',
    name,
    description: typeof t.description === 'string' ? t.description : '',
    ...(typeof deferLoading === 'boolean' && { deferLoading }),
    parameters: normalizeToolParameters(
      t.parameters ?? { type: 'object', properties: {} }
    ) as Tool['parameters']
  }
}

export function openaiResponsesToolsToSdk(tools: ResponsesTool[] | undefined): ResponsesTools {
  const out: Tool[] = []
  const namespaces = new Map<string, { namespace: string; name: string }>()
  const skippedTypes = new Set<string>()
  const topLevel = new Set<string>()

  for (const t of tools ?? []) {
    if (t.type === 'function') {
      if (typeof t.name === 'string' && t.name) {
        out.push(functionTool(t, t.name))
        topLevel.add(t.name)
      }
    } else if (t.type === 'namespace') {
      if (typeof t.name !== 'string' || !t.name || !Array.isArray(t.tools)) {
        throw new InvalidResponsesToolsError(
          'A "namespace" tool needs a non-empty "name" and a "tools" array.'
        )
      }
      for (const inner of t.tools as unknown[]) {
        if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
          throw new InvalidResponsesToolsError(
            `Namespace "${t.name}" lists a tool that is not an object.`
          )
        }
        const fn = inner as ResponsesTool
        if (fn.type !== 'function' || typeof fn.name !== 'string' || !fn.name) continue
        const qualified = qualifiedToolName(t.name, fn.name)
        const existing = namespaces.get(qualified)
        if (existing) {
          if (existing.namespace === t.name && existing.name === fn.name) continue
          throw new InvalidResponsesToolsError(
            `Tool "${fn.name}" in namespace "${t.name}" and tool "${existing.name}" in namespace ` +
              `"${existing.namespace}" both become "${qualified}".`
          )
        }
        namespaces.set(qualified, { namespace: t.name, name: fn.name })
        out.push(functionTool(fn, qualified, fn.defer_loading ?? t.defer_loading))
      }
    } else {
      skippedTypes.add(t.type)
    }
  }

  // A top-level tool spelled like a qualified name would make its calls ambiguous.
  for (const qualified of namespaces.keys()) {
    if (topLevel.has(qualified)) {
      throw new InvalidResponsesToolsError(
        `Tool "${qualified}" is declared both at the top level and inside namespace ` +
          `"${namespaces.get(qualified)!.namespace}".`
      )
    }
  }

  return {
    tools: out.length > 0 ? out : undefined,
    namespaces,
    skippedTypes: [...skippedTypes]
  }
}

// The Responses API accepts `{ role, content }` without `type: "message"`.
function isMessageItem(item: Record<string, unknown>): boolean {
  return (
    item['type'] === 'message' || (item['type'] === undefined && typeof item['role'] === 'string')
  )
}

// A namespaced tool is named `<namespace>__<name>` for the model, so a forced
// choice that names it by namespace has to use that name too.
function qualifyToolChoice(body: Record<string, unknown>): Record<string, unknown> {
  const choice = body['tool_choice']
  if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) return body
  const { namespace, name, ...rest } = choice as Record<string, unknown>
  if (typeof namespace !== 'string' || !namespace || typeof name !== 'string') return body
  return { ...body, tool_choice: { ...rest, name: qualifiedToolName(namespace, name) } }
}

function inputTextPart(text: string): Record<string, unknown> {
  return { type: 'input_text', text }
}

function normalizeInputItemId(
  item: Record<string, unknown>,
  index: number
): Record<string, unknown> {
  if (typeof item['id'] === 'string' && item['id'].length > 0) return item
  return { ...item, id: `item_${index}_${crypto.randomUUID()}` }
}

export interface ResponsesHistoryItem extends ToolTurnFields {
  role: string
  content: string
}

// A `function_call` item joins the assistant turn right before it (its text, or
// the calls made alongside it); otherwise it starts a new one.
function pushFunctionCall(history: ResponsesHistoryItem[], item: Record<string, unknown>): void {
  const name = typeof item['name'] === 'string' ? item['name'] : ''
  const namespace = item['namespace']
  const call = {
    ...(typeof item['call_id'] === 'string' && { id: item['call_id'] }),
    name: typeof namespace === 'string' && namespace ? qualifiedToolName(namespace, name) : name,
    arguments: parseToolCallArguments(item['arguments'] ?? {})
  }
  const last = history[history.length - 1]
  if (last !== undefined && last.role === 'assistant') {
    last.toolCalls = [...(last.toolCalls ?? []), call]
    return
  }
  history.push({ role: 'assistant', content: '', toolCalls: [call] })
}

function pushFunctionCallOutput(
  history: ResponsesHistoryItem[],
  item: Record<string, unknown>
): void {
  const out = item['output']
  const content =
    typeof out === 'string' ? out : out !== null && out !== undefined ? JSON.stringify(out) : ''
  history.push({
    role: 'tool',
    content,
    ...(typeof item['call_id'] === 'string' && { toolCallId: item['call_id'] })
  })
}

export function normalizeResponsesInputItemsForStorage(input: unknown): unknown[] {
  if (typeof input === 'string') {
    return [
      {
        type: 'message',
        id: `item_0_${crypto.randomUUID()}`,
        role: 'user',
        content: [inputTextPart(input)]
      }
    ]
  }
  if (!Array.isArray(input)) {
    return [
      {
        type: 'message',
        id: `item_0_${crypto.randomUUID()}`,
        role: 'user',
        content: [inputTextPart('')]
      }
    ]
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
    return {
      type: 'message',
      id: `item_${i}_${crypto.randomUUID()}`,
      role: 'user',
      content: [inputTextPart('')]
    }
  })
}

export function openaiResponsesInputToHistory(
  input: unknown,
  instructions: string | undefined
): ResponsesHistoryItem[] {
  const history: ResponsesHistoryItem[] = []

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
    if (isMessageItem(item)) {
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
      pushFunctionCallOutput(history, item)
      continue
    }
    if (t === 'function_call') {
      pushFunctionCall(history, item)
    }
  }

  return nameToolResults(hoistInstructions(history))
}

function flattenResponsesContent(content: unknown): string {
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

export function historyPrefixFromStoredResponse(
  stored: StoredResponseLike,
  resolve?: (id: string) => StoredResponseLike | undefined,
  maxDepth: number = RESPONSES_HISTORY_MAX_DEPTH
): ResponsesHistoryItem[] {
  const prefix: ResponsesHistoryItem[] = []

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
    if (isMessageItem(item)) {
      const role = typeof item['role'] === 'string' ? item['role'] : 'user'
      prefix.push({ role, content: flattenResponsesContent(item['content']) })
    } else if (item['type'] === 'input_text') {
      const text = typeof item['text'] === 'string' ? item['text'] : ''
      prefix.push({ role: 'user', content: text })
    } else if (item['type'] === 'function_call_output') {
      pushFunctionCallOutput(prefix, item)
    } else if (item['type'] === 'function_call') {
      pushFunctionCall(prefix, item)
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
        pushFunctionCall(prefix, o)
      }
    }
    return nameToolResults(prefix)
  }

  if (typeof outputText === 'string' && outputText.length > 0) {
    prefix.push({ role: 'assistant', content: outputText })
  }

  return nameToolResults(prefix)
}

function extractOutputTextFromMessage(msg: Record<string, unknown>): string {
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
  history: ResponsesHistoryItem[]
  tools: Tool[] | undefined
  toolNamespaces: ToolNamespaces
  skippedToolTypes: string[]
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

export function toSdkResponsesArgs(body: ResponsesBody): SdkResponsesArgs {
  const { previousResponseId, storeEnabled } = validateResponsesStatefulOptions(
    body as Record<string, unknown>
  )
  const {
    tools,
    namespaces: toolNamespaces,
    skippedTypes: skippedToolTypes
  } = openaiResponsesToolsToSdk(body.tools as Parameters<typeof openaiResponsesToolsToSdk>[0])
  const responseFmt = extractResponsesResponseFormat(body as Record<string, unknown>)
  const instructions = typeof body.instructions === 'string' ? body.instructions : undefined
  const inputItems = normalizeResponsesInputItemsForStorage(body.input)
  const history = openaiResponsesInputToHistory(body.input, instructions)

  const meta = body.metadata
  const metadata =
    meta !== undefined && meta !== null && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : undefined

  const parallel =
    typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : undefined

  return {
    history,
    tools,
    toolNamespaces,
    skippedToolTypes,
    generationParams: withParallelToolCalls(
      withToolChoice(
        extractGenerationParams(body as Record<string, unknown>, 'max_output_tokens'),
        extractToolChoice(qualifyToolChoice(body as Record<string, unknown>), tools)
      ),
      parallel
    ),
    responseFormat: responseFmt,
    storeEnabled,
    previousResponseId,
    inputItems,
    metadata,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    maxOutputTokens:
      typeof body.max_output_tokens === 'number'
        ? body.max_output_tokens
        : typeof body.max_tokens === 'number'
          ? body.max_tokens
          : undefined,
    parallelToolCalls: parallel ?? true,
    stream: Boolean(body.stream)
  }
}
