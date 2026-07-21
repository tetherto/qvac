import Corestore from 'corestore'
import Hypercore from 'hypercore'
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
import { PairingCoordinator, pairWithHost } from './pairing.ts'
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
  readonly pairingInvite?: Buffer
  readonly runtimeProcessId?: number
  readonly logging?: RuntimeLoggingConfig
}

export class SyncCore extends ReadyResource {
  private readonly options: SyncCoreOptions
  private local: LocalStore | null = null
  private store: Corestore | null = null
  private mesh: Mesh | null = null
  private swarm: Hyperswarm | null = null
  private pairing: PairingCoordinator | null = null
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

  get writable() {
    return this.mesh?.writable ?? false
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
      const writerKey = Hypercore.key({
        version: this.store.manifestVersion,
        signers: [{ publicKey: this.deviceKeyPair.publicKey }]
      })
      this.swarm = new Hyperswarm({
        keyPair: this.deviceKeyPair,
        bootstrap: this.options.bootstrap
      })
      this.swarm.on('connection', (stream) => this.onConnection(stream as PeerStream))

      const pairingResult = this.options.pairingInvite
        ? await pairWithHost(this.swarm, this.options.pairingInvite, writerKey)
        : null
      const session = await this.local.resolveSession(
        pairingResult
          ? { seed: pairingResult.meshSeed, key: pairingResult.meshKey }
          : {
              seed: this.options.meshSeed,
              key: this.options.meshKey
            }
      )
      this.mesh = new Mesh(this.store, {
        seed: session.seed,
        key: session.creator ? null : session.key,
        writerKeyPair: this.deviceKeyPair
      })
      await this.mesh.ready()
      await this.local.recordMeshKey(this.mesh.key)

      const pairing = new PairingCoordinator(this.swarm, this.mesh)
      this.pairing = pairing
      for (const stream of this.swarm.connections) {
        this.onConnection(stream as PeerStream)
      }
      this.swarm.join(this.mesh.discoveryKey, { server: true, client: true })
      if (pairingResult) {
        await this.mesh.waitForWritable()
      }
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
    if (!this.opened || !this.local || !this.mesh || !this.pairing || !this.deviceId) {
      throw new Error('Sync core is not ready')
    }
    bindApi(
      new HRPC(stream),
      createApi(
        this.local,
        this.mesh,
        this.pairing,
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
    if (this.closing) {
      stream.destroy()
      return
    }
    if (!this.mesh) return
    this.peers.add(stream)
    const remove = () => this.peers.delete(stream)
    stream.once('close', remove)
    stream.once('error', remove)
    const mesh = this.mesh
    void Promise.resolve().then(() => {
      if (!stream.destroyed && !this.closing) mesh.replicate(stream)
    })
  }

  private async closeOpenedResources() {
    if (this.pairing) await this.pairing.close()
    this.pairing = null
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
