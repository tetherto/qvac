import { unloadModel } from '@/plugins/ops/unload-model'
import { getRegistryStats } from '@/runtime/model-registry'
import { hasOpenSessions } from '@/runtime/session-registry'
import { resolveSessionId } from '@/runtime/session-id'
import type { UnloadModelRequest, UnloadModelResponse } from '@/schemas/index'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

export async function handleUnloadModel(request: UnloadModelRequest): Promise<UnloadModelResponse> {
  const { modelId, clearStorage } = request
  const sessionId = resolveSessionId(request)
  try {
    logger.debug('Unloading model', modelId)
    const { released, unloaded } = await unloadModel({ modelId, clearStorage, sessionId })

    const stats = getRegistryStats()

    return {
      type: 'unloadModel',
      success: true,
      hasActiveModels: stats.totalModels > 0,
      hasOpenSessions: hasOpenSessions(),
      released,
      unloaded
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
