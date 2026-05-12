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

export async function cancelHandler(
  request: CancelRequest,
): Promise<CancelResponse> {
  try {
    switch (request.operation) {
      case "inference":
        // Awaited so the RPC response resolves after the addon has
        // acknowledged the cancel for non-registry-migrated handlers
        // (embeddings / transcription / translation / decoder / OCR / TTS
        // until M3b/M3c). The registry-routed path inside `cancel()` is
        // already synchronous w.r.t. the abort, so the await is a no-op
        // for completion-stream's signal-driven cancel.
        await cancel({ modelId: request.modelId }, { kind: "completion" });
        break;
      case "embeddings":
        await cancel({ modelId: request.modelId }, { kind: "embeddings" });
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
