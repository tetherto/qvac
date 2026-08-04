import { createMobileSync } from './lib/runtime/create-sync-mobile.ts'
import {
  assertCompatibleRuntime,
  syncCompatibility
} from './lib/runtime/compatibility.ts'

export { createMobileSync as createSync }
export {
  assertCompatibleRuntime,
  syncCompatibility
}
export {
  SyncGenerationEndedError,
  SyncSuspendedError
} from './lib/runtime/errors.ts'

export type SyncClient = import('./lib/runtime/types.ts').SyncRuntime
export type SyncWatch<T> = AsyncIterable<T>

export const SYNC_HANDSHAKE = syncCompatibility

export type {
  CreateSyncOptions,
  SyncMeshDevice,
  SyncMeshStatus,
  SyncRuntime,
  SyncRuntimeExit
} from './lib/runtime/types.ts'
export type {
  SyncCompatibilityReport,
  SyncRuntimeHandshake
} from './lib/runtime/compatibility.ts'
export type {
  SyncErrorCategory,
  SyncErrorEnvelope
} from './lib/runtime/errors.ts'
export type {
  SyncProfileClient,
  SyncProfileContract,
  SyncWatchFrame
} from './lib/runtime/types.ts'
