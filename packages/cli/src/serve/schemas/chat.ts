import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolDialect } from '@qvac/sdk'
import {
  chatMessage,
  responseFormat,
  toolDef,
  openaiToolsToSdk,
  extractGenerationParams,
  extractResponseFormat,
  UnsupportedImageContentError,
  type GenerationParams,
  type ResponseFormat,
  type MessageContentPart
} from './common.js'

export const chatCompletionsBody = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessage),
    stream: z.boolean().optional(),
    tools: z.array(toolDef).optional(),
    response_format: responseFormat.optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional()
  })
  .passthrough()

export const CHAT_UNSUPPORTED_PARAMS = [
  'logit_bias',
  'n',
  'user',
  'seed',
  'logprobs',
  'top_logprobs',
  'frequency_penalty',
  'presence_penalty',
  'stop'
] as const

interface OpenAIMessage {
  role: string
  content: string | null | undefined | MessageContentPart[]
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface ImageAttachment {
  ext: string
  bytes: Buffer
}

interface ChatHistoryItem {
  role: string
  content: string
  attachments?: ImageAttachment[]
}

interface DecodedMessage {
  role: string
  content: string
  images: ImageAttachment[]
}

// The SDK `completion` history reads image attachments from disk by path; writeChatImages turns the
// decoded bytes into these just-in-time at the inference call (mirrors routes/audio.ts).
interface SdkHistoryItem {
  role: string
  content: string
  attachments?: Array<{ path: string }>
}

export function openaiMessagesToHistory(
  messages: OpenAIMessage[],
  dialect: ToolDialect
): ChatHistoryItem[] {
  // Pure: decode + validate image parts to bytes (an unsupported image throws → 400). No file I/O —
  // writeChatImages materializes the bytes at the inference call, like routes/audio.ts.
  return messages.map((msg) => {
    const decoded = decodeMessage(msg, dialect)
    return decoded.images.length > 0
      ? { role: decoded.role, content: decoded.content, attachments: decoded.images }
      : { role: decoded.role, content: decoded.content }
  })
}

function decodeMessage(msg: OpenAIMessage, dialect: ToolDialect): DecodedMessage {
  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    return {
      role: 'assistant',
      content: synthesizeToolCallContent(msg.tool_calls, dialect),
      images: []
    }
  }
  if (Array.isArray(msg.content)) {
    return decodeMultimodalContent(msg.role, msg.content)
  }
  return {
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : (msg.content ?? '').toString(),
    images: []
  }
}

// OpenAI multimodal content is an array of parts: concatenate the text and decode each `image_url`
// (base64 data URL) to its bytes. An image we cannot honor throws (→ 400) rather than being dropped,
// so a "describe this image" turn never silently degrades to a text-only answer.
function decodeMultimodalContent(role: string, parts: MessageContentPart[]): DecodedMessage {
  let content = ''
  const images: ImageAttachment[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      content += part.text
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url
      images.push(decodeImageUrl(url))
    }
  }
  return { role, content, images }
}

// The inference image loader (stb_image, via llama.cpp) decodes PNG and JPEG. Other formats
// (e.g. webp) would fail to load and abort the completion mid-stream, so only these are accepted —
// keyed by media type → file extension.
const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png'
}

// Leading magic bytes for each accepted type. Buffer.from(..., 'base64') never throws on malformed
// input — it silently yields garbage — so we verify the decoded bytes actually start with the
// signature for the declared type. This catches corrupt base64 and a mislabeled payload alike.
const IMAGE_MAGIC: Record<string, number[]> = {
  jpg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47]
}

function decodeImageUrl(url: string): ImageAttachment {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(url)
  if (match === null) {
    throw new UnsupportedImageContentError(
      'image_url must be a base64 data: URL; remote URLs and other schemes are not supported.'
    )
  }
  const mediaType = (match[1] ?? '').toLowerCase()
  const ext = SUPPORTED_IMAGE_TYPES[mediaType]
  if (ext === undefined) {
    throw new UnsupportedImageContentError(
      `unsupported image type "${mediaType}"; only image/png and image/jpeg are supported.`
    )
  }
  const bytes = Buffer.from(match[2] ?? '', 'base64')
  const magic = IMAGE_MAGIC[ext]
  if (magic === undefined || bytes.length < magic.length || magic.some((b, i) => bytes[i] !== b)) {
    throw new UnsupportedImageContentError(
      `image_url payload is not valid ${mediaType} data (corrupt or mislabeled base64).`
    )
  }
  return { ext, bytes }
}

// Materialize each image attachment's bytes to a flat temp file (mirrors routes/audio.ts's
// writeTempAudio) and return the SDK history plus the temp paths the caller must unlink in a
// `finally`. Atomic: if a write fails partway, the files already written this call are removed.
export async function writeChatImages(
  history: ChatHistoryItem[]
): Promise<{ history: SdkHistoryItem[]; tmpPaths: string[] }> {
  const tmpPaths: string[] = []
  const sdkHistory: SdkHistoryItem[] = []
  try {
    for (const item of history) {
      if (item.attachments === undefined || item.attachments.length === 0) {
        sdkHistory.push({ role: item.role, content: item.content })
        continue
      }
      const attachments: Array<{ path: string }> = []
      for (const image of item.attachments) {
        const path = join(tmpdir(), `qvac-image-${randomBytes(8).toString('hex')}.${image.ext}`)
        await writeFile(path, image.bytes)
        tmpPaths.push(path)
        attachments.push({ path })
      }
      sdkHistory.push({ role: item.role, content: item.content, attachments })
    }
    return { history: sdkHistory, tmpPaths }
  } catch (err) {
    await Promise.all(tmpPaths.map((path) => unlink(path).catch(() => undefined)))
    throw err
  }
}

// A client round-trips a prior tool call as OpenAI-structured `tool_calls`, so
// the model's original native framing is gone. Re-render it in the model's own
// dialect: replaying a Qwen3.5 call as Hermes JSON makes the model imitate that
// foreign shape next turn and emit a malformed hybrid frame, which then fails to
// parse and leaks the raw markup into `content`.
//
// hermes/json models re-parse a Hermes envelope cleanly (their SDK parse chains
// keep a Hermes/JSON fallback), so replaying as Hermes is safe for them. qwen35
// is rendered natively below. gemma4/harmony/pythonic have single native parse
// chains with no Hermes fallback, so a Hermes replay can provoke the same leak
// for them — they still need native renderers (QVAC-22318).
function synthesizeToolCallContent(
  toolCalls: NonNullable<OpenAIMessage['tool_calls']>,
  dialect: ToolDialect
): string {
  const render = dialect === 'qwen35' ? renderQwen35Call : renderHermesCall
  return toolCalls.map(render).join('\n')
}

function parseToolCallArguments(rawArguments: string): Record<string, unknown> {
  try {
    return JSON.parse(rawArguments) as Record<string, unknown>
  } catch {
    return {}
  }
}

function renderHermesCall(tc: NonNullable<OpenAIMessage['tool_calls']>[number]): string {
  const callObj = {
    name: tc.function.name,
    arguments: parseToolCallArguments(tc.function.arguments)
  }
  return `<tool_call>\n${JSON.stringify(callObj)}\n</tool_call>`
}

// Qwen3.5 Pythonic-XML: string values are raw text, arrays/objects are JSON,
// numbers/booleans are their literal text — mirrors the SDK's qwen35 parser.
function renderQwen35Call(tc: NonNullable<OpenAIMessage['tool_calls']>[number]): string {
  const args = parseToolCallArguments(tc.function.arguments)
  const params = Object.entries(args)
    .map(([key, value]) => `<parameter=${key}>${renderQwen35Value(value)}</parameter>`)
    .join('\n')
  const body = params.length > 0 ? `\n${params}\n` : '\n'
  return `<tool_call>\n<function=${tc.function.name}>${body}</function>\n</tool_call>`
}

function renderQwen35Value(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

// Dialect only matters when a prior assistant tool call has to be replayed into
// the prompt; a plain chat (even one requesting tools) needs no dialect lookup.
export function messagesHaveToolCalls(messages: OpenAIMessage[]): boolean {
  return messages.some(
    (msg) => msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
  )
}

export type ChatCompletionsBody = z.infer<typeof chatCompletionsBody>

export interface SdkChatArgs {
  history: ChatHistoryItem[]
  tools: Tool[] | undefined
  generationParams: GenerationParams | undefined
  responseFormat: ResponseFormat | undefined
  stream: boolean
}

export function toSdkChatArgs(body: ChatCompletionsBody, dialect: ToolDialect): SdkChatArgs {
  const responseFmt = extractResponseFormat(body as Record<string, unknown>)
  return {
    history: openaiMessagesToHistory(body.messages as OpenAIMessage[], dialect),
    tools: openaiToolsToSdk(body.tools as Parameters<typeof openaiToolsToSdk>[0]),
    generationParams: extractGenerationParams(
      body as Record<string, unknown>,
      'max_completion_tokens'
    ),
    responseFormat: responseFmt,
    stream: Boolean(body.stream)
  }
}
