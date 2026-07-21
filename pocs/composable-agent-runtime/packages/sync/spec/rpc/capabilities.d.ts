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
  getUserProfile(input?: T.RpcEmpty): Promise<T.RpcUserProfileResult>
  setUserProfile(input: T.RpcUserProfile): Promise<T.RpcUserProfile>
  watchUserProfile(input?: T.RpcEmpty): WatchStream<T.RpcUserProfileResult>
  createTask(input: T.RpcCreateTaskRequest): Promise<T.RpcTask>
  updateTask(input: T.RpcUpdateTaskRequest): Promise<T.RpcTask>
  getTask(input: T.RpcTaskId): Promise<T.RpcTaskResult>
  listTasks(input?: T.RpcEmpty): Promise<T.RpcTaskList>
  watchTasks(input?: T.RpcEmpty): WatchStream<T.RpcTaskList>
  createPairingInvite(input: T.RpcCreatePairingInviteRequest): Promise<T.RpcPairingInvite>
  approvePairingRequest(input: T.RpcPairingRequestId): Promise<T.RpcPairingRequest>
  rejectPairingRequest(input: T.RpcPairingRequestId): Promise<T.RpcPairingRequest>
  watchPairingRequests(input?: T.RpcEmpty): WatchStream<T.RpcPairingRequestList>
}

export interface CapabilityHandlers {
  getIdentity(input: T.RpcEmpty): T.RpcIdentity | Promise<T.RpcIdentity>
  describeRuntime(input: T.RpcEmpty): T.RpcRuntimeInfo | Promise<T.RpcRuntimeInfo>
  getUserProfile(input: T.RpcEmpty): T.RpcUserProfileResult | Promise<T.RpcUserProfileResult>
  setUserProfile(input: T.RpcUserProfile): T.RpcUserProfile | Promise<T.RpcUserProfile>
  watchUserProfile(input: T.RpcEmpty): AsyncIterable<T.RpcUserProfileResult>
  createTask(input: T.RpcCreateTaskRequest): T.RpcTask | Promise<T.RpcTask>
  updateTask(input: T.RpcUpdateTaskRequest): T.RpcTask | Promise<T.RpcTask>
  getTask(input: T.RpcTaskId): T.RpcTaskResult | Promise<T.RpcTaskResult>
  listTasks(input: T.RpcEmpty): T.RpcTaskList | Promise<T.RpcTaskList>
  watchTasks(input: T.RpcEmpty): AsyncIterable<T.RpcTaskList>
  createPairingInvite(input: T.RpcCreatePairingInviteRequest): T.RpcPairingInvite | Promise<T.RpcPairingInvite>
  approvePairingRequest(input: T.RpcPairingRequestId): T.RpcPairingRequest | Promise<T.RpcPairingRequest>
  rejectPairingRequest(input: T.RpcPairingRequestId): T.RpcPairingRequest | Promise<T.RpcPairingRequest>
  watchPairingRequests(input: T.RpcEmpty): AsyncIterable<T.RpcPairingRequestList>
}
