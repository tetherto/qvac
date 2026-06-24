import {
  classifyResponseSchema,
  type ClassifyRequest,
  type ClassifyClientParams,
  type ClassificationResult,
} from "@/schemas";
import { stream as streamRpc } from "@/client/rpc/rpc-client";
import { encodeBase64 } from "@/utils/encoding";

/**
 * Classifies an image using a loaded classification model.
 *
 * The bundled MobileNetV3-Small model produces 3 labels: `"food"`, `"report"`, `"other"`.
 * Custom models may emit different labels sourced from the GGUF metadata.
 *
 * @param params.modelId - The identifier of the loaded classification model
 * @param params.image - JPEG or PNG buffer; raw RGB bytes also accepted with `width`, `height`, `channels`
 * @param params.topK - Limit results to top-K classes (default: all)
 * @returns Sorted classification results, highest confidence first
 *
 * @example
 * ```typescript
 * const modelId = await loadModel({ modelType: "ggml-classification" });
 * const jpeg = fs.readFileSync("photo.jpg");
 * const results = await classify({ modelId, image: jpeg });
 * // [ { label: "food", confidence: 0.93 }, { label: "other", confidence: 0.05 }, ... ]
 * await unloadModel({ modelId });
 * ```
 */
export async function classify(
  params: ClassifyClientParams,
): Promise<ClassificationResult[]> {
  const request: ClassifyRequest = {
    type: "classify",
    modelId: params.modelId,
    image: encodeBase64(params.image),
    ...(params.topK !== undefined && { topK: params.topK }),
    ...(params.width !== undefined && { width: params.width }),
    ...(params.height !== undefined && { height: params.height }),
    ...(params.channels !== undefined && { channels: params.channels }),
  };

  for await (const response of streamRpc(request)) {
    if (response && typeof response === "object" && "type" in response && response.type === "classify") {
      const parsed = classifyResponseSchema.parse(response);
      if (parsed.done) {
        return parsed.results;
      }
    }
  }

  return [];
}
