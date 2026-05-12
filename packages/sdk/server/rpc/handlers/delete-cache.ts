import type { DeleteCacheRequest, DeleteCacheResponse } from "@/schemas";
import { deleteKvCacheState } from "@/server/bare/plugins/llamacpp-completion/ops/kv-cache-session";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

/**
 * RPC handler for `deleteCache(...)`. The three KV-cache bookkeeping
 * layers (on-disk `.bin`, `initializedCaches`, `cachedMessageCounts`)
 * are private to `kv-cache-session.ts`; this handler delegates to that
 * module's single administrative entry point (`deleteKvCacheState`).
 * The handler must have **zero** direct references to
 * `fsPromises.unlink`, the `initializedCaches` set, or the
 * `cachedMessageCounts` map.
 */
export async function handleDeleteCache(
  request: DeleteCacheRequest,
): Promise<DeleteCacheResponse> {
  try {
    if ("all" in request && request.all) {
      await deleteKvCacheState({ all: true });
    } else if ("kvCacheKey" in request) {
      await deleteKvCacheState({
        kvCacheKey: request.kvCacheKey,
        ...(request.modelId !== undefined && { modelId: request.modelId }),
      });
    }

    return {
      type: "deleteCache",
      success: true,
    };
  } catch (error) {
    logger.error("Error deleting cache:", error);
    return {
      type: "deleteCache",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
