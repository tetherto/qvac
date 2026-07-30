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
export function flattenContent(content: unknown): unknown {
  if (typeof content === 'string' || content === null || content === undefined) return content
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
export function flattenMessages(body: ChatCompletionBody): ChatCompletionBody {
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg !== null && msg !== undefined && 'content' in msg) {
        msg.content = flattenContent(msg.content)
      }
    }
  }
  return body
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

// Longest suffix of `text` that is a strict prefix of `tag`, so a tag split
// across stream chunks is carried over rather than emitted half-formed.
function maxTagSuffix(text: string, tag: string): number {
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
export function makeThinkSplitter(): ThinkSplitter {
  let inThink = false
  let carry = ''
  const split = function split(input: string): SplitResult {
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

// Turn one upstream SSE object into 0..2 objects: a `reasoning_content` chunk
// for any `<think>` text and/or a `content` chunk for the rest. Chunks without
// a string `content` delta (role-only, tool_calls, finish, usage) pass through.
export function transformSSEChunk(chunk: SSEChunk, split: ThinkSplitter): SSEChunk[] {
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
  const delta = choice?.delta
  if (choice === undefined || delta === undefined || typeof delta.content !== 'string') {
    return [chunk]
  }
  const { content, reasoning } = split(delta.content)
  const out: SSEChunk[] = []
  if (reasoning !== '') {
    out.push({
      ...chunk,
      choices: [{ ...choice, delta: { reasoning_content: reasoning }, finish_reason: null }]
    })
  }
  const rest: SSEDelta = { ...delta, content }
  const hasOtherKeys = Object.keys(rest).some((k) => k !== 'content')
  if (content !== '' || hasOtherKeys) {
    out.push({ ...chunk, choices: [{ ...choice, delta: rest }] })
  }
  return out
}
