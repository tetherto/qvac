import Corestore from 'corestore'
import Hypercore from 'hypercore'
import process from '#process'
import type { BootstrapNode, KeyPair } from 'hyperswarm'
import Hyperswarm from 'hyperswarm'
import ReadyResource from 'ready-resource'
import type { Duplex } from 'streamx'
import Supervisor, { type ChildInfo, type StartContext } from '@qvac/supervisor'
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
const LOCAL_METADATA_STORE = 'local-metadata-store'
const IDENTITY_CORESTORE = 'identity-corestore'
const REPLICATED_MESH_NETWORK = 'replicated-mesh-network'

type PeerStream = Duplex & { readonly remotePublicKey: Buffer }

interface IdentityResource {
  readonly store: Corestore
  readonly deviceKeyPair: KeyPair
  readonly writerKey: Buffer
}

interface NetworkResource {
  readonly swarm: Hyperswarm
  readonly mesh: Mesh
  readonly pairing: PairingCoordinator
  readonly peers: Set<PeerStream>
}

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
  private supervisor: Supervisor | null = null
  private local: LocalStore | null = null
  private identity: IdentityResource | null = null
  private network: NetworkResource | null = null
  private readonly streams = new Set<Duplex>()
  private readonly logger: RuntimeLogger

  constructor(options: SyncCoreOptions = {}) {
    super()
    this.options = options
    this.logger = createRuntimeLogger('sync', options.logging)
  }

  get deviceId() {
    return this.identity?.deviceKeyPair.publicKey ?? null
  }

  get meshKey() {
    if (!this.network) throw new Error('Sync core is not ready')
    return this.network.mesh.key
  }

  get discoveryKey() {
    if (!this.network) throw new Error('Sync core is not ready')
    return this.network.mesh.discoveryKey
  }

  get peerCount() {
    return this.network?.peers.size ?? 0
  }

  get writable() {
    return this.network?.mesh.writable ?? false
  }

  inspect(): ChildInfo[] {
    return this.supervisor?.inspect() ?? []
  }

  async _open() {
    const storagePath = this.options.storagePath
    if (!storagePath) throw new Error('storagePath is required')
    this.logger.info('runtime opening', {
      processId: this.options.runtimeProcessId ?? process.pid
    })

    const supervisor = this.createSupervisor(storagePath)
    this.supervisor = supervisor
    try {
      await supervisor.ready()
      this.local = supervisor.get<LocalStore>(LOCAL_METADATA_STORE)
      this.identity = supervisor.get<IdentityResource>(IDENTITY_CORESTORE)
      this.network = supervisor.get<NetworkResource>(REPLICATED_MESH_NETWORK)
      this.logger.info('runtime ready', {
        processId: this.options.runtimeProcessId ?? process.pid
      })
    } catch (error) {
      this.logger.error('runtime failed to open', error)
      await supervisor.close()
      this.clearResourceHandles()
      throw error
    }
  }

  connect(stream: Duplex) {
    if (!this.opened || !this.local || !this.network || !this.deviceId) {
      throw new Error('Sync core is not ready')
    }
    bindApi(
      new HRPC(stream),
      createApi(
        this.local,
        this.network.mesh,
        this.network.pairing,
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
    await this.supervisor?.close()
    this.clearResourceHandles()
  }

  private createSupervisor(storagePath: string) {
    const supervisor = new Supervisor()
    supervisor.add(LOCAL_METADATA_STORE, {
      restart: 'never',
      start: () => openLocalStore(`${storagePath}/local`)
    })
    supervisor.add(IDENTITY_CORESTORE, {
      restart: 'never',
      start: () => this.openIdentity(`${storagePath}/corestore`),
      stop: ({ store }) => store.close()
    })
    supervisor.add(REPLICATED_MESH_NETWORK, {
      deps: [LOCAL_METADATA_STORE, IDENTITY_CORESTORE],
      restart: 'never',
      start: (context) => this.openNetwork(context),
      stop: (network) => this.closeNetwork(network)
    })
    return supervisor
  }

  private async openIdentity(storagePath: string): Promise<IdentityResource> {
    const store = new Corestore(storagePath)
    try {
      await store.ready()
      const deviceKeyPair = await store.createKeyPair(DEVICE_KEYPAIR)
      const writerKey = Hypercore.key({
        version: store.manifestVersion,
        signers: [{ publicKey: deviceKeyPair.publicKey }]
      })
      return { store, deviceKeyPair, writerKey }
    } catch (error) {
      await this.closeFailedResource('identity Corestore', () => store.close())
      throw error
    }
  }

  private async openNetwork(context: StartContext): Promise<NetworkResource> {
    const local = context.get<LocalStore>(LOCAL_METADATA_STORE)
    const identity = context.get<IdentityResource>(IDENTITY_CORESTORE)
    const swarm = new Hyperswarm({
      keyPair: identity.deviceKeyPair,
      bootstrap: this.options.bootstrap
    })
    let mesh: Mesh | null = null
    let pairing: PairingCoordinator | null = null
    let network: NetworkResource | null = null
    swarm.on('connection', (stream) => {
      if (network) this.onConnection(network, stream as PeerStream)
    })

    try {
      const pairingResult = this.options.pairingInvite
        ? await pairWithHost(swarm, this.options.pairingInvite, identity.writerKey)
        : null
      const session = await local.resolveSession(
        pairingResult
          ? { seed: pairingResult.meshSeed, key: pairingResult.meshKey }
          : {
              seed: this.options.meshSeed,
              key: this.options.meshKey
            }
      )
      mesh = new Mesh(identity.store, {
        seed: session.seed,
        key: session.creator ? null : session.key,
        writerKeyPair: identity.deviceKeyPair
      })
      await mesh.ready()
      await local.recordMeshKey(mesh.key)
      pairing = new PairingCoordinator(swarm, mesh)
      network = { swarm, mesh, pairing, peers: new Set() }
      for (const stream of swarm.connections) this.onConnection(network, stream as PeerStream)
      swarm.join(mesh.discoveryKey, { server: true, client: true })
      if (pairingResult) await mesh.waitForWritable()
      return network
    } catch (error) {
      if (pairing) {
        const openedPairing = pairing
        await this.closeFailedResource('pairing coordinator', () => openedPairing.close())
      }
      if (mesh) {
        const openedMesh = mesh
        await this.closeFailedResource('replicated mesh', () => openedMesh.close())
      }
      await this.closeFailedResource('Hyperswarm', () => swarm.destroy())
      throw error
    }
  }

  private onConnection(network: NetworkResource, stream: PeerStream) {
    if (this.closing) {
      stream.destroy()
      return
    }
    network.peers.add(stream)
    const remove = () => network.peers.delete(stream)
    stream.once('close', remove)
    stream.once('error', remove)
    void Promise.resolve().then(() => {
      if (!stream.destroyed && !this.closing) network.mesh.replicate(stream)
    })
  }

  private async closeNetwork(network: NetworkResource) {
    await this.closeFailedResource('pairing coordinator', () => network.pairing.close())
    await this.closeFailedResource('replicated mesh', () => network.mesh.close())
    await this.closeFailedResource('Hyperswarm', () => network.swarm.destroy())
    network.peers.clear()
  }

  private async closeFailedResource(name: string, close: () => Promise<unknown>) {
    try {
      await close()
    } catch (error) {
      this.logger.error(`failed to close ${name}`, error)
    }
  }

  private clearResourceHandles() {
    this.local = null
    this.identity = null
    this.network = null
  }
}
