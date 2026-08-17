import {
  loadModel as sdkLoadModel,
  unloadModel as sdkUnloadModel,
  close as sdkClose
} from '@qvac/sdk'
import type { ModelConstant } from '@qvac/sdk'
import type { ModelRegistry, ServeConfig } from './model-registry.js'
import type { Logger } from '../../logger.js'

/** SDK loader, overridable in tests. `@qvac/sdk`'s `loadModel` is heavily
 * overloaded; this is the shape serve actually calls it with (a free-form
 * `modelType` string), returning a bare model-id promise. */
export type LoadModelFn = (opts: {
  modelSrc: string | ModelConstant
  modelType: string
  modelConfig: Record<string, unknown>
}) => Promise<string>

const defaultLoad: LoadModelFn = (opts) => sdkLoadModel(opts)

// Dedups concurrent loads of the same alias so the first request that names a
// `preload: false` model loads it once and every other in-flight request awaits
// the same load. Keyed by registry so servers sharing a process stay isolated.
const inflightLoads = new WeakMap<ModelRegistry, Map<string, Promise<void>>>()

function inflightFor(registry: ModelRegistry): Map<string, Promise<void>> {
  let map = inflightLoads.get(registry)
  if (!map) {
    map = new Map()
    inflightLoads.set(registry, map)
  }
  return map
}

export async function preloadModels(
  serveConfig: ServeConfig,
  registry: ModelRegistry,
  logger: Logger,
  loadOverride?: LoadModelFn
): Promise<void> {
  const toPreload: string[] = []

  for (const [alias, entry] of serveConfig.models) {
    registry.register(alias, entry)
    if (entry.preload) {
      toPreload.push(alias)
    }
  }

  if (toPreload.length === 0) {
    logger.info('No models configured for preload.')
    return
  }

  logger.info(`Preloading ${toPreload.length} model(s): ${toPreload.join(', ')}`)

  for (const alias of toPreload) {
    try {
      await loadModel(alias, registry, logger, loadOverride)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to preload "${alias}": ${message}`)
    }
  }
}

export function loadModel(
  alias: string,
  registry: ModelRegistry,
  logger: Logger,
  loadOverride?: LoadModelFn
): Promise<void> {
  const entry = registry.getEntry(alias)
  if (!entry) return Promise.reject(new Error(`Model "${alias}" not registered`))

  if (entry.state === registry.STATES.READY) {
    logger.debug(`Model "${alias}" already loaded.`)
    return Promise.resolve()
  }

  const pending = inflightFor(registry)
  const existing = pending.get(alias)
  if (existing) {
    logger.debug(`Model "${alias}" is already loading, awaiting in-flight load.`)
    return existing
  }

  const load = runLoad(alias, registry, logger, loadOverride ?? defaultLoad).finally(() => {
    pending.delete(alias)
  })
  pending.set(alias, load)
  return load
}

async function runLoad(
  alias: string,
  registry: ModelRegistry,
  logger: Logger,
  loadFn: LoadModelFn
): Promise<void> {
  const entry = registry.getEntry(alias)
  if (!entry) throw new Error(`Model "${alias}" not registered`)

  const displaySrc = typeof entry.modelSrc === 'string' ? entry.modelSrc : entry.modelSrc.src
  logger.info(`Loading model "${alias}" from ${displaySrc}...`)
  registry.setLoading(alias)

  try {
    const sdkModelId = await loadFn({
      modelSrc: entry.modelSrc,
      modelType: entry.sdkType,
      modelConfig: entry.config
    })
    registry.setReady(alias, sdkModelId)
    logger.info(`Model "${alias}" loaded (SDK modelId: ${sdkModelId}).`)
  } catch (err) {
    registry.setError(alias, err)
    throw err
  }
}

export async function unloadModel(
  alias: string,
  registry: ModelRegistry,
  logger: Logger
): Promise<void> {
  const entry = registry.getEntry(alias)
  if (!entry) throw new Error(`Model "${alias}" not found`)

  if (entry.sdkModelId) {
    try {
      await sdkUnloadModel({ modelId: entry.sdkModelId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`SDK unload for "${alias}" failed: ${message}`)
      registry.setError(alias, err)
      throw new Error(`Failed to unload model "${alias}": ${message}`)
    }
  }

  // Keep the alias registered (reset to IDLE) rather than removing it, so a
  // later request can lazy-reload it. Removing the entry would leave the alias
  // resolvable from config but unloadable — the original preload/lifecycle gap.
  registry.markUnloaded(alias)
  logger.info(`Unloaded model "${alias}".`)
}

export async function shutdownSDK(logger: Logger): Promise<void> {
  try {
    await sdkClose()
    logger.info('SDK connection closed.')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`SDK close error: ${message}`)
  }
}
