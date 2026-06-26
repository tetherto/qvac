import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '@qvac/sdk'
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

export const chatCompletionsBody = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessage),
  stream: z.boolean().optional(),
  tools: z.array(toolDef).optional(),
  response_format: responseFormat.optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().optional()
}).passthrough()

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

export function openaiMessagesToHistory (messages: OpenAIMessage[]): ChatHistoryItem[] {
  // Pure: decode + validate image parts to bytes (an unsupported image throws → 400). No file I/O —
  // writeChatImages materializes the bytes at the inference call, like routes/audio.ts.
  return messages.map((msg) => {
    const decoded = decodeMessage(msg)
    return decoded.images.length > 0
      ? { role: decoded.role, content: decoded.content, attachments: decoded.images }
      : { role: decoded.role, content: decoded.content }
  })
}

function decodeMessage (msg: OpenAIMessage): DecodedMessage {
  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    return { role: 'assistant', content: synthesizeToolCallContent(msg.tool_calls), images: [] }
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
function decodeMultimodalContent (role: string, parts: MessageContentPart[]): DecodedMessage {
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

function decodeImageUrl (url: string): ImageAttachment {
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
export async function writeChatImages (history: ChatHistoryItem[]): Promise<{ history: SdkHistoryItem[], tmpPaths: string[] }> {
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

export type ChatCompletionsBody = z.infer<typeof chatCompletionsBody>

export interface SdkChatArgs {
  history: ChatHistoryItem[]
  tools: Tool[] | undefined
  generationParams: GenerationParams | undefined
  responseFormat: ResponseFormat | undefined
  stream: boolean
}

export function toSdkChatArgs (body: ChatCompletionsBody): SdkChatArgs {
  const responseFmt = extractResponseFormat(body as Record<string, unknown>)
  return {
    history: openaiMessagesToHistory(body.messages as OpenAIMessage[]),
    tools: openaiToolsToSdk(body.tools as Parameters<typeof openaiToolsToSdk>[0]),
    generationParams: extractGenerationParams(body as Record<string, unknown>, 'max_completion_tokens'),
    responseFormat: responseFmt,
    stream: Boolean(body.stream)
  }
}
