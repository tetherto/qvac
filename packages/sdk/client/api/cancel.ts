import { send } from "@/client/rpc/rpc-client";
import { type CancelParams, type CancelRequest } from "@/schemas";
import { InvalidResponseError, CancelFailedError } from "@/utils/errors-client";

/**
 * Cancels an ongoing operation.
 *
 * @param params - The parameters for the cancellation
 * @param params.operation - The type of operation to cancel ("inference", "downloadAsset", or "rag")
 * @param params.modelId - The model ID (required for inference cancellation)
 * @param params.downloadKey - The download key (required for download cancellation)
 * @param params.clearCache - If true, deletes the partial download file (default: false)
 * @param params.workspace - The RAG workspace to cancel (optional, defaults to "default")
 * @throws {QvacErrorBase} When the response type is invalid or when the cancellation fails
 *
 * @example
 * // Cancel inference
 * await cancel({ operation: "inference", modelId: "model-123" });
 *
 * @example
 * // Pause download (preserves partial file for automatic resume)
 * await cancel({ operation: "downloadAsset", downloadKey: "download-key" });
 *
 * @example
 * // Cancel download completely (deletes partial file)
 * await cancel({ operation: "downloadAsset", downloadKey: "download-key", clearCache: true });
 *
 * @example
 * // Cancel RAG operation on default workspace
 * await cancel({ operation: "rag" });
 *
 * @example
 * // Cancel RAG operation on specific workspace
 * await cancel({ operation: "rag", workspace: "my-workspace" });
 */
export async function cancel(params: CancelParams) {
  const request: CancelRequest = {
    type: "cancel",
    ...params,
  };

  const response = await send(request);
  if (response.type !== "cancel") {
    throw new InvalidResponseError("cancel");
  }

  if (!response.success) {
    throw new CancelFailedError(response.error);
  }
}
