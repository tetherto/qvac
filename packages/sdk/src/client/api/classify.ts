import {
  classifyResponseSchema,
  type ClassifyRequest,
  type ClassifyClientParams,
  type ClassificationResult
} from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { encodeBase64 } from '@/utils/encoding'

/**
 * Classifies an image using a loaded classification model.
 */
export async function classify(params: ClassifyClientParams): Promise<ClassificationResult[]> {
  const request: ClassifyRequest = {
    type: 'classify',
    modelId: params.modelId,
    image: encodeBase64(params.image),
    ...(params.topK !== undefined && { topK: params.topK }),
    ...(params.width !== undefined && { width: params.width }),
    ...(params.height !== undefined && { height: params.height }),
    ...(params.channels !== undefined && { channels: params.channels })
  }

  for await (const response of streamRpc(request)) {
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
