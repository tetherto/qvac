import type { DeleteCacheRequest, DeleteCacheResponse } from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidDeleteCacheParamsError, DeleteCacheFailedError } from '@/utils/errors-client'

/**
 * Deletes KV cache files, or a registry model's cached download.
 *
 * @throws {QvacErrorBase} When the cache parameters are invalid (`InvalidDeleteCacheParamsError`) or the server reports a delete failure (`DeleteCacheFailedError`).
 */
export async function deleteCache(
  params:
    { all: true } | { auto: true } | { kvCacheKey: string; modelId?: string } | { modelSrc: string }
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
  } else if ('modelSrc' in params) {
    req = {
      type: 'deleteCache',
      modelSrc: params.modelSrc
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
