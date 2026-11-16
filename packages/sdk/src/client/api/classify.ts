import {
  classifyResponseSchema,
  type ClassifyRequest,
  type ClassifyClientParams,
  type ClassificationResult,
  type RPCOptions
} from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { decoratePromise } from '@/utils/decorate-promise'
import { encodeBase64 } from '@/utils/encoding'

/**
 * Classifies an image using a loaded classification model.
 *
 * The `MOBILENETV3_3CLASS_V3_FP16` model produces 3 labels: `"food"`, `"report"`, `"other"`.
 * Custom models may emit different labels sourced from the GGUF metadata.
 *
 * @param params - The loaded model ID, image data, optional raw-image
 *   dimensions, and result limit.
 * @param params.modelId - The identifier of the loaded classification model
 * @param params.image - JPEG or PNG buffer; raw RGB bytes also accepted with `width`, `height`, `channels`
 * @param params.topK - Limit results to top-K classes (default: all)
 * @param options - Optional RPC options (timeout, profiling, force new connection).
 * @returns Sorted classification results, highest confidence first. The promise
 *   carries `requestId` synchronously for `cancel({ requestId })`.
 *
 * @example
 * ```typescript
 * const modelId = await loadModel({
 *   modelSrc: MOBILENETV3_3CLASS_V3_FP16,
 *   modelType: "ggml-classification",
 * });
 * const jpeg = fs.readFileSync("photo.jpg");
 * const results = await classify({ modelId, image: jpeg });
 * // [ { label: "food", confidence: 0.93 }, { label: "other", confidence: 0.05 }, ... ]
 * await unloadModel({ modelId });
 * ```
 */
export function classify(
  params: ClassifyClientParams,
  options?: RPCOptions
): Promise<ClassificationResult[]> & { requestId: string } {
  const requestId = generateClientRequestId()
  return decoratePromise(runClassify(params, requestId, options), { requestId })
}

async function runClassify(
  params: ClassifyClientParams,
  requestId: string,
  options?: RPCOptions
): Promise<ClassificationResult[]> {
  const request: ClassifyRequest = {
    type: 'classify',
    requestId,
    modelId: params.modelId,
    image: encodeBase64(params.image),
    ...(params.topK !== undefined && { topK: params.topK }),
    ...(params.width !== undefined && { width: params.width }),
    ...(params.height !== undefined && { height: params.height }),
    ...(params.channels !== undefined && { channels: params.channels })
  }

  for await (const response of streamRpc(request, options)) {
    if (
      response &&
      typeof response === 'object' &&
      'type' in response &&
      response.type === 'classify'
    ) {
      const parsed = classifyResponseSchema.parse(response)
      if (parsed.done) {
        return parsed.results
      }
    }
  }

  return []
}
