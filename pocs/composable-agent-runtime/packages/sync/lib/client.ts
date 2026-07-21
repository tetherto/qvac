import ReadyResource from 'ready-resource'
import type { Duplex } from 'streamx'
import type { Capabilities } from '../spec/rpc/capabilities.d.ts'
import { createCalls } from '../spec/rpc/calls.js'
import HRPC from '../spec/rpc/hrpc/index.js'
import type {
  RpcCreatePairingInviteRequest,
  RpcCreateTaskRequest,
  RpcPairingRequestId,
  RpcTaskId,
  RpcUpdateTaskRequest,
  RpcUserProfile
} from '../spec/rpc/hyperschema/types.d.ts'

export class SyncClient extends ReadyResource {
  private readonly stream: Duplex
  private calls: Capabilities | null = null

  constructor(stream: Duplex) {
    super()
    this.stream = stream
  }

  async _open() {
    this.calls = createCalls(new HRPC(this.stream)) as Capabilities
  }

  async _close() {
    this.stream.destroy()
    this.calls = null
  }

  getIdentity() {
    return this.api().getIdentity({})
  }

  describeRuntime() {
    return this.api().describeRuntime({})
  }

  getUserProfile() {
    return this.api().getUserProfile({})
  }

  setUserProfile(profile: RpcUserProfile) {
    return this.api().setUserProfile(profile)
  }

  watchUserProfile() {
    return this.api().watchUserProfile({})
  }

  createTask(request: RpcCreateTaskRequest) {
    return this.api().createTask(request)
  }

  updateTask(request: RpcUpdateTaskRequest) {
    return this.api().updateTask(request)
  }

  getTask(request: RpcTaskId) {
    return this.api().getTask(request)
  }

  listTasks() {
    return this.api().listTasks({})
  }

  watchTasks() {
    return this.api().watchTasks({})
  }

  createPairingInvite(request: RpcCreatePairingInviteRequest = {}) {
    return this.api().createPairingInvite(request)
  }

  approvePairingRequest(request: RpcPairingRequestId) {
    return this.api().approvePairingRequest(request)
  }

  rejectPairingRequest(request: RpcPairingRequestId) {
    return this.api().rejectPairingRequest(request)
  }

  watchPairingRequests() {
    return this.api().watchPairingRequests({})
  }

  private api() {
    if (!this.calls) throw new Error('Sync client is not ready')
    return this.calls
  }
}
