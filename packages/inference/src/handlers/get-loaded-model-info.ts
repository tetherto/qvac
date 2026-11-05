import type {
  GetLoadedModelInfoRequest,
  GetLoadedModelInfoResponse,
  LoadedModelInfo
} from '@/schemas/index'
import { getModelEntry } from '@/runtime/model-registry'
import { getPlugin } from '@/plugins/registry'
import { detectToolDialect } from '@/utils/tool-integration'
import { ModelNotFoundError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

export function handleGetLoadedModelInfo(
  request: GetLoadedModelInfoRequest
): GetLoadedModelInfoResponse {
  const { modelId } = request

  const entry = getModelEntry(modelId)
  if (!entry) {
    throw new ModelNotFoundError(modelId)
  }

  const plugin = getPlugin(entry.local.modelType)
  if (!plugin) {
    logger.warn(
      `getLoadedModelInfo: no plugin registered for modelType "${entry.local.modelType}" on loaded model "${modelId}"`
    )
  }

  const handlers = plugin ? Object.keys(plugin.handlers) : []

  const fitProbe = entry.local.fitProbe

  const info: LoadedModelInfo = {
    modelId: entry.id,
    modelType: entry.local.modelType,
    handlers,
    loadedAt: entry.local.loadedAt,
    ...(plugin && { displayName: plugin.displayName }),
    ...(plugin && { addonPackage: plugin.addonPackage }),
    ...(entry.local.name && { name: entry.local.name }),
    ...(entry.local.path && { path: entry.local.path }),
    ...(handlers.includes('completionStream') && {
      toolDialect: detectToolDialect(modelId)
    }),
    ...(fitProbe !== undefined && { fitProbe })
  }

  return { type: 'getLoadedModelInfo', info }
}
