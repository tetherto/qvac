import {
  decodeFloat32Base64,
  estimateDisparityClientParamsSchema,
  estimateDisparityResponseSchema,
  type DisparityMap,
  type EstimateDisparityClientParams,
  type EstimateDisparityRequest,
  type RPCOptions
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { parseClientInput } from '@/client/parse-input'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { decoratePromise } from '@/utils/decorate-promise'
import { encodeBase64 } from '@/utils/encoding'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Estimates the disparity of the left view from a rectified stereo pair with a
 * loaded `ggml-stereo-depth` (BridgeDepth) model.
 *
 * Both views are JPEG/PNG bytes, or packed RGB bytes with one shared `width`,
 * `height` and `channels: 3`. They must have the same size, each side from 32
 * to 4096 pixels. The model runs on at most 1280x720 (720x1280 in portrait)
 * and scales a larger pair down to fit. The map always comes back at the input
 * size, in input pixels. A larger pair adds no detail and only makes the reply
 * bigger, so scale both views to fit 1280x720 first unless you need a value
 * for every input pixel.
 *
 * Depth is `focalPx * baseline / disparity` with the rig's calibration.
 *
 * @param params - The loaded model ID, the left and right views, and the raw
 *   RGB dimensions when the views are not JPEG/PNG.
 * @param options - Optional RPC options (timeout, profiling, force new connection).
 * @returns The disparity map as a row-major `Float32Array` with its width,
 *   height and native statistics. The promise carries `requestId`
 *   synchronously for `cancel({ requestId })`; cancelling a running request
 *   discards its result.
 * @throws {RequestValidationFailedError} If the request is invalid.
 * @throws {ModelNotFoundError} If `modelId` is not loaded.
 * @throws {ModelOperationNotSupportedError} If the loaded model is not a stereo depth model.
 * @throws {RequestRejectedByPolicyError} If this model's stereo depth queue is full.
 * @throws {InvalidResponseError} If the worker returns a malformed result.
 *
 * @example
 * ```typescript
 * const modelId = await loadModel({
 *   modelSrc: "/models/bridgedepth-vits-f32.gguf",
 *   modelType: "ggml-stereo-depth",
 * });
 * const { width, height, disparity } = await estimateDisparity({
 *   modelId,
 *   left: fs.readFileSync("left.png"),
 *   right: fs.readFileSync("right.png"),
 * });
 * const centre = disparity[(height >> 1) * width + (width >> 1)];
 * await unloadModel({ modelId });
 * ```
 */
export function estimateDisparity(
  params: EstimateDisparityClientParams,
  options?: RPCOptions
): Promise<DisparityMap> & { requestId: string } {
  return createEstimateDisparityCall(params, options)
}

export function createEstimateDisparityCall(
  params: EstimateDisparityClientParams,
  options?: RPCOptions,
  sendRequest: typeof send = send
): Promise<DisparityMap> & { requestId: string } {
  const requestId = generateClientRequestId()
  return decoratePromise(runEstimateDisparity(params, requestId, options, sendRequest), {
    requestId
  })
}

async function runEstimateDisparity(
  params: EstimateDisparityClientParams,
  requestId: string,
  options: RPCOptions | undefined,
  sendRequest: typeof send
): Promise<DisparityMap> {
  const parsed = parseClientInput(estimateDisparityClientParamsSchema, params)
  const request: EstimateDisparityRequest = {
    type: 'estimateDisparity',
    requestId,
    modelId: parsed.modelId,
    left: encodeBase64(parsed.left),
    right: encodeBase64(parsed.right),
    ...(parsed.width !== undefined && { width: parsed.width }),
    ...(parsed.height !== undefined && { height: parsed.height }),
    ...(parsed.channels !== undefined && { channels: parsed.channels })
  }
  const response = await sendRequest(request, options)
  if (response.type !== 'estimateDisparity') throw new InvalidResponseError('estimateDisparity')
  const result = estimateDisparityResponseSchema.safeParse(response)
  if (!result.success) throw new InvalidResponseError('estimateDisparity', result.error)
  const { width, height, disparity, stats } = result.data
  return {
    width,
    height,
    disparity: decodeFloat32Base64(disparity),
    ...(stats !== undefined && { stats })
  }
}
