import { isBare } from 'which-runtime'
import {
  type UnloadModelRequest,
  type UnloadModelParams,
  type RPCOptions
} from '@qvac/inference/surface'
import { send, close } from '@/client/rpc/rpc-client'
import { stopLoggingStreamForModel } from '@/client/logging-stream-registry'
import { InvalidResponseError, ModelUnloadFailedError } from '@/utils/errors-client'
import { getClientLogger } from '@/logging'

const logger = getClientLogger()

export interface UnloadModelResult {
  /** The caller's lease on the model was released. */
  released: boolean
  /** The model left memory. False while another session still holds it. */
  unloaded: boolean
}

/**
 * Releases the caller's hold on a loaded model. The model leaves memory once
 * no caller session holds it; a session that shares the model with another
 * only drops its own lease.
 *
 * When the owner unloads the last model and no caller session is open, this
 * function automatically closes the RPC connection on Node/Electron, allowing
 * the process to exit naturally without requiring manual cleanup. On Bare the
 * connection is left open by default so long-lived workers survive a routine
 * unload; pass `autoClose: true` to opt in to closing. A session never closes
 * the runtime.
 *
 * @param params - The parameters for unloading the model
 * @param params.modelId - The unique identifier of the model to unload
 * @param params.clearStorage - Whether to clear the storage for the model
 * @param params.autoClose - Override the runtime-default auto-close behavior
 * @param options - Optional RPC options (timeout, profiling, force new connection).
 * @throws {QvacErrorBase} When the response type is invalid or when the unload operation fails
 */
export async function unloadModel(
  params: UnloadModelParams,
  options?: RPCOptions
): Promise<UnloadModelResult> {
  const request: UnloadModelRequest = {
    type: 'unloadModel',
    modelId: params.modelId,
    clearStorage: params.clearStorage ?? false
  }

  const response = await send(request, options)
  if (response.type !== 'unloadModel') {
    throw new InvalidResponseError('unloadModel')
  }

  if (!response.success) {
    throw new ModelUnloadFailedError(params.modelId)
  }

  if (response.unloaded !== false) stopLoggingStreamForModel(params.modelId)

  const isOwnerCall = options?.sessionId === undefined
  const shouldAutoClose = isOwnerCall && (params.autoClose ?? !isBare)
  if (shouldAutoClose && response.hasActiveModels === false && response.hasOpenSessions !== true) {
    logger.info('🧹 No models active, automatically closing RPC connection...')
    await close()
  }

  return { released: response.released ?? true, unloaded: response.unloaded ?? true }
}
