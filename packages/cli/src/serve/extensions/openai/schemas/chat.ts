import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HistoryContent, HistoryContentPart, Tool } from '@qvac/sdk'
import { namedKvCacheKey } from '@/serve/lib/named-kv-cache'
import {
  chatMessage,
  responseFormat,
  toolDef,
  openaiToolsToSdk,
  toolChoice,
  extractGenerationParams,
  extractResponseFormat,
  extractToolChoice,
  withToolChoice,
  parseToolCallArguments,
  hoistInstructions,
  nameToolResults,
  withParallelToolCalls,
  UnsupportedImageContentError,
  type GenerationParams,
  type ResponseFormat,
  type MessageContentPart,
  type ToolTurnFields
} from '@/serve/extensions/openai/schemas/common'

export const chatCompletionsBody = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessage),
    stream: z.boolean().optional(),
    tools: z.array(toolDef).optional(),
    tool_choice: toolChoice.optional(),
    parallel_tool_calls: z.boolean().optional(),
    response_format: responseFormat.optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    prompt_cache_key: z
      .unknown()
      .optional()
      .describe('Names a KV cache session, per conversation; a string of at most 512 UTF-8 bytes.'),
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
  'stop',
  'remove_thinking_from_context'
] as const

export interface OpenAIMessage {
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

type DecodedContentPart = { type: 'text'; text: string } | { type: 'media'; image: ImageAttachment }

interface TextHistoryItem extends ToolTurnFields {
  role: string
  content: string
}

interface PartsHistoryItem extends ToolTurnFields {
  role: 'user'
  content: DecodedContentPart[]
}

type ChatHistoryItem = TextHistoryItem | PartsHistoryItem

// The SDK `completion` history reads images from disk by path; writeChatImages turns the
// decoded bytes into these just-in-time at the inference call (mirrors routes/audio.ts).
interface SdkHistoryItem extends ToolTurnFields {
  role: string
  content: HistoryContent
}

// Past tool calls and results go to the SDK as structured fields, so the model's
// chat template renders them in its own tool-call format.
export function openaiMessagesToHistory(messages: OpenAIMessage[]): ChatHistoryItem[] {
  // Pure: decode + validate image parts to bytes (an unsupported image throws → 400). No file I/O —
  // writeChatImages materializes the bytes at the inference call, like routes/audio.ts.
  return nameToolResults(
    hoistInstructions(
      messages.map((msg) => {
        const item = decodeMessage(msg)
        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
          item.toolCalls = msg.tool_calls.map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: parseToolCallArguments(call.function.arguments)
          }))
        }
        if (msg.role === 'tool' && msg.tool_call_id !== undefined) {
          item.toolCallId = msg.tool_call_id
        }
        return item
      })
    )
  )
}

function decodeMessage(msg: OpenAIMessage): ChatHistoryItem {
  if (Array.isArray(msg.content)) {
    return decodeMultimodalContent(msg.role, msg.content)
  }
  return {
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : (msg.content ?? '').toString()
  }
}

// OpenAI multimodal content is an array of parts; each `image_url` (base64 data URL) is decoded to
// its bytes. An image we cannot honor throws (→ 400) rather than being dropped, so a "describe this
// image" turn never silently degrades to a text-only answer.
//
// A user turn with images stays as ordered parts, so the model sees each image where the client put
// it; a turn without images becomes one text string. The model reads images on user turns only.
function decodeMultimodalContent(role: string, parts: MessageContentPart[]): ChatHistoryItem {
  if (role !== 'user' && parts.some((part) => part.type === 'image_url')) {
    throw new UnsupportedImageContentError(
      `image_url is only supported on user messages, not on a "${role}" message.`
    )
  }
  const decoded = parts.map((part): DecodedContentPart =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'media', image: decodeImageUrl(imageUrlOf(part)) }
  )
  if (role === 'user' && decoded.some((part) => part.type === 'media')) {
    return { role, content: decoded }
  }
  return { role, content: joinText(decoded) }
}

function imageUrlOf(part: Extract<MessageContentPart, { type: 'image_url' }>): string {
  return typeof part.image_url === 'string' ? part.image_url : part.image_url.url
}

function joinText(parts: DecodedContentPart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
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

// Materialize each media part's image to a flat temp file (mirrors
// routes/audio.ts's writeTempAudio) and return the SDK history plus the temp paths the caller must
// unlink in a `finally`. Atomic: if a write fails partway, the files already written this call are
// removed.
export async function writeChatImages(
  history: ChatHistoryItem[]
): Promise<{ history: SdkHistoryItem[]; tmpPaths: string[] }> {
  const tmpPaths: string[] = []
  const writeImage = async (image: ImageAttachment): Promise<string> => {
    const path = join(tmpdir(), `qvac-image-${randomBytes(8).toString('hex')}.${image.ext}`)
    await writeFile(path, image.bytes)
    tmpPaths.push(path)
    return path
  }
  const sdkHistory: SdkHistoryItem[] = []
  try {
    for (const { content, ...item } of history) {
      sdkHistory.push({
        ...item,
        content: typeof content === 'string' ? content : await writeMediaParts(content, writeImage)
      })
    }
    return { history: sdkHistory, tmpPaths }
  } catch (err) {
    await Promise.all(tmpPaths.map((path) => unlink(path).catch(() => undefined)))
    throw err
  }
}

async function writeMediaParts(
  parts: DecodedContentPart[],
  writeImage: (image: ImageAttachment) => Promise<string>
): Promise<HistoryContentPart[]> {
  const written: HistoryContentPart[] = []
  for (const part of parts) {
    written.push(
      part.type === 'text' ? part : { type: 'media', path: await writeImage(part.image) }
    )
  }
  return written
}

export type ChatCompletionsBody = z.infer<typeof chatCompletionsBody>

export interface SdkChatArgs {
  /** The named cache session the request selected; undefined means auto-cache. */
  kvCache: string | undefined
  history: ChatHistoryItem[]
  tools: Tool[] | undefined
  generationParams: GenerationParams | undefined
  responseFormat: ResponseFormat | undefined
  stream: boolean
}

// OpenAI suggests one `prompt_cache_key` per user, and a cache holds one
// conversation: conversations sharing it would evict each other every turn.
// The messages up to the first user turn stay fixed while a conversation grows.
function conversationOpening(messages: readonly { role: string }[]): string {
  const firstUser = messages.findIndex((message) => message.role === 'user')
  return JSON.stringify(firstUser === -1 ? messages : messages.slice(0, firstUser + 1))
}

export function toSdkChatArgs(
  body: ChatCompletionsBody,
  rawHeaders: readonly string[] = []
): SdkChatArgs {
  const responseFmt = extractResponseFormat(body as Record<string, unknown>)
  const tools = openaiToolsToSdk(body.tools as Parameters<typeof openaiToolsToSdk>[0])
  return {
    kvCache: namedKvCacheKey(rawHeaders, body, conversationOpening(body.messages)),
    history: openaiMessagesToHistory(body.messages as OpenAIMessage[]),
    tools,
    generationParams: withParallelToolCalls(
      withToolChoice(
        extractGenerationParams(body as Record<string, unknown>, 'max_completion_tokens'),
        extractToolChoice(body as Record<string, unknown>, tools)
      ),
      body.parallel_tool_calls
    ),
    responseFormat: responseFmt,
    stream: Boolean(body.stream)
  }
}
