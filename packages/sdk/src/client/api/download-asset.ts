import { send, stream } from '@/client/rpc/rpc-client'
import {
  type DownloadAssetOptions as BaseDownloadAssetOptions,
  type RPCOptions,
  downloadAssetOptionsToRequestSchema
} from '@qvac/inference/surface'
import {
  DownloadAssetFailedError,
  StreamEndedError,
  InvalidResponseError
} from '@/utils/errors-client'
import { decoratePromise } from '@/utils/decorate-promise'
import { parseClientInput } from '@/client/parse-input'
import { generateClientRequestId } from '@/client/api/client-request-id'

export type DownloadAssetOptions = BaseDownloadAssetOptions

/**
 * Downloads an asset (model file) without loading it into memory.
 *
 * @throws {QvacErrorBase} When asset download fails, with details in the error message
 *
 * @throws {QvacErrorBase} When streaming ends unexpectedly (only when using onProgress)
 *
 * @throws {QvacErrorBase} When receiving an invalid response type from the server
 */
export function downloadAsset(
  options: DownloadAssetOptions,
  rpcOptions?: RPCOptions
): Promise<string> & { requestId: string } {
  const requestId = generateClientRequestId()
  const inner = runDownloadAsset(options, requestId, rpcOptions)
  return decoratePromise(inner, { requestId })
}

async function runDownloadAsset(
  options: DownloadAssetOptions,
  requestId: string,
  rpcOptions?: RPCOptions
): Promise<string> {
  const request = parseClientInput(downloadAssetOptionsToRequestSchema, {
    ...options,
    requestId
  })

  if (options.onProgress) {
    // Use streaming for progress updates
    for await (const response of stream(request, rpcOptions)) {
      if (response.type === 'modelProgress') {
        options.onProgress(response)
      } else if (response.type === 'downloadAsset') {
        if (!response.success) {
          throw new DownloadAssetFailedError(response.error)
        }

        return response.assetId!
      }
    }
    throw new StreamEndedError()
  } else {
    // Use regular send for simple downloading
    const response = await send(request, rpcOptions)
    if (response.type !== 'downloadAsset') {
      throw new InvalidResponseError('downloadAsset')
    }

    if (!response.success) {
      throw new DownloadAssetFailedError(response.error)
    }

    return response.assetId!
  }
}
