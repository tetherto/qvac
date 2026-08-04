import ReadyResource from 'ready-resource'
import type { Duplex } from 'streamx'
import type { Capabilities } from '../spec/rpc/capabilities.d.ts'
import { createCalls } from '../spec/rpc/calls.js'
import HRPC from '../spec/rpc/hrpc/index.js'
import {
  ProfileClient,
  type SyncProfileContract
} from './profiles/profile-client.ts'
import type {
  RpcCreatePairingInviteRequest,
  RpcPairingRequestId
} from '../spec/rpc/hyperschema/types.d.ts'
import { toSyncError } from './runtime/errors.ts'

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

  async getIdentity() {
    return this.call(() => this.api().getIdentity({}))
  }

  async describeRuntime() {
    return this.call(() => this.api().describeRuntime({}))
  }

  async runtimeStatus() {
    return this.call(() => this.api().runtimeStatus({}))
  }

  async runtimeDiagnostics() {
    const diagnostics = await this.call(() => this.api().runtimeDiagnostics({}))
    return {
      children: diagnostics.children.map(
        ({
          networkInstanceId,
          topicPresent,
          discoveryTeardownComplete,
          ...child
        }) => ({
          ...child,
          info:
            networkInstanceId == null &&
            topicPresent == null &&
            discoveryTeardownComplete == null
              ? undefined
              : {
                  networkInstanceId,
                  topicPresent,
                  discoveryTeardownComplete
                }
        })
      )
    }
  }

  async suspend() {
    await this.call(() => this.api().suspend({}))
  }

  async resume() {
    await this.call(() => this.api().resume({}))
  }

  async meshStatus() {
    return this.call(() => this.api().meshStatus({}))
  }

  watchMeshStatus() {
    return this.api().watchMeshStatus({})
  }

  async joinMesh(invite: Buffer) {
    await this.call(() => this.api().joinMesh({ invite }))
  }

  async cancelMeshJoin() {
    await this.call(() => this.api().cancelMeshJoin({}))
  }

  async leaveMesh() {
    await this.call(() => this.api().leaveMesh({}))
  }

  async listDevices() {
    return this.call(() => this.api().listDevices({}))
  }

  watchDevices() {
    return this.api().watchDevices({})
  }

  async renameDevice(request: { readonly name: string }) {
    return this.call(() => this.api().renameDevice(request))
  }

  async removeDevice(id: Buffer) {
    await this.call(() => this.api().removeDevice({ id }))
  }

  async createPairingInvite(request: RpcCreatePairingInviteRequest = {}) {
    return this.call(() => this.api().createPairingInvite(request))
  }

  async approvePairingRequest(request: RpcPairingRequestId) {
    return this.call(() => this.api().approvePairingRequest(request))
  }

  async rejectPairingRequest(request: RpcPairingRequestId) {
    return this.call(() => this.api().rejectPairingRequest(request))
  }

  watchPairingRequests() {
    return this.api().watchPairingRequests({})
  }

  openProfile<Command, Query, Result, Change = Result>(
    profile: SyncProfileContract<Command, Query, Result, Change>
  ) {
    return new ProfileClient(profile, this.api())
  }

  private api() {
    if (!this.calls) throw new Error('Sync client is not ready')
    return this.calls
  }

  private async call<T>(work: () => Promise<T>) {
    try {
      return await work()
    } catch (error) {
      throw toSyncError(error)
    }
  }
}
