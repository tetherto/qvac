import type { LifecycleState } from '@qvac/sdk'
import type { ModelRegistry, ModelEntry } from '@/lib/api/core/model-registry'
import type { ServeConfig } from '@/lib/api/core/config/types'
import type { LoadManager, LoadModelFn } from '@/lib/api/core/load-manager'
import type { Logger } from '@/lib/logger'
import type { EphemeralFilesStore } from '@/lib/api/core/stores/ephemeral-files'

export interface QvacContext {
  registry: ModelRegistry
  serveConfig: ServeConfig
  loadManager: LoadManager
  logger: Logger
  /** Uploaded and generated files, addressable by `file_id` from every surface. */
  files: EphemeralFilesStore
  /** State owned by each mounted extension, keyed by extension name. */
  extensions: Partial<ServeExtensionState>
  /**
   * Last lifecycle state this server read from the SDK; anything but `active`
   * gates requests. `pending` counts suspend/resume calls in flight, and
   * `epoch` moves at each start and end of one, so a state read that began
   * before either cannot overwrite what the transition set.
   */
  runtime: { state: LifecycleState; pending: number; epoch: number }
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
