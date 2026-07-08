import { unloadModel } from '../plugins/ops/unload-model'
import { getRegistryStats } from '../runtime/model-registry'
import { hasActiveProviders } from '../p2p/swarm'
import type { UnloadModelRequest, UnloadModelResponse } from '../schemas'
import { getEngineLogger } from '../logging'

const logger = getEngineLogger()

export async function handleUnloadModel(request: UnloadModelRequest): Promise<UnloadModelResponse> {
  const { modelId, clearStorage } = request
  try {
    logger.debug('Unloading model', modelId)
    await unloadModel({ modelId, clearStorage })

    const stats = getRegistryStats()
    const modelsActive = stats.totalModels > 0
    const providersActive = hasActiveProviders()

    return {
      type: 'unloadModel',
      success: true,
      hasActiveModels: modelsActive,
      hasActiveProviders: providersActive
    }
  } catch (error) {
    logger.error('Error during model unload:', error)
    return {
      type: 'unloadModel',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
