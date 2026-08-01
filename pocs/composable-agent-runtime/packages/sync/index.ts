export interface SyncRuntimeHandshake {
  readonly contract: 'qvac.sync'
  readonly protocolVersion: number
  readonly capabilities: readonly string[]
  readonly requiredPeerCapabilities: readonly string[]
  readonly buildVersion: string
}

export const SYNC_HANDSHAKE = {
  contract: 'qvac.sync',
  protocolVersion: 1,
  capabilities: [
    'local-profile',
    'tasks',
    'task-watches',
    'passive-replication',
    'writer-pairing'
  ],
  requiredPeerCapabilities: [],
  buildVersion: '0.0.0-poc'
} satisfies SyncRuntimeHandshake

export { SyncClient } from './lib/client.ts'
export { SyncCore, type SyncCoreOptions } from './lib/core.ts'
export { createReactNativeSyncLauncher, createSyncRuntimeArgs } from './lib/react-native-launcher.ts'
export {
  spawnSync,
  SpawnedSyncClient,
  type SpawnSyncOptions,
  type SyncSidecarDiagnostics,
  type SyncSidecarExit
} from './lib/spawn.ts'
export type { Capabilities as SyncCapabilities } from './spec/rpc/capabilities.d.ts'
export type {
  RpcPairingInvite as SyncPairingInvite,
  RpcPairingRequest as SyncPairingRequest,
  RpcPairingStatus as SyncPairingStatus,
  RpcTask as SyncTask,
  RpcTaskStatus as SyncTaskStatus,
  RpcUserProfile as SyncUserProfile
} from './spec/rpc/hyperschema/types.d.ts'
