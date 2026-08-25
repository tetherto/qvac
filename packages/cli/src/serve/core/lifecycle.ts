import { unloadModel as sdkUnloadModel, close as sdkClose } from '@qvac/sdk'
import type { ModelRegistry, ServeConfig } from './model-registry.js'
import type { LoadManager } from './load-manager.js'
import type { Logger } from '../../logger.js'

export async function preloadModels(
  serveConfig: ServeConfig,
  registry: ModelRegistry,
  logger: Logger,
  loadManager: LoadManager
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
      // No signal: a preload is a permanent waiter, never disconnect-cancelled.
      await loadManager.load(alias)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to preload "${alias}": ${message}`)
    }
  }
}

export async function unloadModel(
  alias: string,
  registry: ModelRegistry,
  logger: Logger,
  loadManager: LoadManager
): Promise<void> {
  const entry = registry.getEntry(alias)
  if (!entry) throw new Error(`Model "${alias}" not found`)

  // If a load is in flight, wait for it to settle first — otherwise we would
  // unload nothing (sdkModelId still null) and the in-flight load would set the
  // model back to READY right after DELETE reported success.
  if (loadManager.isLoading(alias)) {
    logger.info(`Waiting for in-flight load of "${alias}" to settle before unload...`)
    await loadManager.settled(alias)
  }

  const current = registry.getEntry(alias)
  if (current?.sdkModelId) {
    try {
      await sdkUnloadModel({ modelId: current.sdkModelId })
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
