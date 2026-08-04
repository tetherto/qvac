import { syncCompatibility } from './lib/runtime/compatibility.ts'
import type { SyncRuntimeHandshake } from './lib/runtime/compatibility.ts'

export type SyncClient = import('./lib/runtime/create-sync.ts').SyncRuntime
export type SyncWatch<T> = AsyncIterable<T>

export const SYNC_HANDSHAKE =
  syncCompatibility satisfies SyncRuntimeHandshake

export {
  createSync,
  type CreateSyncOptions,
  type SyncMeshDevice,
  type SyncMeshStatus,
  type SyncRuntime,
  type SyncRuntimeExit
} from './lib/runtime/create-sync.ts'
export type {
  SyncNetworkState,
  SyncRuntimeDiagnostics,
  SyncRuntimePhase,
  SyncRuntimeStatus
} from './lib/runtime/runtime-handle.ts'
export {
  assertCompatibleRuntime,
  syncCompatibility,
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
} from './lib/profiles/profile-client.ts'
