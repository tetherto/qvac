import type { BridgeDepth } from '@qvac/classification-ggml'
import Buffer from 'bare-buffer'
import { getModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'
import { InferenceCancelledError, InvalidResponseError } from '@/errors/index'
import { rawRgbDimensions } from '@/schemas/raw-rgb'
import { nowMs } from '@/profiling/index'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { requestParent, type PluginHandlerContext } from '@/schemas/plugin'
import {
  encodeFloat32Base64,
  estimateDisparityRequestSchema,
  estimateDisparityResponseSchema,
  type EstimateDisparityRequest,
  type StereoDepthStats
} from '@/schemas/index'

export async function estimateDisparity(
  request: EstimateDisparityRequest,
  context?: PluginHandlerContext
) {
  const parsed = estimateDisparityRequestSchema.parse(request)
  const { modelId, requestId, sessionId } = parsed
  const dimensions = rawRgbDimensions(parsed)

  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    sessionId,
    ...requestParent(context),
    kind: 'stereoDepth',
    modelId
  })
  if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
  const model = getModel(modelId) as unknown as BridgeDepth
  const started = nowMs()
  try {
    const left = Buffer.from(parsed.left, 'base64')
    const right = Buffer.from(parsed.right, 'base64')
    const result = await model.infer(left, right, dimensions)
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId)
    // The map must come back at the input size. Only raw RGB input tells us
    // that size here; JPEG/PNG would have to be decoded to know it.
    if (
      dimensions !== undefined &&
      (result.width !== dimensions.width || result.height !== dimensions.height)
    ) {
      throw new InvalidResponseError(
        'estimateDisparity',
        new Error(
          `BridgeDepth returned a ${result.width}x${result.height} map for a ` +
            `${dimensions.width}x${dimensions.height} input`
        )
      )
    }
    const native = model.getRuntimeStats()
    const stats: StereoDepthStats = {
      ...(native.total_time_ms !== undefined && { totalTime: native.total_time_ms }),
      ...(native.backend_id !== undefined && { backendId: native.backend_id }),
      ...(native.cpu_fallback_nodes !== undefined && {
        cpuFallbackNodes: native.cpu_fallback_nodes
      }),
      ...(native.weight_bytes !== undefined && { weightBytes: native.weight_bytes })
    }
    const response = estimateDisparityResponseSchema.safeParse({
      type: 'estimateDisparity' as const,
      width: result.width,
      height: result.height,
      disparity: encodeFloat32Base64(result.disparity, Buffer),
      stats
    })
    if (!response.success) throw new InvalidResponseError('estimateDisparity', response.error)
    return attachModelExecutionMs(response.data, nowMs() - started)
  } catch (error) {
    if (ctx.signal.aborted) throw new InferenceCancelledError(ctx.requestId, {}, error)
    ctx.state = 'failed'
    throw error
  }
}
