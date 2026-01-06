import type { DeleteCacheRequest, DeleteCacheResponse } from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import {
  InvalidDeleteCacheParamsError,
  DeleteCacheFailedError,
} from "@/utils/errors-client";

/**
 * Deletes KV cache files.
 *
 * @param params - The delete cache parameters
 * @param params.all - If true, deletes all cache files
 * @param params.kvCacheKey - The cache key to delete
 * @param params.modelId - Optional: specific model ID to delete within the cache key. If not provided, deletes entire cache key.
 * @returns Promise resolving to success status
 * @example
 * ```typescript
 * // Delete all caches
 * await deleteCache({ all: true });
 *
 * // Delete entire cache key (all models)
 * await deleteCache({ kvCacheKey: "my-session" });
 *
 * // Delete only specific model within cache key
 * await deleteCache({ kvCacheKey: "my-session", modelId: "model-abc123" });
 * ```
 */
export async function deleteCache(
  params: { all: true } | { kvCacheKey: string; modelId?: string },
) {
  let req: DeleteCacheRequest;

  if ("all" in params && params.all) {
    req = {
      type: "deleteCache",
      all: true,
    };
  } else if ("kvCacheKey" in params) {
    req = {
      type: "deleteCache",
      kvCacheKey: params.kvCacheKey,
      modelId: params.modelId,
    };
  } else {
    throw new InvalidDeleteCacheParamsError();
  }

  const response = (await send(req)) as DeleteCacheResponse;

  if (!response.success && response.error) {
    throw new DeleteCacheFailedError(response.error);
  }

  return {
    success: response.success,
  };
}
