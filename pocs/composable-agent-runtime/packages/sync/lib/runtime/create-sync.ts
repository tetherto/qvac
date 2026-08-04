import { SyncClient } from '../client.ts'
import {
  SyncGenerationEndedError,
  SyncSuspendedError,
  toSyncError
} from './errors.ts'
import {
  assertCompatibleRuntime,
  syncCompatibility
} from './compatibility.ts'
import {
  launchDesktopSync,
  type DesktopSyncWorker
} from './desktop-launcher.ts'
import type {
  CreateSyncOptions,
  SyncMeshStatus,
  SyncRuntime,
  SyncRuntimeExit
} from './types.ts'

export type {
  CreateSyncOptions,
  SyncMeshDevice,
  SyncMeshStatus,
  SyncRuntime,
  SyncRuntimeExit
} from './types.ts'

export function createSync(options: CreateSyncOptions): SyncRuntime {
  return createDesktopSyncRuntime(options)
}

function createDesktopSyncRuntime(options: CreateSyncOptions): SyncRuntime {
  let worker: DesktopSyncWorker | null = null
  let client: SyncClient | null = null
  let readyPromise: Promise<void> | null = null
  let closePromise: Promise<void> | null = null
  let terminalError: Error | null = null
  let failedStatus: Awaited<ReturnType<SyncClient['runtimeStatus']>> | null = null
  let openEpoch = 0
  let resolveExit!: (exit: SyncRuntimeExit) => void
  const exited = new Promise<SyncRuntimeExit>((resolve) => {
    resolveExit = resolve
  })
  const profileClients = new Set<{
    endWatches(error: Error): void
    endGeneration(error: Error): void
  }>()

  async function ready() {
    if (closePromise) throw closedError()
    if (terminalError) throw terminalError
    if (client) return
    if (readyPromise) {
      await readyPromise
      if (closePromise) throw closedError()
      if (terminalError) throw terminalError
      return
    }
    readyPromise = open()
    try {
      await readyPromise
      if (closePromise) throw closedError()
    } catch (error) {
      if (!closePromise) readyPromise = null
      throw error
    }
  }

  async function open() {
    const epoch = openEpoch
    const nextWorker = await launchDesktopSync({
      storagePath: options.storagePath,
      bootstrap: options.bootstrap,
      meshSeed: options.meshSeed,
      meshKey: options.meshKey,
      pairingInvite: options.pairingInvite,
      logging: options.logging
    })
    const nextClient = nextWorker.client
    void nextClient.exited.then(({ code, signal }) => {
      if (!closePromise) {
        terminalError = new Error('Sync worker crashed')
        client = null
        failedStatus = failedStatus && {
          ...failedStatus,
          phase: 'failed',
          network: 'stopped',
          writable: false,
          peerCount: 0
        }
        endProfileGeneration()
      }
      resolveExit({
        kind: closePromise ? 'closed' : 'crashed',
        code,
        signal
      })
    })
    try {
      await assertClientCompatible(nextClient)
      failedStatus = await nextClient.runtimeStatus()
      assertOpenEpoch(epoch)
      if (terminalError) throw terminalError

      worker = nextWorker
      client = nextClient
    } catch (error) {
      if (client === nextClient) client = null
      if (worker === nextWorker) worker = null
      await nextWorker.close().catch(() => {})
      throw error
    }
  }

  async function suspend() {
    assertNotClosed()
    await ready()
    const error = new SyncSuspendedError()
    for (const profile of profileClients) profile.endWatches(error)
    await requireClient().suspend()
  }

  async function resume() {
    assertNotClosed()
    await ready()
    await requireClient().resume()
    endProfileGeneration()
  }

  function endProfileGeneration() {
    const error = new SyncGenerationEndedError()
    for (const profile of profileClients) profile.endGeneration(error)
    profileClients.clear()
  }

  async function close() {
    if (closePromise) return closePromise
    closePromise = closeResources()
    await closePromise
  }

  async function closeResources() {
    openEpoch += 1
    const error = closedError()
    for (const profile of profileClients) profile.endGeneration(error)
    profileClients.clear()
    if (readyPromise) await readyPromise.catch(() => {})

    const openedClient = client
    const openedWorker = worker
    client = null
    worker = null
    readyPromise = null

    if (openedWorker) await openedWorker.close()
    else if (openedClient) await openedClient.close().catch(() => {})
  }

  function assertOpenEpoch(epoch: number) {
    if (closePromise || epoch !== openEpoch) throw closedError()
  }

  function assertNotClosed() {
    if (closePromise) throw closedError()
  }

  function requireClient() {
    assertNotClosed()
    if (terminalError) throw terminalError
    if (!client) throw new Error('Sync runtime is not ready')
    return client
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
        return createStatusWatch(options.signal)
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
        assertNotClosed()
        await ready()
        await requireClient().joinMesh(invite)
        endProfileGeneration()
      },
      async cancelJoin() {
        assertNotClosed()
        await ready()
        await requireClient().cancelMeshJoin()
      },
      async leave() {
        assertNotClosed()
        await ready()
        await requireClient().leaveMesh()
        endProfileGeneration()
      },
      async listDevices() {
        await ready()
        return (await requireClient().listDevices()).devices
      },
      watchDevices() {
        return (async function* () {
          await ready()
          const watch = requireClient().watchDevices()
          try {
            for await (const value of watch) yield value.devices
          } catch (error) {
            throw toSyncError(error)
          } finally {
            watch.destroy()
          }
        })()
      },
      async renameDevice(name) {
        await ready()
        return requireClient().renameDevice({ name })
      },
      async removeDevice(id) {
        await ready()
        await requireClient().removeDevice(id)
      }
    },
    openProfile(profile) {
      const opened = requireClient().openProfile(profile)
      profileClients.add(opened)
      return opened
    }
  }

  function createStatusWatch(signal?: AbortSignal): AsyncIterable<SyncMeshStatus> {
    return (async function* () {
      await ready()
      const watch = requireClient().watchMeshStatus()
      try {
        for await (const status of watch) {
          if (signal?.aborted || closePromise) return
          yield status
        }
      } catch (error) {
        throw toSyncError(error)
      } finally {
        watch.destroy()
      }
    })()
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

  async function assertClientCompatible(openedClient: SyncClient) {
    const described = await openedClient.describeRuntime()
    assertCompatibleRuntime(syncCompatibility, {
      contract: described.contract,
      protocolVersion: described.protocolVersion,
      capabilities: described.capabilities,
      requiredPeerCapabilities: [],
      buildVersion: described.buildVersion
    })
  }
}

function closedError() {
  return new Error('Sync runtime is closed')
}
