import type { CancelRequest, CancelResponse } from "@/schemas/cancel";
import { cancel } from "@/server/bare/ops/cancel";
import { cancelTransfer } from "@/server/rpc/handlers/load-model/download-manager";
import {
  getActiveRagRequest,
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
        // (decoder / OCR / TTS). The registry-routed path inside
        // `cancel()` is already synchronous w.r.t. the abort, so the
        // await is a no-op for completion-stream's signal-driven
        // cancel.
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
          // info-level (not debug) because the decorated-promise pattern
          // makes "no in-flight match" a common and user-visible case:
          // a Stop button fired after the request settled but before the
          // UI cleared lands here. Users debugging "my Stop button isn't
          // working" need this visible without lowering the log level.
          logger.info(
            `[cancel] no in-flight request matched requestId=${request.requestId}`,
          );
        }
        break;
      }
      case "downloadAsset":
        // Deprecated cancel arm. `downloadAsset` is registry-migrated
        // and the primary cancel path is now
        // `cancel({ operation: "request", requestId })`. This case
        // stays for wire-compat with older clients; `cancelTransfer(...)`
        // in download-manager.ts routes each subscriber through
        // `registry.cancel({ requestId })` so the behaviour is
        // equivalent to a broad per-`downloadKey` cancel.
        logger.warn(
          "[cancel] `cancel({ operation: \"downloadAsset\", downloadKey })` is deprecated — use `cancel({ requestId })` against the value exposed on the `loadModel(...)` / `downloadAsset(...)` promise instead. This compat path is scheduled for removal in a future release.",
        );
        cancelTransfer(request.downloadKey, request.clearCache);
        break;
      case "rag": {
        // Deprecated cancel arm. RAG is registry-migrated with
        // workspace-level admission in the dispatcher (`rag.ts`).
        // Primary cancel path is
        // `cancel({ operation: "request", requestId })`. This arm
        // stays for wire-compat — it walks the workspace→requestId map
        // installed by the dispatcher and routes via the registry.
        logger.warn(
          "[cancel] `cancel({ operation: \"rag\", workspace })` is deprecated — use `cancel({ requestId })` instead. This compat path is scheduled for removal in a future release.",
        );
        const workspace = request.workspace ?? DEFAULT_WORKSPACE;
        const requestId = getActiveRagRequest(workspace);
        if (requestId === undefined) {
          logger.warn(
            `No active RAG operation to cancel for workspace: ${workspace}`,
          );
        } else {
          getRequestRegistry().cancel({
            requestId,
            reason: "rag-workspace-cancel",
          });
        }
        break;
      }
      default: {
        // Exhaustiveness guard: if the `CancelRequest` union ever grows a
        // new `operation` and this switch isn't updated, TypeScript fails
        // here at compile time. At runtime the zod discriminated union in
        // `cancelRequestSchema` is upstream, so reaching this branch means
        // the schema and the handler have drifted — surface the
        // mismatch as an explicit failure rather than a silent
        // `success: true` no-op.
        const _exhaustive: never = request;
        void _exhaustive;
        const op = (request as { operation?: string }).operation ?? "unknown";
        logger.error(`[cancel] unhandled cancel operation: ${op}`);
        return {
          type: "cancel",
          success: false,
          error: `Unhandled cancel operation: ${op}`,
        };
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
