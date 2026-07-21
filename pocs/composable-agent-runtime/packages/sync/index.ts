import type { RuntimeHandshake } from '@qvac/runtime-contracts'

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
} satisfies RuntimeHandshake

export { SyncClient } from './lib/client.ts'
export { SyncCore, type SyncCoreOptions } from './lib/core.ts'
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
