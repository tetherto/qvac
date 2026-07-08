import type { HeartbeatRequest, HeartbeatResponse } from '../schemas'
import { getEngineLogger } from '../logging'
import { getRPC } from './delegate-client'
import { send, type DelegateOptions } from './delegate-transport'
import { DelegateConnectionFailedError } from '../errors'
import type { DelegatedHandlerOptions } from '../engine/profiling'

const logger = getEngineLogger()

export async function handleHeartbeatDelegated(
  request: HeartbeatRequest,
  options?: DelegatedHandlerOptions
): Promise<HeartbeatResponse> {
  const { delegate } = request
  if (!delegate) {
    throw new DelegateConnectionFailedError(
      'Delegated heartbeat handler called without delegate info'
    )
  }

  const { providerPublicKey, timeout } = delegate

  try {
    const rpc = await getRPC(providerPublicKey, { timeout })

    const delegateOpts: DelegateOptions = {
      peerKey: providerPublicKey
    }
    if (timeout !== undefined) {
      delegateOpts.timeout = timeout
    }
    if (options?.profilingMeta) {
      delegateOpts.profilingMeta = options.profilingMeta
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { delegate: _delegate, ...providerRequest } = request
    const response = await send(providerRequest as HeartbeatRequest, rpc, delegateOpts)
    return response as HeartbeatResponse
  } catch (error) {
    logger.error('Error during delegated heartbeat:', error)
    throw error
  }
}
