export type SyncClient = import('./lib/runtime/types.ts').SyncRuntime
export type SyncWatch<T> = AsyncIterable<T>

export {
  type CreateSyncOptions,
  type SyncMeshDevice,
  type SyncMeshStatus,
  type SyncRuntime,
  type SyncRuntimeExit
} from './lib/runtime/types.ts'
export type {
  SyncNetworkState,
  SyncRuntimeDiagnostics,
  SyncRuntimePhase,
  SyncRuntimeStatus
} from './lib/runtime/runtime-handle.ts'
export {
  type SyncCompatibilityReport,
  type SyncRuntimeHandshake
} from './lib/runtime/compatibility.ts'
export {
  SyncGenerationEndedError,
  SyncSuspendedError,
  type SyncErrorCategory,
  type SyncErrorEnvelope
} from './lib/runtime/errors.ts'
export type {
  SyncProfileClient,
  SyncProfileContract,
  SyncWatchFrame
} from './lib/runtime/types.ts'

export const SYNC_HANDSHAKE: import('./lib/runtime/compatibility.ts').SyncRuntimeHandshake
export const syncCompatibility: import('./lib/runtime/compatibility.ts').SyncCompatibilityReport
export function assertCompatibleRuntime(
  local: import('./lib/runtime/compatibility.ts').SyncCompatibilityReport,
  remote: import('./lib/runtime/compatibility.ts').SyncCompatibilityReport
): void
export function createSync(
  options: import('./lib/runtime/types.ts').CreateSyncOptions
): import('./lib/runtime/types.ts').SyncRuntime
