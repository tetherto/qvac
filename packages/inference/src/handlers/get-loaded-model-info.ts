import type {
  GetLoadedModelInfoRequest,
  GetLoadedModelInfoResponse,
  LoadedModelInfo
} from '../schemas/index.ts'
import { getModelEntry } from '../runtime/model-registry.ts'
import { getPlugin } from '../plugins/registry.ts'
import { detectToolDialectFromName } from '../utils/tools/index.ts'
import { ModelNotFoundError } from '../errors/index.ts'
import { getEngineLogger } from '../logging/index.ts'

const logger = getEngineLogger()

export function handleGetLoadedModelInfo(
  request: GetLoadedModelInfoRequest
): GetLoadedModelInfoResponse {
  const { modelId } = request

  const entry = getModelEntry(modelId)
  if (!entry) {
    throw new ModelNotFoundError(modelId)
  }

  if (entry.isDelegated) {
    const info: LoadedModelInfo = {
      modelId: entry.id,
      isDelegated: true,
      handlers: [],
      providerInfo: {
        providerPublicKey: entry.delegated.providerPublicKey
      }
    }
    return { type: 'getLoadedModelInfo', info }
  }

  const plugin = getPlugin(entry.local.modelType)
  if (!plugin) {
    logger.warn(
      `getLoadedModelInfo: no plugin registered for modelType "${entry.local.modelType}" on loaded model "${modelId}"`
    )
  }

  const handlers = plugin ? Object.keys(plugin.handlers) : []

  const info: LoadedModelInfo = {
    modelId: entry.id,
    isDelegated: false,
    modelType: entry.local.modelType,
    handlers,
    loadedAt: entry.local.loadedAt,
    ...(plugin && { displayName: plugin.displayName }),
    ...(plugin && { addonPackage: plugin.addonPackage }),
    ...(entry.local.name && { name: entry.local.name }),
    ...(entry.local.path && { path: entry.local.path }),
    // Same detection the completion normalizer uses, so callers see the dialect it parses.
    ...(handlers.includes('completionStream') && {
      toolDialect: detectToolDialectFromName(entry.local.name, entry.local.path)
    })
  }

  return { type: 'getLoadedModelInfo', info }
}
