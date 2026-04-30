import { sdkLoadModel, sdkUnloadModel, sdkClose } from './sdk.js'
import type { ModelRegistry, ServeConfig } from './model-registry.js'
import type { Logger } from '../../logger.js'

export async function preloadModels (serveConfig: ServeConfig, registry: ModelRegistry, logger: Logger): Promise<void> {
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
      await loadModel(alias, registry, logger)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to preload "${alias}": ${message}`)
    }
  }
}

export async function loadModel (alias: string, registry: ModelRegistry, logger: Logger): Promise<void> {
  const entry = registry.getEntry(alias)
  if (!entry) throw new Error(`Model "${alias}" not registered`)

  if (entry.state === registry.STATES.READY) {
    logger.debug(`Model "${alias}" already loaded.`)
    return
  }

  if (entry.state === registry.STATES.LOADING) {
    logger.debug(`Model "${alias}" is already loading, skipping.`)
    return
  }

  logger.info(`Loading model "${alias}" from ${entry.src}...`)
  registry.setLoading(alias)

  try {
    const sdkModelId = await sdkLoadModel({
      src: entry.src,
      type: entry.sdkType,
      config: entry.config
    })
    registry.setReady(alias, sdkModelId)
    logger.info(`Model "${alias}" loaded (SDK modelId: ${sdkModelId}).`)
  } catch (err) {
    registry.setError(alias, err)
    throw err
  }
}

export async function unloadModel (alias: string, registry: ModelRegistry, logger: Logger): Promise<void> {
  const entry = registry.getEntry(alias)
  if (!entry) throw new Error(`Model "${alias}" not found`)

  if (entry.sdkModelId) {
    try {
      await sdkUnloadModel(entry.sdkModelId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`SDK unload for "${alias}" failed: ${message}`)
      registry.setError(alias, err)
      throw new Error(`Failed to unload model "${alias}": ${message}`)
    }
  }

  registry.remove(alias)
  logger.info(`Unloaded model "${alias}".`)
}

export async function shutdownSDK (logger: Logger): Promise<void> {
  try {
    await sdkClose()
    logger.info('SDK connection closed.')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`SDK close error: ${message}`)
  }
}
