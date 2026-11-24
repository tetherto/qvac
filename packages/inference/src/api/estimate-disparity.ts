import { send } from '@/dispatch'
import {
  decodeFloat32Base64,
  estimateDisparityClientParamsSchema,
  estimateDisparityResponseSchema,
  type DisparityMap,
  type EstimateDisparityClientParams,
  type RPCOptions
} from '@/schemas/index'
import Buffer from 'bare-buffer'
import { InvalidResponseError } from '@/errors/index'
import { parseClientInput } from '@/api/parse-input'
import { encodeBase64 } from '@/utils/encoding'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateRequestId } from '@/runtime/request-id'

/**
 * Estimates the disparity of the left view from a rectified stereo pair with a
 * loaded `ggml-stereo-depth` (BridgeDepth) model.
 *
 * Both views are JPEG/PNG bytes, or packed RGB bytes with one shared `width`,
 * `height` and `channels: 3`. They must have the same size, each side from 32
 * to 4096 pixels. The model runs on at most 1280x720 (720x1280 in portrait)
 * and scales a larger pair down to fit; the map comes back at the input size,
 * in input pixels. A larger pair adds no detail and only makes the reply
 * bigger, so scale both views to fit 1280x720 first unless you need a value
 * for every input pixel.
 *
 * Depth is `focalPx * baseline / disparity` with the rig's calibration.
 *
 * @param params - The loaded model ID, the left and right views, and the raw
 *   RGB dimensions when the views are not JPEG/PNG.
 * @param options - Dispatch options.
 * @returns The disparity map and native statistics. The promise carries
 *   `requestId` synchronously for `cancel({ requestId })`.
 * @throws {RequestValidationFailedError} If the request is invalid.
 * @throws {ModelNotFoundError} If `modelId` is not loaded.
 * @throws {ModelOperationNotSupportedError} If the loaded model is not a stereo depth model.
 * @throws {RequestRejectedByPolicyError} If this model's stereo depth queue is full.
 * @throws {InvalidResponseError} If the handler returns a malformed result.
 */
export function estimateDisparity(
  params: EstimateDisparityClientParams,
  options?: RPCOptions
): Promise<DisparityMap> & { requestId: string } {
  const requestId = generateRequestId()
  return decoratePromise(runEstimateDisparity(params, requestId, options), { requestId })
}

async function runEstimateDisparity(
  params: EstimateDisparityClientParams,
  requestId: string,
  options?: RPCOptions
): Promise<DisparityMap> {
  const parsed = parseClientInput(estimateDisparityClientParamsSchema, params)
  const response = await send(
    {
      type: 'estimateDisparity',
      requestId,
      modelId: parsed.modelId,
      left: encodeBase64(parsed.left),
      right: encodeBase64(parsed.right),
      ...(parsed.width !== undefined && { width: parsed.width }),
      ...(parsed.height !== undefined && { height: parsed.height }),
      ...(parsed.channels !== undefined && { channels: parsed.channels })
    },
    options
  )
  if (response.type !== 'estimateDisparity') throw new InvalidResponseError('estimateDisparity')
  const result = estimateDisparityResponseSchema.safeParse(response)
  if (!result.success) throw new InvalidResponseError('estimateDisparity', result.error)
  const { width, height, disparity, stats } = result.data
  return {
    width,
    height,
    disparity: decodeFloat32Base64(disparity, Buffer),
    ...(stats !== undefined && { stats })
  }
}
