import type { DeleteCacheRequest, DeleteCacheResponse } from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidDeleteCacheParamsError, DeleteCacheFailedError } from '@/utils/errors-client'

/**
 * Deletes KV cache files.
 *
 * @param params - The delete cache parameters
 * @param params.all - If true, deletes all cache files, including caller-owned named caches
 * @param params.auto - If true, reclaims only automatic caches (`completion({ kvCache: true })`) that no request is using. Named caches are untouched. Covers the whole cache directory, which is shared by every QVAC process using the same home directory
 * @param params.kvCacheKey - The cache key to delete
 * @param params.modelId - Optional: specific model ID to delete within the cache key. If not provided, deletes entire cache key.
 * @returns Promise resolving to success status
 * @throws {QvacErrorBase} When the cache parameters are invalid (`InvalidDeleteCacheParamsError`) or the server reports a delete failure (`DeleteCacheFailedError`).
 * @example
 * ```typescript
 * // Delete all caches
 * await deleteCache({ all: true });
 *
 * // Reclaim disk from automatic caches, leaving named caches alone
 * await deleteCache({ auto: true });
 *
 * // Delete entire cache key (all models)
 * await deleteCache({ kvCacheKey: "my-session" });
 *
 * // Delete only specific model within cache key
 * await deleteCache({ kvCacheKey: "my-session", modelId: "model-abc123" });
 * ```
 */
export async function deleteCache(
  params: { all: true } | { auto: true } | { kvCacheKey: string; modelId?: string }
) {
  let req: DeleteCacheRequest

  if ('all' in params && params.all) {
    req = {
      type: 'deleteCache',
      all: true
    }
  } else if ('auto' in params && params.auto) {
    req = {
      type: 'deleteCache',
      auto: true
    }
  } else if ('kvCacheKey' in params) {
    req = {
      type: 'deleteCache',
      kvCacheKey: params.kvCacheKey,
      modelId: params.modelId
    }
  } else {
    throw new InvalidDeleteCacheParamsError()
  }

  const response = (await send(req)) as DeleteCacheResponse

  if (!response.success && response.error) {
    throw new DeleteCacheFailedError(response.error)
  }

  return {
    success: response.success
  }
}
