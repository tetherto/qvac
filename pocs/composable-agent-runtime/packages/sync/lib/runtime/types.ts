import type { LogLevel } from '@qvac/logging'
import type * as T from '../../spec/rpc/hyperschema/types.d.ts'

export interface SyncBootstrapNode {
  readonly host: string
  readonly port: number
}

export interface CreateSyncOptions {
  readonly storagePath: string
  readonly bootstrap?: ReadonlyArray<SyncBootstrapNode>
  readonly meshSeed?: Buffer
  readonly meshKey?: Buffer
  readonly pairingInvite?: Buffer
  readonly logging?: { readonly level?: LogLevel }
}

export interface SyncRuntime {
  readonly exited: Promise<SyncRuntimeExit>
  ready(): Promise<void>
  suspend(): Promise<void>
  resume(): Promise<void>
  close(): Promise<void>
  readonly lifecycle: {
    suspend(): Promise<void>
    resume(): Promise<void>
  }
  readonly runtime: {
    describe(): Promise<T.RpcRuntimeInfo>
    status(): Promise<T.RpcRuntimeStatus>
    diagnostics(): Promise<SyncRuntimeDiagnostics>
  }
  readonly mesh: {
    identity(): Promise<{ deviceId: Buffer }>
    status(): Promise<SyncMeshStatus>
    watchStatus(options?: { readonly signal?: AbortSignal }): AsyncIterable<SyncMeshStatus>
    createInvite(options?: {
      readonly expiresInMs?: number
    }): Promise<T.RpcPairingInvite>
    watchPairingRequests(): AsyncIterable<T.RpcPairingRequestList>
    approvePairingRequest(id: Buffer): Promise<T.RpcPairingRequest>
    rejectPairingRequest(id: Buffer): Promise<T.RpcPairingRequest>
    join(invite: Buffer): Promise<void>
    cancelJoin(): Promise<void>
    leave(): Promise<void>
    listDevices(): Promise<readonly SyncMeshDevice[]>
    watchDevices(): AsyncIterable<readonly SyncMeshDevice[]>
    renameDevice(name: string): Promise<SyncMeshDevice>
    removeDevice(id: Buffer): Promise<void>
  }
  openProfile<Command, Query, Result, Change = Result>(
    profile: SyncProfileContract<Command, Query, Result, Change>
  ): SyncProfileClient<Command, Query, Result, Change>
}

export interface SyncRuntimeExit {
  readonly kind: 'closed' | 'crashed'
  readonly code: number | null
  readonly signal: string | null
}

export type SyncMeshStatus = T.RpcMeshStatus

export type SyncMeshDevice = T.RpcDevice

export interface SyncRuntimeDiagnostics {
  readonly children: ReadonlyArray<
    Omit<
      T.RpcRuntimeChildDiagnostic,
      'networkInstanceId' | 'topicPresent' | 'discoveryTeardownComplete'
    > & {
      readonly info?: {
        readonly networkInstanceId?: string | null
        readonly topicPresent?: boolean | null
        readonly discoveryTeardownComplete?: boolean | null
      }
    }
  >
}

export interface SyncProfileContract<Command, Query, Result, Change = Result> {
  readonly id: string
  readonly version: number
  readonly capabilities: readonly string[]
  readonly visibility: 'mesh-wide'
  readonly types?: {
    readonly command: Command
    readonly query: Query
    readonly result: Result
    readonly change: Change
  }
}

export type SyncWatchFrame<Value, Change> =
  | {
      readonly kind: 'snapshot'
      readonly generation: string
      readonly cursor: string
      readonly value: Value
    }
  | {
      readonly kind: 'change'
      readonly generation: string
      readonly cursor: string
      readonly change: Change
    }

export interface SyncProfileClient<Command, Query, Result, Change = Result> {
  apply(
    command: Command,
    options: {
      readonly operationId: string
      readonly expectedRevision?: string
      readonly traceId?: string
    }
  ): Promise<{ revision: string }>
  query(query: Query): Promise<Result>
  watch(
    query: Query,
    options?: {
      readonly after?: string
      readonly signal?: AbortSignal
    }
  ): AsyncIterable<SyncWatchFrame<Result, Change>>
}
