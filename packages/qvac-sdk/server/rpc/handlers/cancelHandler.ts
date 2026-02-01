import type { CancelRequest, CancelResponse } from "@/schemas/cancel";
import { cancel } from "@/server/bare/addons";
import { createCancelFunction } from "@/server/rpc/handlers/load-model/download-manager";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function cancelHandler(
  request: CancelRequest,
): Promise<CancelResponse> {
  try {
    switch (request.operation) {
      case "inference":
        await cancel({ modelId: request.modelId });
        break;
      case "downloadAsset":
        const cancelDownload = createCancelFunction(
          request.downloadKey,
          request.clearCache,
        );
        cancelDownload();
        break;
    }

    return {
      type: "cancel",
      success: true,
    };
  } catch (error) {
    logger.error("Error during cancellation:", error);
    return {
      type: "cancel",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
