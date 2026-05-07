import type { CancelRequest, CancelResponse } from "@/schemas/cancel";
import { cancel } from "@/server/bare/ops/cancel";
import { cancelTransfer } from "@/server/rpc/handlers/load-model/download-manager";
import {
  cancelRagOperation,
  DEFAULT_WORKSPACE,
} from "@/server/bare/rag-hyperdb";
import { getRequestRegistry } from "@/server/bare/runtime";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export function cancelHandler(
  request: CancelRequest,
): Promise<CancelResponse> {
  try {
    switch (request.operation) {
      case "inference":
        cancel({ modelId: request.modelId }, { kind: "completion" });
        break;
      case "embeddings":
        cancel({ modelId: request.modelId }, { kind: "embeddings" });
        break;
      case "request": {
        const cancelled = getRequestRegistry().cancel({
          requestId: request.requestId,
        });
        if (cancelled === 0) {
          logger.debug(
            `[cancel] no in-flight request matched requestId=${request.requestId}`,
          );
        }
        break;
      }
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

    return Promise.resolve({
      type: "cancel",
      success: true,
    });
  } catch (error) {
    logger.error("Error during cancellation:", error);
    return Promise.resolve({
      type: "cancel",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
