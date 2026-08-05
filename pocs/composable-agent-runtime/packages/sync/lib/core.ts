import Corestore from 'corestore'
import Hypercore from 'hypercore'
import crypto from 'hypercore-crypto'
import process from '#process'
import type { BootstrapNode, KeyPair } from 'hyperswarm'
import Hyperswarm from 'hyperswarm'
import ReadyResource from 'ready-resource'
import type { Duplex } from 'streamx'
import Supervisor, {
  type ChildInfo,
  type ChildSpec,
  type StartContext
} from '@qvac/supervisor'
import { getOptionalConfigSnapshot } from '@qvac/config'
import QvacLogger, { type LogLevel } from '@qvac/logging'
import { bindApi } from '../spec/rpc/bind.js'
import HRPC from '../spec/rpc/hrpc/index.js'
import { createApi } from './api.ts'
import { openLocalStore, type LocalStore } from './local.ts'
import { Mesh } from './mesh.ts'
import { PairingCoordinator, pairWithHost } from './pairing.ts'
import { createProfileRegistry } from './profiles/registry.ts'
import { toRuntimeDiagnostics } from './runtime/diagnostics.ts'
import { SyncSuspendedError } from './runtime/errors.ts'
import { resolveSyncConfig, syncLogLevel } from './config.ts'
import type {
  SyncNetworkState,
  SyncRuntimePhase,
  SyncRuntimeStatus
} from './runtime/runtime-handle.ts'

const DEVICE_KEYPAIR = 'qvac-sync/poc/device'
const LOCAL_METADATA_STORE = 'local-metadata-store'
const IDENTITY_CORESTORE = 'identity-corestore'
const REPLICATED_MESH_NETWORK = 'replicated-mesh-network'

type PeerStream = Duplex & { readonly remotePublicKey: Buffer }
interface DiscoverySession {
  flushed(): Promise<boolean>
  destroy(): Promise<void>
}

interface IdentityResource {
  readonly store: Corestore
  readonly deviceKeyPair: KeyPair
}

interface NetworkResource {
  readonly id: string
  readonly swarm: Hyperswarm
  readonly removeErrorListener: () => void
  mesh: Mesh
  pairing: PairingCoordinator
  candidateMesh: Mesh | null
  meshWatchListener: () => void
  readonly peers: Set<PeerStream>
  discovery: DiscoverySession | null
  discoveryTeardownComplete: boolean
}

interface MeshSessionOverride {
  readonly seed: Buffer
  readonly key?: Buffer
  readonly writerSeed: Buffer
  readonly awaitWritable: boolean
}

export interface SyncCoreOptions {
  readonly storagePath?: string
  readonly bootstrap?: ReadonlyArray<BootstrapNode>
  readonly meshSeed?: Buffer
  readonly meshKey?: Buffer
  readonly pairingInvite?: Buffer
  readonly runtimeProcessId?: number
  readonly logging?: { readonly level?: LogLevel }
}

export class SyncCore extends ReadyResource {
  private readonly options: SyncCoreOptions
  private supervisor: Supervisor | null = null
  private local: LocalStore | null = null
  private identity: IdentityResource | null = null
  private network: NetworkResource | null = null
  private readonly streams = new Set<Duplex>()
  private readonly logger: QvacLogger
  private readonly profiles = createProfileRegistry()
  private phase: SyncRuntimePhase = 'opening'
  private generation = '1'
  private networkState: SyncNetworkState = 'stopped'
  private operationsOpen = false
  private suspendPromise: Promise<void> | null = null
  private resumePromise: Promise<void> | null = null
  private membershipPromise: Promise<void> | null = null
  private membershipCancel: (() => void) | null = null
  private readonly pendingProfileMutations = new Set<Promise<unknown>>()
  private readonly statusListeners = new Set<() => void>()

  constructor(options: SyncCoreOptions = {}) {
    super()
    this.options = options
    const write = (...values: unknown[]) => console.error(...values)
    this.logger = new QvacLogger({
      error: write,
      warn: write,
      info: write,
      debug: write
    })
    const config =
      getOptionalConfigSnapshot() ?? resolveSyncConfig(options.logging)
    this.logger.setLevel(syncLogLevel(config))
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

  status(): SyncRuntimeStatus {
    return {
      phase: this.phase,
      generation: this.generation,
      network: this.networkState,
      writable: this.writable && this.phase === 'ready' && this.operationsOpen,
      peerCount: this.peerCount
    }
  }

  meshStatus() {
    const runtime = this.status()
    return {
      state: this.membershipPromise
        ? ('joining' as const)
        : this.network
        ? this.writable
          ? ('joined' as const)
          : ('joining' as const)
        : ('idle' as const),
      generation: runtime.generation,
      meshKey: this.network?.mesh.key,
      discoveryKey: this.network?.mesh.discoveryKey,
      writable: runtime.writable,
      peerCount: runtime.peerCount,
      network: runtime.network
    }
  }

  inspect(): ChildInfo[] {
    return this.supervisor?.inspect() ?? []
  }

  async runtimeDiagnostics() {
    const children = this.inspect()
    const network = this.network
    const topicPresent = network?.discovery != null
    return toRuntimeDiagnostics(
      children.map((child) => {
        if (child.name !== REPLICATED_MESH_NETWORK) return child
        return {
          ...child,
          info: {
            networkInstanceId: network?.id,
            discoveryTeardownComplete: network?.discoveryTeardownComplete ?? false,
            topicPresent
          }
        }
      })
    )
  }

  async suspend() {
    if (this.membershipPromise) {
      throw new Error('Sync membership transition is in progress')
    }
    if (this.suspendPromise) return this.suspendPromise
    if (this.resumePromise) await this.resumePromise
    if (this.suspendPromise) return this.suspendPromise
    if (this.phase === 'suspended') return
    if (this.phase !== 'ready') {
      throw new Error(`Sync core cannot suspend from phase ${this.phase}`)
    }

    const transition = this.runSuspend()
    this.suspendPromise = transition
    try {
      await transition
    } finally {
      if (this.suspendPromise === transition) this.suspendPromise = null
    }
  }

  async resume() {
    if (this.membershipPromise) {
      throw new Error('Sync membership transition is in progress')
    }
    if (this.resumePromise) return this.resumePromise
    if (this.suspendPromise) await this.suspendPromise
    if (this.resumePromise) return this.resumePromise
    if (this.phase === 'ready') return
    if (this.phase !== 'suspended') {
      throw new Error(`Sync core cannot resume from phase ${this.phase}`)
    }

    const transition = this.runResume()
    this.resumePromise = transition
    try {
      await transition
    } finally {
      if (this.resumePromise === transition) this.resumePromise = null
    }
  }

  async join(invite: Buffer) {
    return this.runMembershipTransition(async () => {
      const identity = this.requireIdentity()
      const network = this.requireNetwork()
      const writerSeed = crypto.randomBytes(32)
      const writerKey = writerKeyFor(identity.store, writerSeed)
      const local = this.local
      if (!local) throw new Error('Sync local store is unavailable')
      const device = await local.ensureDevice(identity.deviceKeyPair.publicKey)
      const cancellation = createPairingCancellation()
      this.membershipCancel = cancellation.abort
      try {
        const result = await pairWithHost(
          network.swarm,
          invite,
          writerKey,
          device,
          cancellation.signal
        )
        throwIfCancelled(cancellation.signal)
        await this.activateCandidateMesh(
          {
            seed: result.meshSeed,
            key: result.meshKey,
            writerSeed,
            awaitWritable: true
          },
          cancellation.signal
        )
      } finally {
        if (this.membershipCancel === cancellation.abort) this.membershipCancel = null
      }
    })
  }

  async cancelJoin() {
    const transition = this.membershipPromise
    if (!transition) return
    if (!this.membershipCancel) {
      throw new Error('Sync membership transition can no longer be cancelled')
    }
    this.membershipCancel()
    try {
      await transition
    } catch (error) {
      if (error instanceof Error && /cancelled/i.test(error.message)) return
      throw error
    }
  }

  async leave() {
    return this.runMembershipTransition(async () => {
      await this.activateCandidateMesh({
        seed: crypto.randomBytes(32),
        writerSeed: crypto.randomBytes(32),
        awaitWritable: false
      }, undefined, true)
    })
  }

  completeMembershipTransition() {
    if (this.phase !== 'ready' || this.closing) {
      throw new Error(`Sync membership cannot complete from phase ${this.phase}`)
    }
    this.operationsOpen = true
    this.networkState = this.peerCount > 0 ? 'online' : 'offline'
    this.notifyStatus()
  }

  onStatus(listener: () => void) {
    this.statusListeners.add(listener)
  }

  offStatus(listener: () => void) {
    this.statusListeners.delete(listener)
  }

  devices() {
    const devices = new Map<string, { deviceId: Buffer; local: boolean }>()
    if (this.deviceId) {
      devices.set(this.deviceId.toString('hex'), {
        deviceId: this.deviceId,
        local: true
      })
    }
    for (const peer of this.network?.peers ?? []) {
      devices.set(peer.remotePublicKey.toString('hex'), {
        deviceId: peer.remotePublicKey,
        local: false
      })
    }
    return [...devices.values()]
  }

  async listDevices() {
    const localId = this.deviceId
    return (await this.requireNetwork().mesh.listDevices()).map((device) => ({
      id: device.id,
      name: device.name,
      local: localId?.equals(device.id) ?? false,
      joinedAt: device.joinedAt,
      revokedAt: device.revokedAt
    }))
  }

  async renameDevice(name: string) {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Sync device name must not be empty')
    const id = this.deviceId
    const local = this.local
    if (!id || !local) throw new Error('Sync device identity is unavailable')
    const prior = await local.ensureDevice(id)
    await local.renameDevice(id, trimmed)
    try {
      await this.requireNetwork().mesh.renameDevice(id, trimmed)
    } catch (error) {
      await local.renameDevice(id, prior.name)
      throw error
    }
    return {
      id,
      name: trimmed,
      local: true,
      joinedAt:
        (await this.requireNetwork().mesh.listDevices()).find((device) =>
          device.id.equals(id)
        )?.joinedAt ?? Date.now()
    }
  }

  async removeDevice(id: Buffer) {
    if (this.deviceId?.equals(id)) {
      throw new Error('Cannot remove this device, use mesh.leave()')
    }
    const device = (await this.requireNetwork().mesh.listDevices()).find((item) =>
      item.id.equals(id)
    )
    if (!device) throw new Error('Sync device was not found')
    if (device.revokedAt) return
    await this.requireNetwork().mesh.removeDevice(id, device.writerKey)
  }

  assertAcceptingOperations() {
    if (!this.operationsOpen || this.phase === 'suspended') {
      throw new SyncSuspendedError()
    }
    if (this.phase !== 'ready') {
      throw new Error(`Sync runtime is ${this.phase}`)
    }
  }

  async _open() {
    const storagePath = this.options.storagePath
    if (!storagePath) throw new Error('storagePath is required')
    this.phase = 'opening'
    this.operationsOpen = false
    this.networkState = 'starting'
    this.logger.info('[sync]', 'runtime opening', {
      processId: this.options.runtimeProcessId ?? process.pid
    })

    const supervisor = this.createSupervisor(storagePath)
    this.supervisor = supervisor
    try {
      await supervisor.ready()
      this.local = supervisor.get<LocalStore>(LOCAL_METADATA_STORE)
      this.identity = supervisor.get<IdentityResource>(IDENTITY_CORESTORE)
      this.network = supervisor.get<NetworkResource>(REPLICATED_MESH_NETWORK)
      this.phase = 'ready'
      this.operationsOpen = true
      this.networkState = this.peerCount > 0 ? 'online' : 'offline'
      this.notifyStatus()
      this.logger.info('[sync]', 'runtime ready', {
        processId: this.options.runtimeProcessId ?? process.pid
      })
    } catch (error) {
      this.phase = 'failed'
      this.operationsOpen = false
      this.networkState = 'stopped'
      this.logger.error('[sync]', 'runtime failed to open', error)
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
        () => {
          const network = this.requireNetwork()
          return { mesh: network.mesh, pairing: network.pairing }
        },
        this.deviceId,
        this.options.runtimeProcessId ?? process.pid,
        () => this.assertAcceptingOperations(),
        () => this.generation,
        (work) => this.trackProfileMutation(work),
        {
          status: () => this.status(),
          diagnostics: () => this.runtimeDiagnostics(),
          suspend: () => this.suspend(),
          resume: () => this.resume(),
          meshStatus: () => this.meshStatus(),
          onStatus: (listener) => this.onStatus(listener),
          offStatus: (listener) => this.offStatus(listener),
          join: async (invite) => {
            await this.join(invite)
            this.completeMembershipTransition()
          },
          cancelJoin: () => this.cancelJoin(),
          leave: async () => {
            await this.leave()
            this.completeMembershipTransition()
          },
          listDevices: () => this.listDevices(),
          renameDevice: (name) => this.renameDevice(name),
          removeDevice: (id) => this.removeDevice(id)
        }
      )
    )
    this.streams.add(stream)
    stream.once('close', () => this.streams.delete(stream))
  }

  async _close() {
    this.logger.info('[sync]', 'runtime closing')
    this.operationsOpen = false
    this.phase = 'closed'
    this.networkState = 'stopped'
    this.notifyStatus()
    this.membershipCancel?.()
    this.membershipCancel = null
    for (const stream of this.streams) stream.destroy()
    this.streams.clear()
    await this.supervisor?.close()
    await this.membershipPromise?.catch(() => {})
    this.clearResourceHandles()
    this.statusListeners.clear()
  }

  private async runSuspend() {
    // Gate mutations before flush/network teardown; publish suspended only after success.
    this.operationsOpen = false
    try {
      await this.flushAcceptedWrites()
      await this.supervisor?.suspend()
      this.phase = 'suspended'
      this.networkState = 'stopped'
      this.notifyStatus()
    } catch (error) {
      if (this.phase === 'ready') this.operationsOpen = true
      throw error
    }
  }

  private async runResume() {
    this.networkState = 'starting'
    try {
      await this.supervisor?.resume()
      this.generation = String(Number(this.generation) + 1)
      this.phase = 'ready'
      this.operationsOpen = true
      this.networkState = this.peerCount > 0 ? 'online' : 'offline'
      this.notifyStatus()
    } catch (error) {
      this.networkState = 'stopped'
      throw error
    }
  }

  private createSupervisor(storagePath: string) {
    const supervisor = new Supervisor()
    supervisor.on('child-died', ({ name }) => {
      if (name !== REPLICATED_MESH_NETWORK || this.closing) return
      this.network = null
      this.operationsOpen = false
      this.networkState = 'degraded'
      this.notifyStatus()
    })
    supervisor.on('child-ready', ({ name }) => {
      if (
        name !== REPLICATED_MESH_NETWORK ||
        this.closing ||
        this.membershipPromise != null ||
        this.phase !== 'ready'
      ) {
        return
      }
      this.network = supervisor.get<NetworkResource>(REPLICATED_MESH_NETWORK)
      this.operationsOpen = true
      this.networkState = this.peerCount > 0 ? 'online' : 'offline'
      this.notifyStatus()
    })
    supervisor.on('gave-up', ({ name }) => {
      if (name !== REPLICATED_MESH_NETWORK || this.closing) return
      this.network = null
      this.operationsOpen = false
      this.phase = 'failed'
      this.networkState = 'stopped'
      this.notifyStatus()
    })
    supervisor.add(LOCAL_METADATA_STORE, {
      restart: 'never',
      start: () => openLocalStore(`${storagePath}/local`)
    })
    supervisor.add(IDENTITY_CORESTORE, {
      restart: 'never',
      start: () => this.openIdentity(`${storagePath}/corestore`),
      stop: ({ store }) => store.close()
    })
    supervisor.add(REPLICATED_MESH_NETWORK, this.networkSpec())
    return supervisor
  }

  private networkSpec(
    session?: MeshSessionOverride
  ): ChildSpec<NetworkResource> {
    return {
      deps: [LOCAL_METADATA_STORE, IDENTITY_CORESTORE],
      restart: 'always',
      maxRestarts: 3,
      window: 60_000,
      backoff: 100,
      maxBackoff: 2_000,
      start: (context) => this.openNetwork(context, session),
      stop: (network) => this.closeNetwork(network),
      suspend: (network) => this.suspendNetwork(network),
      resume: (network) => this.resumeNetwork(network),
      inspect: (network) => ({
        discoveryTeardownComplete: network.discoveryTeardownComplete
      })
    }
  }

  private async openIdentity(storagePath: string): Promise<IdentityResource> {
    const store = new Corestore(storagePath)
    try {
      await store.ready()
      const deviceKeyPair = await store.createKeyPair(DEVICE_KEYPAIR)
      return { store, deviceKeyPair }
    } catch (error) {
      await this.closeFailedResource('identity Corestore', () => store.close())
      throw error
    }
  }

  private async openNetwork(
    context: StartContext,
    override?: MeshSessionOverride
  ): Promise<NetworkResource> {
    const local = context.get<LocalStore>(LOCAL_METADATA_STORE)
    const identity = context.get<IdentityResource>(IDENTITY_CORESTORE)
    const swarm = new Hyperswarm({
      keyPair: identity.deviceKeyPair,
      bootstrap: this.options.bootstrap
    })
    const swarmErrors = swarm as unknown as {
      on(event: 'error', listener: (error: Error) => void): void
      removeListener(event: 'error', listener: (error: Error) => void): void
    }
    const onError = (error: Error) => context.onDeath(error)
    swarmErrors.on('error', onError)
    let mesh: Mesh | null = null
    let pairing: PairingCoordinator | null = null
    let network: NetworkResource | null = null
    swarm.on('connection', (stream) => {
      if (network) this.onConnection(network, stream as PeerStream)
    })

    try {
      const pairingWriterSeed =
        override?.writerSeed ??
        (this.options.pairingInvite ? crypto.randomBytes(32) : undefined)
      let pairingResult = null
      if (!override && this.options.pairingInvite) {
        if (!pairingWriterSeed) {
          throw new Error('Pairing writer seed is unavailable')
        }
        const device = await local.ensureDevice(identity.deviceKeyPair.publicKey)
        pairingResult = await pairWithHost(
          swarm,
          this.options.pairingInvite,
          writerKeyFor(identity.store, pairingWriterSeed),
          device
        )
      }
      const session = await local.resolveSession(
        override
          ? {
              seed: override.seed,
              key: override.key,
              writerSeed: override.writerSeed
            }
          : pairingResult
          ? {
              seed: pairingResult.meshSeed,
              key: pairingResult.meshKey,
              writerSeed: pairingWriterSeed
            }
          : {
              seed: this.options.meshSeed,
              key: this.options.meshKey
            }
      )
      mesh = new Mesh(identity.store, {
        seed: session.seed,
        key: session.creator ? null : session.key,
        writerKeyPair: crypto.keyPair(session.writerSeed),
        profiles: this.profiles
      })
      await mesh.ready()
      await local.recordMeshKey(mesh.key)
      pairing = new PairingCoordinator(swarm, mesh)
      network = {
        id: crypto.randomBytes(8).toString('hex'),
        swarm,
        removeErrorListener: () => swarmErrors.removeListener('error', onError),
        mesh,
        pairing,
        candidateMesh: null,
        meshWatchListener: () => {},
        peers: new Set(),
        discovery: null,
        discoveryTeardownComplete: false
      }
      for (const stream of swarm.connections) this.onConnection(network, stream as PeerStream)
      network.discovery = joinDiscovery(swarm, mesh.discoveryKey)
      if (pairingResult || override?.awaitWritable) await mesh.waitForWritable()
      if (mesh.writable) {
        const device = await local.ensureDevice(identity.deviceKeyPair.publicKey)
        await mesh.putDevice({
          id: device.id,
          writerKey: mesh.localWriterKey,
          name: device.name,
          joinedAt: Date.now()
        })
      }
      this.watchRevocation(network)
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
    // Accept connections while opening so pairing waitForWritable can replicate
    // writer admission. Mutation gating uses operationsOpen separately.
    if (this.closing || !this.acceptsReplication()) {
      stream.destroy()
      return
    }
    network.peers.add(stream)
    if (this.phase === 'ready') {
      this.networkState = 'online'
      this.notifyStatus()
    }
    const remove = () => {
      network.peers.delete(stream)
      if (this.phase === 'ready') {
        this.networkState = this.peerCount > 0 ? 'online' : 'offline'
        this.notifyStatus()
      }
    }
    stream.once('close', remove)
    stream.once('error', remove)
    void Promise.resolve().then(() => {
      if (!stream.destroyed && !this.closing && this.acceptsReplication()) {
        network.mesh.replicate(stream)
        network.candidateMesh?.replicate(stream)
      }
    })
  }

  private acceptsReplication() {
    return this.phase === 'opening' || this.phase === 'ready'
  }

  private async suspendNetwork(network: NetworkResource) {
    await this.destroyDiscovery(network)
    for (const peer of [...network.peers]) peer.destroy()
    network.peers.clear()
  }

  private async resumeNetwork(network: NetworkResource) {
    if (!network.discovery) {
      network.discovery = joinDiscovery(network.swarm, network.mesh.discoveryKey)
      network.discoveryTeardownComplete = false
    }
  }

  private async flushAcceptedWrites() {
    await Promise.allSettled([...this.pendingProfileMutations])
    // LocalStore mutations already await transaction.flush() before resolving.
    // Mesh still needs an Autobee update barrier for accepted replicated writes.
    const mesh = this.network?.mesh
    if (!mesh?.autobee) return
    await mesh.autobee.update()
  }

  private async closeNetwork(network: NetworkResource) {
    // swarm.destroy() tears down discovery sessions; avoid a separate awaited
    // destroy/status round-trip that can leave DHT sockets alive after tests.
    network.discovery = null
    network.discoveryTeardownComplete = true
    network.mesh.unwatch(network.meshWatchListener)
    await this.closeFailedResource('candidate mesh', () =>
      network.candidateMesh?.close() ?? Promise.resolve()
    )
    network.candidateMesh = null
    await this.closeFailedResource('pairing coordinator', () => network.pairing.close())
    await this.closeFailedResource('replicated mesh', () => network.mesh.close())
    await this.closeFailedResource('Hyperswarm', () => network.swarm.destroy())
    network.removeErrorListener()
    network.peers.clear()
  }

  private async destroyDiscovery(network: NetworkResource) {
    const discovery = network.discovery
    if (!discovery) {
      network.discoveryTeardownComplete = true
      return
    }
    network.discovery = null
    // Hyperswarm PeerDiscoverySession.destroy() awaits leave/unannounce.
    await discovery.destroy()
    network.discoveryTeardownComplete = true
  }

  private async runMembershipTransition(work: () => Promise<void>) {
    if (this.membershipPromise) {
      throw new Error('Sync membership transition is in progress')
    }
    if (this.suspendPromise || this.resumePromise) {
      throw new Error('Sync lifecycle transition is in progress')
    }
    if (this.phase !== 'ready') {
      throw new Error(`Sync membership cannot change from phase ${this.phase}`)
    }
    this.operationsOpen = false
    const transition = (async () => {
      try {
        await this.flushAcceptedWrites()
        await work()
      } catch (error) {
        if (this.phase === 'ready' && !this.closing) {
          this.operationsOpen = true
          this.networkState = this.peerCount > 0 ? 'online' : 'offline'
          this.notifyStatus()
        }
        throw error
      }
    })()
    this.membershipPromise = transition
    try {
      await transition
    } finally {
      if (this.membershipPromise === transition) this.membershipPromise = null
    }
  }

  private trackProfileMutation<T>(work: () => Promise<T>) {
    const pending = work()
    this.pendingProfileMutations.add(pending)
    return pending.finally(() => {
      this.pendingProfileMutations.delete(pending)
    })
  }

  private async activateCandidateMesh(
    override: MeshSessionOverride,
    cancellation?: { readonly aborted: boolean },
    announceDeparture = false
  ) {
    const network = this.requireNetwork()
    const identity = this.requireIdentity()
    const local = this.local
    if (!local) throw new Error('Sync local store is unavailable')
    throwIfCancelled(cancellation)
    const session = local.createCandidateSession({
      seed: override.seed,
      key: override.key,
      writerSeed: override.writerSeed
    })
    const candidate = new Mesh(identity.store, {
      seed: session.seed,
      key: session.creator ? null : session.key,
      writerKeyPair: crypto.keyPair(session.writerSeed),
      profiles: this.profiles
    })
    network.candidateMesh = candidate
    let candidatePairing: PairingCoordinator | null = null
    let candidateDiscovery: DiscoverySession | null = null
    try {
      await candidate.ready()
      throwIfCancelled(cancellation)
      candidateDiscovery = joinDiscovery(network.swarm, candidate.discoveryKey)
      for (const stream of network.peers) candidate.replicate(stream)
      if (override.awaitWritable) await candidate.waitForWritable()
      throwIfCancelled(cancellation)
      const device = await local.ensureDevice(identity.deviceKeyPair.publicKey)
      await candidate.putDevice({
        id: device.id,
        writerKey: candidate.localWriterKey,
        name: device.name,
        joinedAt: Date.now()
      })
      candidatePairing = new PairingCoordinator(network.swarm, candidate)
      if (announceDeparture) {
        await network.mesh.removeDevice(
          identity.deviceKeyPair.publicKey,
          network.mesh.localWriterKey
        )
      }
      throwIfCancelled(cancellation)
      await local.commitSession(session, candidate.key)

      const sourceMesh = network.mesh
      const sourcePairing = network.pairing
      const sourceDiscovery = network.discovery
      sourceMesh.unwatch(network.meshWatchListener)
      network.mesh = candidate
      network.pairing = candidatePairing
      network.discovery = candidateDiscovery
      network.candidateMesh = null
      this.watchRevocation(network)
      candidatePairing = null
      candidateDiscovery = null
      this.generation = String(Number(this.generation) + 1)
      this.phase = 'ready'
      this.operationsOpen = false
      this.networkState = this.peerCount > 0 ? 'online' : 'offline'
      this.notifyStatus()

      await sourcePairing.close().catch(() => {})
      await sourceDiscovery?.destroy().catch(() => {})
      await sourceMesh.close().catch(() => {})
    } catch (error) {
      network.candidateMesh = null
      await candidatePairing?.close().catch(() => {})
      await candidateDiscovery?.destroy().catch(() => {})
      await candidate.close().catch(() => {})
      throw error
    }
  }

  private watchRevocation(network: NetworkResource) {
    const listener = () => {
      void this.handleRevocation(network).catch((error) => {
        this.logger.error('[sync]', 'revocation remint failed', error)
      })
    }
    network.meshWatchListener = listener
    network.mesh.watch(listener)
  }

  private async handleRevocation(network: NetworkResource) {
    if (
      this.network !== network ||
      this.closing ||
      this.membershipPromise ||
      this.phase !== 'ready'
    ) {
      return
    }
    const id = this.deviceId
    if (!id) return
    const device = (await network.mesh.listDevices()).find((item) => item.id.equals(id))
    if (!device?.revokedAt) return
    await this.runMembershipTransition(() =>
      this.activateCandidateMesh({
        seed: crypto.randomBytes(32),
        writerSeed: crypto.randomBytes(32),
        awaitWritable: false
      })
    )
    this.completeMembershipTransition()
  }

  private requireNetwork() {
    if (!this.network) throw new Error('Sync network is unavailable')
    return this.network
  }

  private requireIdentity() {
    if (!this.identity) throw new Error('Sync identity is unavailable')
    return this.identity
  }

  private notifyStatus() {
    for (const listener of this.statusListeners) listener()
  }

  private async closeFailedResource(name: string, close: () => Promise<unknown>) {
    try {
      await close()
    } catch (error) {
      this.logger.error('[sync]', `failed to close ${name}`, error)
    }
  }

  private clearResourceHandles() {
    this.local = null
    this.identity = null
    this.network = null
  }
}

function joinDiscovery(swarm: Hyperswarm, discoveryKey: Buffer): DiscoverySession {
  const session = swarm.join(discoveryKey, { server: true, client: true })
  const flushed = Reflect.get(session, 'flushed')
  const destroy = Reflect.get(session, 'destroy')
  if (typeof flushed !== 'function' || typeof destroy !== 'function') {
    throw new Error('Hyperswarm returned an invalid discovery session')
  }
  return {
    flushed: () => Reflect.apply(flushed, session, []),
    destroy: () => Reflect.apply(destroy, session, [])
  }
}

function writerKeyFor(store: Corestore, writerSeed: Buffer) {
  const writerKeyPair = crypto.keyPair(writerSeed)
  return Hypercore.key({
    version: store.manifestVersion,
    signers: [{ publicKey: writerKeyPair.publicKey }]
  })
}

function throwIfCancelled(cancellation?: { readonly aborted: boolean }) {
  if (cancellation?.aborted) throw new Error('Sync mesh join cancelled')
}

function createPairingCancellation() {
  let aborted = false
  const listeners = new Set<() => void>()
  const abort = () => {
    if (aborted) return
    aborted = true
    for (const listener of listeners) listener()
    listeners.clear()
  }
  return {
    signal: {
      get aborted() {
        return aborted
      },
      onAbort(listener: () => void) {
        if (aborted) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    abort
  }
}
