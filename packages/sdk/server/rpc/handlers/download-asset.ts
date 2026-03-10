import type {
  DownloadAssetRequest,
  DownloadAssetResponse,
  ModelProgressUpdate,
} from "@/schemas";
import { resolveModelPath } from "@/server/rpc/handlers/load-model/resolve";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function handleDownloadAsset(
  request: DownloadAssetRequest,
  progressCallback?: (update: ModelProgressUpdate) => void,
): Promise<DownloadAssetResponse> {
  const { assetSrc, seed } = request;

  try {
    await resolveModelPath(assetSrc, progressCallback, seed);

    return {
      type: "downloadAsset",
      success: true,
      assetId: assetSrc,
    };
  } catch (error: unknown) {
    logger.error("Error downloading asset:", error);
    return {
      type: "downloadAsset",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
