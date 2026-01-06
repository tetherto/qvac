import { send } from "@/client/rpc/rpc-client";
import { type CancelParams, type CancelRequest } from "@/schemas";
import { InvalidResponseError, CancelFailedError } from "@/utils/errors-client";

/**
 * Cancels an ongoing operation.
 *
 * @param params - The parameters for the cancellation
 * @param params.operation - The type of operation to cancel ("inference" or "download")
 * @param params.modelId - The model ID (required for inference cancellation)
 * @param params.downloadKey - The download key (required for download cancellation)
 * @param params.clearCache - If true, deletes the partial download file (default: false)
 * @throws {QvacErrorBase} When the response type is invalid or when the cancellation fails
 *
 * @example
 * // Cancel inference
 * await cancel({ operation: "inference", modelId: "model-123" });
 *
 * @example
 * // Pause download (preserves partial file for automatic resume)
 * await cancel({ operation: "download", downloadKey: "download-key" });
 *
 * @example
 * // Cancel download completely (deletes partial file)
 * await cancel({ operation: "download", downloadKey: "download-key", clearCache: true });
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
