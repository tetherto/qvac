// OpenAI-compat transforms that bridge two gaps between QVAC serve and the
// Vercel AI SDK (which OpenCode speaks). Both are stopgaps; the proper fixes
// belong in serve and these transforms are gated behind the `shim` option so
// they can be dropped once serve closes the gaps.
//
//   1. `flattenMessages` — serve's /v1/chat/completions accepts `content` only
//      as a string, but the AI SDK always sends the OpenAI array-of-parts form
//      (`[{ type: 'text', text }]`). Without flattening every request 400s with
//      `messages: Invalid input` before inference. Tracked by serve PR #2459.
//   2. `makeThinkSplitter` / `transformSSEChunk` — with reasoning on, the model
//      emits `<think>…</think>` inline and serve forwards it as `delta.content`,
//      so OpenCode renders raw tags. Re-routing the inner text to
//      `delta.reasoning_content` makes OpenCode show a collapsed "Thought" block.

export interface ChatMessage {
  content?: unknown
  [key: string]: unknown
}

export interface ChatCompletionBody {
  messages?: ChatMessage[]
  [key: string]: unknown
}

interface TextPart {
  type?: string
  text?: string
}

// Collapse an OpenAI array-of-parts `content` into the plain string serve
// accepts, concatenating the text parts. Strings and nullish values pass
// through unchanged; non-text parts (e.g. image_url) contribute nothing.
export function flattenContent (content: unknown): unknown {
  if (typeof content === 'string' || content == null) return content
  if (!Array.isArray(content)) return content
  return content
    .map((part: unknown): string => {
      if (typeof part === 'string') return part
      const p = part as TextPart
      if (p?.type === 'text' && typeof p.text === 'string') return p.text
      return ''
    })
    .join('')
}

// Flatten the `content` of every message in a chat-completion body in place.
export function flattenMessages (body: ChatCompletionBody): ChatCompletionBody {
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg != null && 'content' in msg) msg.content = flattenContent(msg.content)
    }
  }
  return body
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

// Longest suffix of `text` that is a strict prefix of `tag`, so a tag split
// across stream chunks is carried over rather than emitted half-formed.
function maxTagSuffix (text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1)
  for (let k = max; k > 0; k--) {
    if (text.slice(text.length - k) === tag.slice(0, k)) return k
  }
  return 0
}

export interface SplitResult {
  readonly content: string
  readonly reasoning: string
}

export interface ThinkSplitter {
  (input: string): SplitResult
  flush: () => SplitResult
}

// Stateful splitter: feed it successive content deltas and it returns the
// portion that is answer `content` vs. reasoning (text inside `<think>` tags,
// with the tags stripped). Handles tags spanning chunk boundaries via a carry.
export function makeThinkSplitter (): ThinkSplitter {
  let inThink = false
  let carry = ''
  const split = function split (input: string): SplitResult {
    let text = carry + input
    carry = ''
    let content = ''
    let reasoning = ''
    while (text.length > 0) {
      if (inThink) {
        const idx = text.indexOf(THINK_CLOSE)
        if (idx !== -1) {
          reasoning += text.slice(0, idx)
          text = text.slice(idx + THINK_CLOSE.length)
          inThink = false
        } else {
          const k = maxTagSuffix(text, THINK_CLOSE)
          reasoning += text.slice(0, text.length - k)
          carry = text.slice(text.length - k)
          break
        }
      } else {
        const idx = text.indexOf(THINK_OPEN)
        if (idx !== -1) {
          content += text.slice(0, idx)
          text = text.slice(idx + THINK_OPEN.length)
          inThink = true
        } else {
          const k = maxTagSuffix(text, THINK_OPEN)
          content += text.slice(0, text.length - k)
          carry = text.slice(text.length - k)
          break
        }
      }
    }
    return { content, reasoning }
  }
  split.flush = (): SplitResult => {
    const text = carry
    carry = ''
    return inThink ? { content: '', reasoning: text } : { content: text, reasoning: '' }
  }
  return split
}

const TOOL_CALL_OPEN = '<tool_call>'
const TOOL_CALL_CLOSE = '</tool_call>'

export interface OpenAIToolCallDelta {
  readonly index: number
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}

export type ToolCallSegment =
  | { readonly type: 'content', readonly text: string }
  | { readonly type: 'tool_call', readonly toolCall: OpenAIToolCallDelta }

export interface ToolCallSplitter {
  (input: string): ToolCallSegment[]
  flush: () => ToolCallSegment[]
}

function toolCallId (name: string, args: Record<string, unknown>, index: number): string {
  const text = `${name}:${JSON.stringify(args)}`
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return `call_${Math.abs(hash).toString(36)}_${index}`
}

function repairFunctionEqualsJson (inner: string): string | undefined {
  const match = /^\{\s*"function=([^"]+)"\s*,\s*"arguments"\s*:\s*([\s\S]+)\}\s*$/.exec(inner)
  if (match === null) return undefined
  return `{"name":${JSON.stringify(match[1])},"arguments":${match[2]}}`
}

function parseToolCallFrame (raw: string, index: number): OpenAIToolCallDelta | undefined {
  let inner = raw.trim()
  if (inner.startsWith(TOOL_CALL_OPEN)) inner = inner.slice(TOOL_CALL_OPEN.length)
  if (inner.endsWith(TOOL_CALL_CLOSE)) inner = inner.slice(0, inner.length - TOOL_CALL_CLOSE.length)
  inner = inner.trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(inner)
  } catch {
    const repaired = repairFunctionEqualsJson(inner)
    if (repaired === undefined) return undefined
    try {
      parsed = JSON.parse(repaired)
    } catch {
      return undefined
    }
  }

  if (parsed === null || typeof parsed !== 'object') return undefined
  const obj = parsed as { name?: unknown, function?: unknown, arguments?: unknown }
  const name = typeof obj.name === 'string'
    ? obj.name
    : typeof obj.function === 'string'
      ? obj.function
      : undefined
  if (name === undefined || obj.arguments === null || typeof obj.arguments !== 'object' || Array.isArray(obj.arguments)) {
    return undefined
  }

  const args = obj.arguments as Record<string, unknown>
  return {
    index,
    id: toolCallId(name, args, index),
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  }
}

export function makeToolCallSplitter (): ToolCallSplitter {
  let inToolCall = false
  let carry = ''
  let frame = ''
  let index = 0

  const split = function split (input: string): ToolCallSegment[] {
    let text = carry + input
    carry = ''
    const segments: ToolCallSegment[] = []

    while (text.length > 0) {
      if (inToolCall) {
        const idx = text.indexOf(TOOL_CALL_CLOSE)
        if (idx !== -1) {
          frame += text.slice(0, idx + TOOL_CALL_CLOSE.length)
          text = text.slice(idx + TOOL_CALL_CLOSE.length)
          inToolCall = false
          const parsed = parseToolCallFrame(frame, index)
          if (parsed !== undefined) {
            index += 1
            segments.push({ type: 'tool_call', toolCall: parsed })
          } else {
            segments.push({ type: 'content', text: frame })
          }
          frame = ''
          continue
        }

        const k = maxTagSuffix(text, TOOL_CALL_CLOSE)
        frame += text.slice(0, text.length - k)
        carry = text.slice(text.length - k)
        break
      }

      const idx = text.indexOf(TOOL_CALL_OPEN)
      if (idx !== -1) {
        if (idx > 0) segments.push({ type: 'content', text: text.slice(0, idx) })
        frame = TOOL_CALL_OPEN
        text = text.slice(idx + TOOL_CALL_OPEN.length)
        inToolCall = true
        continue
      }

      const k = maxTagSuffix(text, TOOL_CALL_OPEN)
      const content = text.slice(0, text.length - k)
      if (content !== '') segments.push({ type: 'content', text: content })
      carry = text.slice(text.length - k)
      break
    }

    return segments
  }

  split.flush = (): ToolCallSegment[] => {
    const suffix = carry
    carry = ''
    if (inToolCall) {
      const raw = frame + suffix
      frame = ''
      inToolCall = false
      return raw === '' ? [] : [{ type: 'content', text: raw }]
    }
    return suffix === '' ? [] : [{ type: 'content', text: suffix }]
  }

  return split
}

interface SSEDelta {
  content?: unknown
  [key: string]: unknown
}

interface SSEChoice {
  delta?: SSEDelta
  finish_reason?: unknown
  [key: string]: unknown
}

export interface SSEChunk {
  choices?: SSEChoice[]
  [key: string]: unknown
}

function pushContentChunks (
  chunk: SSEChunk,
  choice: SSEChoice,
  deltaRest: SSEDelta,
  text: string,
  split: ThinkSplitter,
  out: SSEChunk[]
): void {
  const { content, reasoning } = split(text)
  if (reasoning !== '') {
    out.push({ ...chunk, choices: [{ ...choice, delta: { reasoning_content: reasoning }, finish_reason: null }] })
  }
  const rest: SSEDelta = { ...deltaRest, content }
  const hasOtherKeys = Object.keys(rest).some((k) => k !== 'content')
  if (content !== '' || hasOtherKeys) {
    out.push({ ...chunk, choices: [{ ...choice, delta: rest }] })
  }
}

// Turn one upstream SSE object into OpenAI-compatible output: `reasoning_content`
// for `<think>` text, `tool_calls` for repaired model-emitted tool frames, and
// plain `content` for the rest. Chunks without a string content delta pass through.
export function transformSSEChunk (chunk: SSEChunk, split: ThinkSplitter, toolSplit?: ToolCallSplitter): SSEChunk[] {
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
  const delta = choice?.delta
  if (choice === undefined || delta === undefined || typeof delta.content !== 'string') {
    return [chunk]
  }

  const out: SSEChunk[] = []
  if (toolSplit === undefined) {
    const rest: SSEDelta = { ...delta }
    delete rest.content
    pushContentChunks(chunk, choice, rest, delta.content, split, out)
    return out
  }

  let rest: SSEDelta | undefined = { ...delta }
  delete rest.content
  for (const segment of toolSplit(delta.content)) {
    if (segment.type === 'content') {
      pushContentChunks(chunk, choice, rest ?? {}, segment.text, split, out)
      rest = undefined
      continue
    }
    out.push({ ...chunk, choices: [{ ...choice, delta: { tool_calls: [segment.toolCall] }, finish_reason: null }] })
    rest = undefined
  }
  return out
}
