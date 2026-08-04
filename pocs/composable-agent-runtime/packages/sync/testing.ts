export { SyncClient } from './lib/client.ts'
export { SyncCore, type SyncCoreOptions } from './lib/core.ts'
export {
  spawnSync,
  SpawnedSyncClient,
  type SpawnSyncOptions,
  type SyncSidecarDiagnostics,
  type SyncSidecarExit
} from './lib/spawn.ts'
export { duplexPair } from './lib/transport/duplex-pair.ts'
