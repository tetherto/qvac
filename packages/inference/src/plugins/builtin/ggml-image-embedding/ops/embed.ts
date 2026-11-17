import type { MegaLoc } from '@qvac/classification-ggml'
import fs from 'bare-fs'
import { getModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import { EmbedFailedError, InferenceCancelledError, InvalidResponseError } from '@/errors/index'
import { decodeBase64 } from '@/utils/encoding'
import { nowMs } from '@/profiling/index'
import { attachModelExecutionMs, forwardModelExecution } from '@/profiling/model-execution'
import { requestParent, type PluginHandlerContext } from '@/schemas/plugin'
import {
  embedRequestSchema,
  embedBatchRequestSchema,
  imageEmbeddingSchema,
  type EmbedWireInput,
  type EmbedMediaSource,
  type EmbedRequest,
  type EmbedBatchRequest,
  type ImageEmbeddingStats
} from '@/schemas/index'

export async function embed(request: EmbedRequest, context?: PluginHandlerContext) {
  const parsed = embedRequestSchema.parse(request)
  const inputs = parsed.input !== undefined ? [parsed.input] : parsed.inputs
  if (inputs === undefined) throw new EmbedFailedError('MegaLoc accepts images, not text')
  const result = await runImages(parsed, inputs, context)
  return forwardModelExecution(
    {
      type: 'embed' as const,
      success: true,
      embedding: parsed.input !== undefined ? result.embedding[0]! : result.embedding,
      stats: result.stats
    },
    result
  )
}

export async function embedBatch(request: EmbedBatchRequest, context?: PluginHandlerContext) {
  const parsed = embedBatchRequestSchema.parse(request)
  const result = await runImages(parsed, parsed.inputs, context)
  return forwardModelExecution(
    {
      type: 'embedBatch' as const,
      success: true,
      embedding: result.embedding,
      stats: result.stats
    },
    result
  )
}

type ImageSource =
  | { kind: 'image'; input: Extract<EmbedWireInput, { image: string }> }
  | { kind: 'media'; media: EmbedMediaSource }

// Runs before queue admission, so a malformed batch fails without waiting or starting native work.
// The request schema has already checked base64 and RGB byte lengths.
function toImageSource(input: EmbedWireInput): ImageSource {
  if (typeof input === 'object' && !Array.isArray(input)) return { kind: 'image', input }
  if (Array.isArray(input) && input.length === 1 && typeof input[0] !== 'string') {
    return { kind: 'media', media: input[0]!.media }
  }
  throw new EmbedFailedError(
    'MegaLoc requires one image per input and does not accept text or audio'
  )
}

// Loads one image at a time so a batch never holds every decoded image in memory.
async function loadImage(source: ImageSource) {
  if (source.kind === 'image') {
    const { image, width, height, channels } = source.input
    const dimensions =
      width !== undefined && height !== undefined && channels !== undefined
        ? { width, height, channels }
        : undefined
    return { image: decodeBase64(image), dimensions }
  }
  const { type, value } = source.media
  if (type === 'base64') return { image: decodeBase64(value), dimensions: undefined }
  let image: Uint8Array
  try {
    image = await fs.promises.readFile(value, 'buffer')
  } catch (cause) {
    throw new EmbedFailedError('Unable to read embedding media', cause)
  }
  if (image.byteLength === 0) throw new EmbedFailedError('Image cannot be empty')
  return { image, dimensions: undefined }
}

async function runImages(
  request: { modelId: string; requestId?: string | undefined; sessionId?: string | undefined },
  inputs: EmbedWireInput[],
  context: PluginHandlerContext | undefined
) {
  const { modelId, requestId, sessionId } = request
  const sources = inputs.map(toImageSource)
  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    sessionId,
    ...requestParent(context),
    kind: 'imageEmbedding',
    modelId
  })
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  const model = getModel(modelId) as unknown as MegaLoc
  const started = nowMs()
  try {
    const embedding: number[][] = []
    let totalTime: number | undefined
    let native: ReturnType<MegaLoc['getRuntimeStats']> | undefined
    for (const source of sources) {
      if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
      const { image, dimensions } = await loadImage(source)
      if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
      const raw = await model.embed(image, dimensions)
      if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
      const parsed = imageEmbeddingSchema.safeParse(Array.from(raw))
      if (!parsed.success) throw new InvalidResponseError('embed', parsed.error)
      embedding.push(parsed.data)
      native = model.getRuntimeStats()
      if (native.total_time_ms !== undefined) {
        totalTime = (totalTime ?? 0) + native.total_time_ms
      }
    }
    // totalTime sums every image; the remaining fields describe the final image.
    const stats: ImageEmbeddingStats = {
      ...(totalTime !== undefined && { totalTime }),
      ...(native?.backend_id !== undefined && { backendId: native.backend_id }),
      ...(native?.cpu_fallback_nodes !== undefined && {
        cpuFallbackNodes: native.cpu_fallback_nodes
      }),
      ...(native?.weight_bytes !== undefined && { weightBytes: native.weight_bytes })
    }
    return attachModelExecutionMs({ embedding, stats }, nowMs() - started)
  } catch (error) {
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId, {}, error)
    ctx.state = 'failed'
    throw error
  }
}
