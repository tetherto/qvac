import type { CapabilityHandlers } from '../spec/rpc/capabilities.d.ts'
import type {
  RpcProfileWatchFrame,
  RpcProfileWatchRequest
} from '../spec/rpc/hyperschema/types.d.ts'
import type { Mesh } from './mesh.ts'
import type { PairingCoordinator } from './pairing.ts'
import { syncCompatibility } from './runtime/compatibility.ts'
import { watchable } from './watchable.ts'
import { SyncGenerationEndedError } from './runtime/errors.ts'

export function createApi(
  resources: () => { readonly mesh: Mesh; readonly pairing: PairingCoordinator },
  deviceId: Buffer,
  processId: number,
  assertAvailable: () => void = () => {},
  getGeneration: () => string = () => '1',
  runMutation: <T>(work: () => Promise<T>) => Promise<T> = (work) => work(),
  runtime?: {
    status(): {
      phase: 'opening' | 'ready' | 'suspended' | 'failed' | 'closed'
      generation: string
      network: 'stopped' | 'starting' | 'online' | 'offline' | 'degraded'
      writable: boolean
      peerCount: number
    }
    diagnostics(): Promise<{
      children: readonly {
        name: string
        state: string
        deps: readonly string[]
        info?: Record<string, unknown>
      }[]
    }>
    suspend(): Promise<void>
    resume(): Promise<void>
    meshStatus(): {
      state: 'idle' | 'joining' | 'joined' | 'leaving' | 'kicked' | 'error'
      generation: string
      meshKey?: Buffer
      discoveryKey?: Buffer
      writable: boolean
      peerCount: number
      network: 'stopped' | 'starting' | 'online' | 'offline' | 'degraded'
    }
    onStatus(listener: () => void): void
    offStatus(listener: () => void): void
    join(invite: Buffer): Promise<void>
    cancelJoin(): Promise<void>
    leave(): Promise<void>
    listDevices(): Promise<
      readonly {
        id: Buffer
        name: string
        local: boolean
        joinedAt: number
        revokedAt?: number | null
      }[]
    >
    renameDevice(name: string): Promise<{
      id: Buffer
      name: string
      local: boolean
      joinedAt: number
      revokedAt?: number | null
    }>
    removeDevice(id: Buffer): Promise<void>
  }
): CapabilityHandlers {
  const currentMesh = () => resources().mesh
  const currentPairing = () => resources().pairing
  async function* watchProfile(
    request: RpcProfileWatchRequest
  ): AsyncIterable<RpcProfileWatchFrame> {
    assertProfileGeneration(request.generation)
    const mesh = currentMesh()
    const watchProfileSnapshots = watchable(
      mesh,
      async (input: RpcProfileWatchRequest) => {
        assertAvailable()
        assertProfileGeneration(input.generation)
        return mesh.queryProfile(input)
      }
    )
    validateCursor(request.after, getGeneration())
    let first = true
    let lastRevision: string | null | undefined
    for await (const value of watchProfileSnapshots(request)) {
      assertAvailable()
      assertProfileGeneration(request.generation)
      const revision = await mesh.profileRevision(request.profileId)
      if (!first && revision === lastRevision) continue
      lastRevision = revision
      const common = {
        generation: getGeneration(),
        cursor: encodeCursor(getGeneration(), revision)
      }
      if (first) {
        first = false
        yield { kind: 'snapshot', ...common, value }
        continue
      }
      yield { kind: 'change', ...common, change: value }
    }
  }

  function assertProfileGeneration(generation: string) {
    if (generation !== getGeneration()) throw new SyncGenerationEndedError()
  }

  return {
    describeRuntime: async () => {
      assertAvailable()
      return {
        component: 'sync',
        runtime: 'bare',
        instanceId: `sync-${processId}`,
        processId,
        contract: syncCompatibility.contract,
        protocolVersion: syncCompatibility.protocolVersion,
        capabilities: [...syncCompatibility.capabilities],
        buildVersion: syncCompatibility.buildVersion
      }
    },
    runtimeStatus: async () => {
      if (!runtime) throw new Error('Sync runtime lifecycle is unavailable')
      return runtime.status()
    },
    runtimeDiagnostics: async () => {
      if (!runtime) throw new Error('Sync runtime diagnostics are unavailable')
      const diagnostics = await runtime.diagnostics()
      return {
        children: diagnostics.children.map(({ name, state, deps, info }) => ({
          name,
          state,
          deps: [...deps],
          networkInstanceId:
            typeof info?.networkInstanceId === 'string'
              ? info.networkInstanceId
              : undefined,
          topicPresent:
            typeof info?.topicPresent === 'boolean' ? info.topicPresent : undefined,
          discoveryTeardownComplete:
            typeof info?.discoveryTeardownComplete === 'boolean'
              ? info.discoveryTeardownComplete
              : undefined
        }))
      }
    },
    suspend: async () => {
      if (!runtime) throw new Error('Sync runtime lifecycle is unavailable')
      await runtime.suspend()
      return { ok: true }
    },
    resume: async () => {
      if (!runtime) throw new Error('Sync runtime lifecycle is unavailable')
      await runtime.resume()
      return { ok: true }
    },
    meshStatus: async () => {
      if (!runtime) throw new Error('Sync mesh status is unavailable')
      return runtime.meshStatus()
    },
    watchMeshStatus: (input) => {
      if (!runtime) throw new Error('Sync mesh status is unavailable')
      return watchable(
        {
          watch: (listener) => runtime.onStatus(listener),
          unwatch: (listener) => runtime.offStatus(listener)
        },
        async () => runtime.meshStatus()
      )(input)
    },
    joinMesh: async ({ invite }) => {
      if (!runtime) throw new Error('Sync mesh lifecycle is unavailable')
      await runtime.join(invite)
      return { ok: true }
    },
    cancelMeshJoin: async () => {
      if (!runtime) throw new Error('Sync mesh lifecycle is unavailable')
      await runtime.cancelJoin()
      return { ok: true }
    },
    leaveMesh: async () => {
      if (!runtime) throw new Error('Sync mesh lifecycle is unavailable')
      await runtime.leave()
      return { ok: true }
    },
    listDevices: async () => {
      if (!runtime) throw new Error('Sync devices are unavailable')
      assertAvailable()
      return {
        devices: (await runtime.listDevices()).map((device) => ({
          ...device,
          revokedAt: device.revokedAt ?? undefined
        }))
      }
    },
    watchDevices: (input) => {
      if (!runtime) throw new Error('Sync devices are unavailable')
      return watchable(resources().mesh, async () => {
        assertAvailable()
        return {
          devices: (await runtime.listDevices()).map((device) => ({
            ...device,
            revokedAt: device.revokedAt ?? undefined
          }))
        }
      })(input)
    },
    renameDevice: async ({ name }) => {
      if (!runtime) throw new Error('Sync devices are unavailable')
      assertAvailable()
      const device = await runMutation(() => runtime.renameDevice(name))
      return { ...device, revokedAt: device.revokedAt ?? undefined }
    },
    removeDevice: async ({ id }) => {
      if (!runtime) throw new Error('Sync devices are unavailable')
      assertAvailable()
      await runMutation(() => runtime.removeDevice(id))
      return { ok: true }
    },
    getIdentity: async () => {
      assertAvailable()
      return { deviceId }
    },
    createPairingInvite: async (request) => {
      assertAvailable()
      return currentPairing().createInvite(request)
    },
    approvePairingRequest: async ({ id }) => {
      assertAvailable()
      return runMutation(() => currentPairing().approve(id))
    },
    rejectPairingRequest: async ({ id }) => {
      assertAvailable()
      return currentPairing().reject(id)
    },
    watchPairingRequests: (input) => {
      assertAvailable()
      const pairing = currentPairing()
      return watchable(pairing, async () => {
        assertAvailable()
        return { requests: pairing.listRequests() }
      })(input)
    },
    applyProfile: async (request) => {
      assertAvailable()
      assertProfileGeneration(request.generation)
      return runMutation(() =>
        currentMesh().applyProfile({
          ...request,
          expectedRevision: request.expectedRevision ?? undefined,
          deviceId,
          recordedAt: Date.now()
        })
      )
    },
    queryProfile: async (request) => {
      assertAvailable()
      assertProfileGeneration(request.generation)
      return { value: await currentMesh().queryProfile(request) }
    },
    watchProfile
  }
}

function validateCursor(after: string | null | undefined, generation: string) {
  if (!after) return
  const separator = after.indexOf(':')
  if (separator < 1 || after.slice(0, separator) !== generation) return
  const revision = after.slice(separator + 1)
  if (!/^(?:none|[0-9a-f]+)$/.test(revision)) {
    throw new Error('Sync watch cursor is invalid')
  }
}

function encodeCursor(generation: string, revision: string | null) {
  return `${generation}:${revision == null ? 'none' : Buffer.from(revision).toString('hex')}`
}
