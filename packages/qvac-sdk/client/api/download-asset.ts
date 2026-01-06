import { send, stream } from "@/client/rpc/rpc-client";
import {
  type DownloadAssetOptions as BaseDownloadAssetOptions,
  downloadAssetOptionsToRequestSchema,
} from "@/schemas";
import {
  DownloadAssetFailedError,
  StreamEndedError,
  InvalidResponseError,
} from "@/utils/errors-client";

export type DownloadAssetOptions = BaseDownloadAssetOptions;

/**
 * Downloads an asset (model file) without loading it into memory.
 *
 * This function is specifically designed for download-only operations and
 * doesn't accept runtime configuration options like modelConfig or delegate.
 * Use this for download-only operations instead of loadModel for better semantic clarity.
 *
 * @param options - Download configuration including:
 *   - assetSrc: The location from which the asset is downloaded (local path, remote URL, or Hyperdrive URL)
 *   - seed: Optional boolean for hyperdrive seeding
 *   - onProgress: Optional callback for download progress
 *
 * @returns Promise that resolves to the asset ID (either the provided assetSrc or a generated ID)
 *
 * @throws {QvacErrorBase} When asset download fails, with details in the error message
 * @throws {QvacErrorBase} When streaming ends unexpectedly (only when using onProgress)
 * @throws {QvacErrorBase} When receiving an invalid response type from the server
 *
 * @example
 * ```typescript
 * // Download model without loading
 * const assetId = await downloadAsset({
 *   assetSrc: "/path/to/model.gguf",
 *   seed: true
 * });
 *
 * // Download with progress tracking
 * const assetId = await downloadAsset({
 *   assetSrc: "pear://key123/model.gguf",
 *   onProgress: (progress) => {
 *     console.log(`Downloaded: ${progress.percentage}%`);
 *   }
 * });
 * ```
 */
export async function downloadAsset(
  options: DownloadAssetOptions,
): Promise<string> {
  const request = downloadAssetOptionsToRequestSchema.parse(options);

  if (options.onProgress) {
    // Use streaming for progress updates
    for await (const response of stream(request)) {
      if (response.type === "modelProgress") {
        options.onProgress(response);
      } else if (response.type === "downloadAsset") {
        if (!response.success) {
          throw new DownloadAssetFailedError(response.error);
        }

        return response.assetId!;
      }
    }
    throw new StreamEndedError();
  } else {
    // Use regular send for simple downloading
    const response = await send(request);
    if (response.type !== "downloadAsset") {
      throw new InvalidResponseError("downloadAsset");
    }

    if (!response.success) {
      throw new DownloadAssetFailedError(response.error);
    }

    return response.assetId!;
  }
}
