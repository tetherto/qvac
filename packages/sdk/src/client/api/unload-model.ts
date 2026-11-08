import { isBare } from 'which-runtime'
import { type UnloadModelRequest, type UnloadModelParams } from '@qvac/inference/surface'
import { send, close } from '@/client/rpc/rpc-client'
import { stopLoggingStreamForModel } from '@/client/logging-stream-registry'
import { InvalidResponseError, ModelUnloadFailedError } from '@/utils/errors-client'
import { getClientLogger } from '@/logging'

const logger = getClientLogger()

/**
 * Unloads a previously loaded model from the server.
 *
 * @throws {QvacErrorBase} When the response type is invalid or when the unload operation fails
 */
export async function unloadModel(params: UnloadModelParams) {
  const request: UnloadModelRequest = {
    type: 'unloadModel',
    modelId: params.modelId,
    clearStorage: params.clearStorage ?? false
  }

  const response = await send(request)
  if (response.type !== 'unloadModel') {
    throw new InvalidResponseError('unloadModel')
  }

  if (!response.success) {
    throw new ModelUnloadFailedError(params.modelId)
  }

  stopLoggingStreamForModel(params.modelId)

  const shouldAutoClose = params.autoClose ?? !isBare
  if (shouldAutoClose && response.hasActiveModels === false) {
    logger.info('🧹 No models active, automatically closing RPC connection...')
    await close()
  }
}
