import type { ModelRegistry, ModelEntry } from '@/serve/core/model-registry'
import type { ServeConfig } from '@/serve/core/config/types'
import type { LoadManager, LoadModelFn } from '@/serve/core/load-manager'
import type { Logger } from '@/logger'

export interface QvacContext {
  registry: ModelRegistry
  serveConfig: ServeConfig
  loadManager: LoadManager
  logger: Logger
  /** State owned by each mounted extension, keyed by extension name. */
  extensions: Partial<ServeExtensionState>
  /** Test seam — overrides the SDK model load when set, so lazy-load and preload
   * can be exercised without a real (expensive) model load. Backed by an
   * accessor in `buildServer`, hence the explicit `| undefined`. */
  loadModelOverride?: LoadModelFn | undefined
}

/** Augmented by each extension with the state its routes read. */
// lunte-disable-next-line no-empty-interface
export interface ServeExtensionState {}

export interface QvacRequestModel {
  alias: string
  sdkModelId: string
  entry: ModelEntry
}
