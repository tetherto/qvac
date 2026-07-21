import Corestore from 'corestore'
import process from '#process'
import type { BootstrapNode, KeyPair } from 'hyperswarm'
import Hyperswarm from 'hyperswarm'
import ReadyResource from 'ready-resource'
import type { Duplex } from 'streamx'
import { bindApi } from '../spec/rpc/bind.js'
import HRPC from '../spec/rpc/hrpc/index.js'
import { createApi } from './api.ts'
import { openLocalStore, type LocalStore } from './local.ts'
import { Mesh } from './mesh.ts'
import {
  createRuntimeLogger,
  type RuntimeLogger,
  type RuntimeLoggingConfig
} from '@qvac/runtime-contracts'

const DEVICE_KEYPAIR = 'qvac-sync/poc/device'

type PeerStream = Duplex & { readonly remotePublicKey: Buffer }

export interface SyncCoreOptions {
  readonly storagePath?: string
  readonly bootstrap?: ReadonlyArray<BootstrapNode>
  readonly meshSeed?: Buffer
  readonly meshKey?: Buffer
  readonly runtimeProcessId?: number
  readonly logging?: RuntimeLoggingConfig
}

export class SyncCore extends ReadyResource {
  private readonly options: SyncCoreOptions
  private local: LocalStore | null = null
  private store: Corestore | null = null
  private mesh: Mesh | null = null
  private swarm: Hyperswarm | null = null
  private deviceKeyPair: KeyPair | null = null
  private readonly streams = new Set<Duplex>()
  private readonly peers = new Set<PeerStream>()
  private readonly logger: RuntimeLogger

  constructor(options: SyncCoreOptions = {}) {
    super()
    this.options = options
    this.logger = createRuntimeLogger('sync', options.logging)
  }

  get deviceId() {
    return this.deviceKeyPair?.publicKey ?? null
  }

  get meshKey() {
    if (!this.mesh) throw new Error('Sync core is not ready')
    return this.mesh.key
  }

  get discoveryKey() {
    if (!this.mesh) throw new Error('Sync core is not ready')
    return this.mesh.discoveryKey
  }

  get peerCount() {
    return this.peers.size
  }

  async _open() {
    const storagePath = this.options.storagePath
    if (!storagePath) throw new Error('storagePath is required')
    this.logger.info('runtime opening', {
      processId: this.options.runtimeProcessId ?? process.pid
    })

    try {
      this.local = await openLocalStore(`${storagePath}/local`)
      this.store = new Corestore(`${storagePath}/corestore`)
      await this.store.ready()
      this.deviceKeyPair = await this.store.createKeyPair(DEVICE_KEYPAIR)
      const session = await this.local.resolveSession({
        seed: this.options.meshSeed,
        key: this.options.meshKey
      })
      this.mesh = new Mesh(this.store, {
        seed: session.seed,
        key: session.creator ? null : session.key
      })
      await this.mesh.ready()
      await this.local.recordMeshKey(this.mesh.key)

      this.swarm = new Hyperswarm({
        keyPair: this.deviceKeyPair,
        bootstrap: this.options.bootstrap
      })
      this.swarm.on('connection', (stream) => this.onConnection(stream as PeerStream))
      this.swarm.join(this.mesh.discoveryKey, { server: true, client: true })
      this.logger.info('runtime ready', {
        processId: this.options.runtimeProcessId ?? process.pid
      })
    } catch (error) {
      this.logger.error('runtime failed to open', error)
      await this.closeOpenedResources()
      throw error
    }
  }

  connect(stream: Duplex) {
    if (!this.opened || !this.local || !this.mesh || !this.deviceId) {
      throw new Error('Sync core is not ready')
    }
    bindApi(
      new HRPC(stream),
      createApi(
        this.local,
        this.mesh,
        this.deviceId,
        this.options.runtimeProcessId ?? process.pid
      )
    )
    this.streams.add(stream)
    stream.once('close', () => this.streams.delete(stream))
  }

  async _close() {
    this.logger.info('runtime closing')
    for (const stream of this.streams) stream.destroy()
    this.streams.clear()
    await this.closeOpenedResources()
  }

  private onConnection(stream: PeerStream) {
    if (this.closing || !this.mesh) {
      stream.destroy()
      return
    }
    this.peers.add(stream)
    const remove = () => this.peers.delete(stream)
    stream.once('close', remove)
    stream.once('error', remove)
    this.mesh.replicate(stream)
  }

  private async closeOpenedResources() {
    if (this.mesh) await this.mesh.close()
    this.mesh = null
    if (this.swarm) await this.swarm.destroy()
    this.swarm = null
    this.peers.clear()
    if (this.store) await this.store.close()
    this.store = null
    if (this.local) await this.local.close()
    this.local = null
    this.deviceKeyPair = null
  }
}
