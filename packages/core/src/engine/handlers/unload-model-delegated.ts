import type { UnloadModelRequest, UnloadModelResponse } from '../../schemas'
import { getModelEntry, unregisterModel, getRegistryStats } from '../state/model-registry'
import { getRPC } from '../delegate-client'
import { send } from '../delegate-transport'
import { hasActiveProviders } from '../swarm'
import { ModelIsDelegatedError } from '../../errors'
import { getServerLogger } from '../../logging'

const logger = getServerLogger()

export async function handleUnloadModelDelegated(
  request: UnloadModelRequest
): Promise<UnloadModelResponse> {
  const entry = getModelEntry(request.modelId)

  if (!entry?.isDelegated) {
    throw new ModelIsDelegatedError(request.modelId)
  }

  const { providerPublicKey, timeout, healthCheckTimeout } = entry.delegated

  unregisterModel(request.modelId)

  try {
    logger.info(
      `Sending delegated unload for model ${request.modelId} to provider: ${providerPublicKey}`
    )

    const rpc = await getRPC(providerPublicKey, { timeout, healthCheckTimeout })
    await send(
      { type: 'unloadModel' as const, modelId: request.modelId, clearStorage: false },
      rpc,
      { timeout, peerKey: providerPublicKey }
    )

    logger.info(`Delegated model ${request.modelId} unloaded on provider`)
  } catch (error) {
    logger.error(`Failed to unload delegated model ${request.modelId} on provider:`, error)
  }

  const stats = getRegistryStats()

  return {
    type: 'unloadModel',
    success: true,
    hasActiveModels: stats.totalModels > 0,
    hasActiveProviders: hasActiveProviders()
  }
}
