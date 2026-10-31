import type { MegaLoc } from '@qvac/classification-ggml'
import { getModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import { InferenceCancelledError, InvalidResponseError } from '@/errors/index'
import { decodeBase64 } from '@/utils/encoding'
import { nowMs } from '@/profiling/index'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import {
  embedImageRequestSchema,
  embedImageClientParamsSchema,
  imageEmbeddingSchema,
  type EmbedImageRequest
} from '@/schemas/index'

export async function embedImage(request: EmbedImageRequest) {
  const { modelId, requestId, image, ...dimensions } = embedImageRequestSchema.parse(request)
  const input = embedImageClientParamsSchema.parse({
    modelId,
    image: decodeBase64(image),
    ...dimensions
  })
  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    kind: 'imageEmbedding',
    modelId
  })
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  const model = getModel(modelId) as unknown as MegaLoc
  const started = nowMs()
  try {
    const raw = await model.embed(
      input.image,
      input.width !== undefined && input.height !== undefined && input.channels !== undefined
        ? { width: input.width, height: input.height, channels: input.channels }
        : undefined
    )
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    const parsed = imageEmbeddingSchema.safeParse(Array.from(raw))
    if (!parsed.success) throw new InvalidResponseError('embedImage', parsed.error)
    const stats = model.getRuntimeStats()
    return attachModelExecutionMs(
      {
        type: 'embedImage' as const,
        embedding: parsed.data,
        stats: {
          ...(stats.total_time_ms !== undefined && { totalTime: stats.total_time_ms }),
          ...(stats.backend_id !== undefined && { backendId: stats.backend_id }),
          ...(stats.cpu_fallback_nodes !== undefined && {
            cpuFallbackNodes: stats.cpu_fallback_nodes
          }),
          ...(stats.weight_bytes !== undefined && { weightBytes: stats.weight_bytes })
        }
      },
      nowMs() - started
    )
  } catch (error) {
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    ctx.state = 'failed'
    throw error
  }
}
