// Generated from schema/sync.ts. Do not edit.

import type * as T from './hyperschema/types.d.ts'

export interface WatchStream<T> extends AsyncIterable<T> {
  on(event: 'data', listener: (value: T) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  destroy(): void
}

export interface Capabilities {
  getIdentity(input?: T.RpcEmpty): Promise<T.RpcIdentity>
  describeRuntime(input?: T.RpcEmpty): Promise<T.RpcRuntimeInfo>
  runtimeStatus(input?: T.RpcEmpty): Promise<T.RpcRuntimeStatus>
  runtimeDiagnostics(input?: T.RpcEmpty): Promise<T.RpcRuntimeDiagnostics>
  suspend(input?: T.RpcEmpty): Promise<T.RpcOk>
  resume(input?: T.RpcEmpty): Promise<T.RpcOk>
  meshStatus(input?: T.RpcEmpty): Promise<T.RpcMeshStatus>
  watchMeshStatus(input?: T.RpcEmpty): WatchStream<T.RpcMeshStatus>
  joinMesh(input: T.RpcMeshJoinRequest): Promise<T.RpcOk>
  cancelMeshJoin(input?: T.RpcEmpty): Promise<T.RpcOk>
  leaveMesh(input?: T.RpcEmpty): Promise<T.RpcOk>
  listDevices(input?: T.RpcEmpty): Promise<T.RpcDeviceList>
  watchDevices(input?: T.RpcEmpty): WatchStream<T.RpcDeviceList>
  renameDevice(input: T.RpcRenameDeviceRequest): Promise<T.RpcDevice>
  removeDevice(input: T.RpcRemoveDeviceRequest): Promise<T.RpcOk>
  createPairingInvite(input: T.RpcCreatePairingInviteRequest): Promise<T.RpcPairingInvite>
  approvePairingRequest(input: T.RpcPairingRequestId): Promise<T.RpcPairingRequest>
  rejectPairingRequest(input: T.RpcPairingRequestId): Promise<T.RpcPairingRequest>
  watchPairingRequests(input?: T.RpcEmpty): WatchStream<T.RpcPairingRequestList>
  applyProfile(input: T.RpcProfileApplyRequest): Promise<T.RpcProfileApplyResult>
  queryProfile(input: T.RpcProfileQueryRequest): Promise<T.RpcProfileQueryResult>
  watchProfile(input: T.RpcProfileWatchRequest): WatchStream<T.RpcProfileWatchFrame>
}

export interface CapabilityHandlers {
  getIdentity(input: T.RpcEmpty): T.RpcIdentity | Promise<T.RpcIdentity>
  describeRuntime(input: T.RpcEmpty): T.RpcRuntimeInfo | Promise<T.RpcRuntimeInfo>
  runtimeStatus(input: T.RpcEmpty): T.RpcRuntimeStatus | Promise<T.RpcRuntimeStatus>
  runtimeDiagnostics(input: T.RpcEmpty): T.RpcRuntimeDiagnostics | Promise<T.RpcRuntimeDiagnostics>
  suspend(input: T.RpcEmpty): T.RpcOk | Promise<T.RpcOk>
  resume(input: T.RpcEmpty): T.RpcOk | Promise<T.RpcOk>
  meshStatus(input: T.RpcEmpty): T.RpcMeshStatus | Promise<T.RpcMeshStatus>
  watchMeshStatus(input: T.RpcEmpty): AsyncIterable<T.RpcMeshStatus>
  joinMesh(input: T.RpcMeshJoinRequest): T.RpcOk | Promise<T.RpcOk>
  cancelMeshJoin(input: T.RpcEmpty): T.RpcOk | Promise<T.RpcOk>
  leaveMesh(input: T.RpcEmpty): T.RpcOk | Promise<T.RpcOk>
  listDevices(input: T.RpcEmpty): T.RpcDeviceList | Promise<T.RpcDeviceList>
  watchDevices(input: T.RpcEmpty): AsyncIterable<T.RpcDeviceList>
  renameDevice(input: T.RpcRenameDeviceRequest): T.RpcDevice | Promise<T.RpcDevice>
  removeDevice(input: T.RpcRemoveDeviceRequest): T.RpcOk | Promise<T.RpcOk>
  createPairingInvite(input: T.RpcCreatePairingInviteRequest): T.RpcPairingInvite | Promise<T.RpcPairingInvite>
  approvePairingRequest(input: T.RpcPairingRequestId): T.RpcPairingRequest | Promise<T.RpcPairingRequest>
  rejectPairingRequest(input: T.RpcPairingRequestId): T.RpcPairingRequest | Promise<T.RpcPairingRequest>
  watchPairingRequests(input: T.RpcEmpty): AsyncIterable<T.RpcPairingRequestList>
  applyProfile(input: T.RpcProfileApplyRequest): T.RpcProfileApplyResult | Promise<T.RpcProfileApplyResult>
  queryProfile(input: T.RpcProfileQueryRequest): T.RpcProfileQueryResult | Promise<T.RpcProfileQueryResult>
  watchProfile(input: T.RpcProfileWatchRequest): AsyncIterable<T.RpcProfileWatchFrame>
}
