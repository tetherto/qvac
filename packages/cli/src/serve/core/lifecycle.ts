import { unloadModel as sdkUnloadModel, close as sdkClose } from '@qvac/sdk'
import type { LoadConfig, ModelRegistry, ServeConfig } from '@/serve/core/model-registry'
import type { LoadManager } from '@/serve/core/load-manager'
import type { Logger } from '@/logger'

export interface PreloadResult {
  /** Number of models marked `preload` that were attempted. */
  attempted: number
  /** How many of them reached READY. */
  loaded: number
}

// Render an error and its `cause` chain: RPC-init failures carry the worker's
// stderr (missing addon, bad `.so`) on `cause`.
export function formatErrorChain(err: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    parts.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  if (current !== undefined && current !== null && !(current instanceof Error)) {
    parts.push(String(current))
  }
  return parts.join('\n  caused by: ')
}

// Refuse to start only when lazy loading is off and every preload model failed:
// preloaded models are then the only ones that can serve.
export function shouldRefuseStart(load: Pick<LoadConfig, 'lazy'>, preload: PreloadResult): boolean {
  return !load.lazy && preload.attempted > 0 && preload.loaded === 0
}

export async function preloadModels(
  serveConfig: ServeConfig,
  registry: ModelRegistry,
  logger: Logger,
  loadManager: LoadManager
): Promise<PreloadResult> {
  const toPreload: string[] = []

  for (const [alias, entry] of serveConfig.models) {
    registry.register(alias, entry)
    if (entry.preload) {
      toPreload.push(alias)
    }
  }

  if (toPreload.length === 0) {
    logger.info('No models configured for preload.')
    return { attempted: 0, loaded: 0 }
  }

  logger.info(`Preloading ${toPreload.length} model(s): ${toPreload.join(', ')}`)

  let loaded = 0
  for (const alias of toPreload) {
    try {
      // No signal: a preload is a permanent waiter, never disconnect-cancelled.
      await loadManager.load(alias)
      loaded++
    } catch (err) {
      logger.error(`Failed to preload "${alias}": ${formatErrorChain(err)}`)
    }
  }

  return { attempted: toPreload.length, loaded }
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
