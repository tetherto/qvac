import launcher from '../../react-native-launcher.ts'
import type {
  CreateSyncOptions,
  SyncRuntime
} from './types.ts'
import type { SyncClient } from '../client.ts'
import { SyncGenerationEndedError, toSyncError } from './errors.ts'
import {
  assertCompatibleRuntime,
  syncCompatibility
} from './compatibility.ts'
import { configForSyncRuntime } from '../config.ts'

export function createMobileSync(options: CreateSyncOptions): SyncRuntime {
  const config = configForSyncRuntime(options.logging)
  let client: SyncClient | null = null
  let terminate: (() => Promise<void>) | null = null
  let readyPromise: Promise<void> | null = null
  let closePromise: Promise<void> | null = null
  let terminalError: Error | null = null
  let openEpoch = 0
  let failedStatus: Awaited<ReturnType<SyncClient['runtimeStatus']>> | null = null
  let exitResolved = false
  let resolveExit!: (exit: { kind: 'closed' | 'crashed'; code: null; signal: null }) => void
  const exited = new Promise<{
    kind: 'closed' | 'crashed'
    code: null
    signal: null
  }>((resolve) => {
    resolveExit = resolve
  })
  const profiles = new Set<{
    endWatches(error: Error): void
    endGeneration(error: Error): void
  }>()

  async function ready() {
    if (closePromise) throw new Error('Sync runtime is closed')
    if (terminalError) throw terminalError
    if (client) return
    if (!readyPromise) readyPromise = open(openEpoch)
    try {
      await readyPromise
      if (closePromise) throw new Error('Sync runtime is closed')
      if (terminalError) throw terminalError
    } catch (error) {
      if (!closePromise) readyPromise = null
      throw error
    }
  }

  async function open(epoch: number) {
    const started = await launcher.launch({
      ...options,
      config,
      onDisconnect: () => {
        client = null
        if (!closePromise) {
          terminalError = new Error('Sync worker crashed')
          failedStatus = failedStatus && {
            ...failedStatus,
            phase: 'failed',
            network: 'stopped',
            writable: false,
            peerCount: 0
          }
          endProfiles()
        }
        settleExit(closePromise ? 'closed' : 'crashed')
      }
    })
    terminate = started.terminate
    const nextClient = started.backend as SyncClient
    try {
      await nextClient.ready()
      const described = await nextClient.describeRuntime()
      assertCompatibleRuntime(syncCompatibility, {
        contract: described.contract,
        protocolVersion: described.protocolVersion,
        capabilities: described.capabilities,
        requiredPeerCapabilities: [],
        buildVersion: described.buildVersion
      })
      failedStatus = await nextClient.runtimeStatus()
      if (closePromise || epoch !== openEpoch) {
        throw new Error('Sync runtime is closed')
      }
      if (terminalError) throw terminalError
      client = nextClient
    } catch (error) {
      await nextClient.close().catch(() => {})
      await started.terminate().catch(() => {})
      if (terminate === started.terminate) terminate = null
      throw error
    }
  }

  function requireClient() {
    if (closePromise) throw new Error('Sync runtime is closed')
    if (terminalError) throw terminalError
    if (!client) throw new Error('Sync runtime is not ready')
    return client
  }

  async function suspend() {
    await ready()
    const error = new Error('Sync runtime is suspended')
    for (const profile of profiles) profile.endWatches(error)
    await requireClient().suspend()
  }

  async function resume() {
    await ready()
    await requireClient().resume()
    endProfiles()
  }

  function close() {
    if (closePromise) return closePromise
    closePromise = (async () => {
      openEpoch++
      await readyPromise?.catch(() => {})
      const opened = client
      client = null
      endProfiles()
      if (opened) await opened.close().catch(() => {})
      await terminate?.()
      terminate = null
      settleExit('closed')
    })()
    return closePromise
  }

  return {
    exited,
    ready,
    suspend,
    resume,
    close,
    lifecycle: { suspend, resume },
    runtime: {
      async describe() {
        await ready()
        return requireClient().describeRuntime()
      },
      async status() {
        if (terminalError && failedStatus) return failedStatus
        await ready()
        return requireClient().runtimeStatus()
      },
      async diagnostics() {
        await ready()
        return requireClient().runtimeDiagnostics()
      }
    },
    mesh: {
      async identity() {
        await ready()
        return requireClient().getIdentity()
      },
      async status() {
        await ready()
        return requireClient().meshStatus()
      },
      watchStatus(options = {}) {
        const source = requireClient().watchMeshStatus()
        return (async function* () {
          try {
            for await (const status of source) {
              if (options.signal?.aborted) return
              yield status
            }
          } catch (error) {
            throw toSyncError(error)
          } finally {
            source.destroy()
          }
        })()
      },
      createInvite(options = {}) {
        return requireClient().createPairingInvite(options)
      },
      watchPairingRequests() {
        return sanitizeWatch(requireClient().watchPairingRequests())
      },
      approvePairingRequest(id) {
        return requireClient().approvePairingRequest({ id })
      },
      rejectPairingRequest(id) {
        return requireClient().rejectPairingRequest({ id })
      },
      async join(invite) {
        await requireClient().joinMesh(invite)
        endProfiles()
      },
      async cancelJoin() {
        await requireClient().cancelMeshJoin()
      },
      async leave() {
        await requireClient().leaveMesh()
        endProfiles()
      },
      async listDevices() {
        return (await requireClient().listDevices()).devices
      },
      watchDevices() {
        const watch = requireClient().watchDevices()
        return (async function* () {
          try {
            for await (const frame of watch) yield frame.devices
          } catch (error) {
            throw toSyncError(error)
          } finally {
            watch.destroy()
          }
        })()
      },
      renameDevice(name) {
        return requireClient().renameDevice({ name })
      },
      removeDevice(id) {
        return requireClient().removeDevice(id)
      }
    },
    openProfile(profile) {
      const opened = requireClient().openProfile(profile)
      profiles.add(opened)
      return opened
    }
  }

  function endProfiles() {
    const error = new SyncGenerationEndedError()
    for (const profile of profiles) profile.endGeneration(error)
    profiles.clear()
  }

  function settleExit(kind: 'closed' | 'crashed') {
    if (exitResolved) return
    exitResolved = true
    resolveExit({ kind, code: null, signal: null })
  }

  function sanitizeWatch<T>(
    source: AsyncIterable<T> & { destroy(error?: Error): void }
  ): AsyncIterable<T> {
    return (async function* () {
      try {
        for await (const value of source) yield value
      } catch (error) {
        throw toSyncError(error)
      } finally {
        source.destroy()
      }
    })()
  }
}
