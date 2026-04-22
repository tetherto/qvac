import type { CancelRequest, CancelResponse } from "@/schemas/cancel";
import { cancel } from "@/server/bare/ops/cancel";
import { cancelTransfer } from "@/server/rpc/handlers/load-model/download-manager";
import {
  cancelRagOperation,
  DEFAULT_WORKSPACE,
} from "@/server/bare/rag-hyperdb";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function cancelHandler(
  request: CancelRequest,
): Promise<CancelResponse> {
  try {
    switch (request.operation) {
      case "inference":
      case "embeddings":
        await cancel({ modelId: request.modelId });
        break;
      case "downloadAsset":
        cancelTransfer(request.downloadKey, request.clearCache);
        break;
      case "rag": {
        const cancelled = cancelRagOperation(request.workspace);
        if (!cancelled) {
          logger.warn(
            `No active RAG operation to cancel for workspace: ${request.workspace ?? DEFAULT_WORKSPACE}`,
          );
        }
        break;
      }
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
