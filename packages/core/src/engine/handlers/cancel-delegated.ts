import type { CancelRequest, CancelResponse } from '../../schemas/cancel'
import { getServerLogger } from '../../logging'
import { getModelEntry } from '../state/model-registry'
import { getRPC } from '../delegate-client'
import { send, type DelegateOptions } from '../delegate-transport'
import type { DelegatedHandlerOptions } from '../profiling'

const logger = getServerLogger()

type DelegationTarget = {
  providerPublicKey: string
  timeout?: number
}

/**
 * Resolve the delegated provider for a cancel request, if any.
 *
 * The cancel envelope has two operations. Only `broad` cancels delegate
 * at the cancel layer — see `isCancelDelegated` in `handler-registry.ts`
 * for the policy and the rationale.
 *
 * The targeted `request` arm is handled locally because the registry
 * is process-singleton and already holds the entry for delegated
 * requests (the delegated handler registers its own context on the
 * provider-facing side). To cancel a specific delegated request, hold
 * onto the delegated `loadModel(...).requestId` and fire a broad cancel
 * against the model id instead.
 */
function resolveDelegationTarget(request: CancelRequest): DelegationTarget | null {
  if (request.operation !== 'broad') return null

  const entry = getModelEntry(request.modelId)
  if (!entry?.isDelegated) return null

  const target: DelegationTarget = {
    providerPublicKey: entry.delegated.providerPublicKey
  }
  if (entry.delegated.timeout !== undefined) {
    target.timeout = entry.delegated.timeout
  }
  return target
}

export async function handleCancelDelegated(
  request: CancelRequest,
  options?: DelegatedHandlerOptions
): Promise<CancelResponse> {
  const target = resolveDelegationTarget(request)
  if (!target) {
    logger.warn(`Delegated cancel skipped (no delegation target): operation=${request.operation}`)
    return { type: 'cancel', success: true }
  }

  try {
    const rpc = await getRPC(target.providerPublicKey, {
      timeout: target.timeout
    })

    const delegateOpts: DelegateOptions = {
      peerKey: target.providerPublicKey
    }
    if (target.timeout !== undefined) {
      delegateOpts.timeout = target.timeout
    }
    if (options?.profilingMeta) {
      delegateOpts.profilingMeta = options.profilingMeta
    }

    await send(request, rpc, delegateOpts)
    return { type: 'cancel', success: true }
  } catch (error) {
    logger.error('Error during delegated cancellation:', error)
    return {
      type: 'cancel',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
