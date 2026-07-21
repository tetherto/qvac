import { describe, expect, test } from 'bun:test'
import HRPC from '../../../packages/sync/spec/rpc/hrpc/index.js'
import { createIpcDuplex, type WorkletIPC } from './ipc-duplex.ts'
import {
  createMobileSyncClient,
  type MobileSyncBackend,
  type MobileSyncLaunchOptions,
  type MobileSyncTask,
  type MobileSyncTaskList,
  type MobileSyncWorklet
} from './mobile-sync-client.ts'
import { parsePairingUri } from './pairing-uri.ts'

describe('mobile Sync pairing URI', () => {
  test('parses the desktop blind-pairing invite without exposing mesh secrets', () => {
    expect(
      parsePairingUri(
        'qvac-poc://pair?invite=-_8AAQ&expiresAt=123000',
        100_000
      )
    ).toEqual({
      invite: '-_8AAQ',
      expiresAt: 123_000
    })
  })

  test('rejects malformed and expired pairing invites', () => {
    expect(() => parsePairingUri('https://example.com/pair', 100_000)).toThrow(
      'qvac-poc://pair'
    )
    expect(() =>
      parsePairingUri(
        'qvac-poc://pair?invite=not%20base64&expiresAt=123000',
        100_000
      )
    ).toThrow('invite')
    expect(() =>
      parsePairingUri(
        'qvac-poc://pair?invite=-_8AAQ&expiresAt=99999',
        100_000
      )
    ).toThrow('expired')
  })
})

describe('mobile Sync IPC transport', () => {
  test('preserves HRPC framing across fragmented BareKit IPC writes', async () => {
    const [hostIpc, workletIpc] = createIpcPair(3)
    const hostRpc = new HRPC(createIpcDuplex(hostIpc))
    const workletRpc = new HRPC(createIpcDuplex(workletIpc))
    workletRpc.onDescribeRuntime(async () => runtimeInfo())

    expect(await hostRpc.describeRuntime({})).toEqual(runtimeInfo())
  })
})

describe('Hermes mobile Sync client', () => {
  test('reports admission state and creates tasks only after writer approval', async () => {
    const approval = Promise.withResolvers<void>()
    const backend = createBackend({ ready: approval.promise })
    const states: string[] = []
    const client = createMobileSyncClient({
      storagePath: '/app/documents/qvac-sync',
      launch: launchBackend(backend),
      onState: (snapshot) => states.push(snapshot.state),
      createTaskId: () => 'phone-task-1'
    })

    const connecting = client.connect(
      'qvac-poc://pair?invite=-_8AAQ&expiresAt=123000',
      100_000
    )
    await Promise.resolve()
    expect(client.snapshot().state).toBe('awaiting-approval')
    await expect(client.createTask({ title: 'Before', input: 'No' })).rejects.toThrow(
      'not writable'
    )

    approval.resolve()
    await connecting
    expect(client.snapshot().state).toBe('writable')
    expect(
      await client.createTask({ title: 'Phone task', input: 'Summarize this' })
    ).toMatchObject({
      id: 'phone-task-1',
      title: 'Phone task',
      input: 'Summarize this',
      status: 'pending'
    })
    expect(states).toEqual(['connecting', 'awaiting-approval', 'writable'])
  })

  test('cleans task watches before reconnecting durable storage', async () => {
    const watch = createTaskWatch()
    const first = createBackend({ watch })
    const second = createBackend()
    const launches: MobileSyncLaunchOptions[] = []
    const worklets = [first, second]
    const client = createMobileSyncClient({
      storagePath: '/app/documents/qvac-sync',
      launch: async (options) => {
        launches.push(options)
        const backend = worklets.shift()
        if (!backend) throw new Error('Unexpected launch')
        return worklet(backend)
      }
    })

    await client.connect(
      'qvac-poc://pair?invite=-_8AAQ&expiresAt=123000',
      100_000
    )
    const stop = client.watchTasks(() => {})
    await watch.started
    await client.reconnect()

    expect(watch.destroyed).toBe(1)
    expect(launches).toHaveLength(2)
    expect(launches[0]?.storagePath).toBe('/app/documents/qvac-sync')
    expect(launches[0]?.invite).toBe('-_8AAQ')
    expect(launches[1]?.storagePath).toBe('/app/documents/qvac-sync')
    expect(launches[1]?.invite).toBeUndefined()
    expect(client.snapshot().state).toBe('writable')
    stop()
  })

  test('moves offline when the Worklet disconnects', async () => {
    let disconnect: (() => void) | undefined
    const client = createMobileSyncClient({
      storagePath: '/app/documents/qvac-sync',
      launch: async (options) => {
        disconnect = options.onDisconnect
        return worklet(createBackend())
      }
    })

    await client.connect()
    disconnect?.()
    expect(client.snapshot().state).toBe('offline')
  })

  test('shows application results without internal Harness records', async () => {
    const backend = createBackend({
      tasks: [
        task({
          id: 'phone-task-1',
          result: JSON.stringify({ result: 'factorial answer', error: null })
        }),
        task({
          id: '@harness/task-phone-task-1',
          result: JSON.stringify([{ type: 'content', text: 'internal event' }])
        })
      ]
    })
    const client = createMobileSyncClient({
      storagePath: '/app/documents/qvac-sync',
      launch: launchBackend(backend)
    })

    await client.connect()

    expect(await client.listTasks()).toEqual({
      tasks: [
        expect.objectContaining({
          id: 'phone-task-1',
          result: 'factorial answer'
        })
      ]
    })
  })
})

function runtimeInfo() {
  return {
    component: 'sync',
    runtime: 'bare',
    instanceId: 'sync-mobile',
    processId: 0,
    contract: 'qvac.sync',
    protocolVersion: 1,
    capabilities: ['tasks', 'task-watches', 'writer-pairing'],
    buildVersion: '0.0.0-poc'
  }
}

function createBackend(
  options: {
    readonly ready?: Promise<void>
    readonly watch?: ReturnType<typeof createTaskWatch>
    readonly tasks?: readonly MobileSyncTask[]
  } = {}
): MobileSyncBackend {
  const tasks: MobileSyncTask[] = [...(options.tasks ?? [])]
  return {
    async ready() {
      await options.ready
    },
    async close() {},
    async describeRuntime() {
      return runtimeInfo()
    },
    async createTask(request) {
      const task: MobileSyncTask = {
        ...request,
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
        originDeviceId: new Uint8Array([1])
      }
      tasks.push(task)
      return task
    },
    async listTasks() {
      return { tasks }
    },
    watchTasks() {
      return options.watch ?? createTaskWatch()
    }
  }
}

function task(
  overrides: Partial<MobileSyncTask> & Pick<MobileSyncTask, 'id'>
): MobileSyncTask {
  return {
    title: 'Task',
    input: 'Prompt',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    originDeviceId: new Uint8Array([1]),
    ...overrides
  }
}

function launchBackend(backend: MobileSyncBackend) {
  return async function launch() {
    return worklet(backend)
  }
}

function worklet(backend: MobileSyncBackend): MobileSyncWorklet {
  return {
    backend,
    terminate() {}
  }
}

function createTaskWatch() {
  let resolveStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  let destroyed = 0
  const watch = {
    started,
    get destroyed() {
      return destroyed
    },
    destroy() {
      destroyed += 1
    },
    async *[Symbol.asyncIterator](): AsyncIterator<MobileSyncTaskList> {
      resolveStarted?.()
      await new Promise<void>(() => {})
      yield { tasks: [] }
    }
  }
  return watch
}

interface IpcListenerMap {
  data: (data: Uint8Array) => void
  error: (error: Error) => void
  close: () => void
  end: () => void
}

interface IpcEndpoint {
  readonly ipc: WorkletIPC
  emit<Event extends keyof IpcListenerMap>(
    event: Event,
    ...args: Parameters<IpcListenerMap[Event]>
  ): void
  connect(next: IpcEndpoint): void
}

function createIpcPair(fragmentSize: number): [WorkletIPC, WorkletIPC] {
  const left = createIpcEndpoint(fragmentSize)
  const right = createIpcEndpoint(fragmentSize)
  left.connect(right)
  right.connect(left)
  return [left.ipc, right.ipc]
}

function createIpcEndpoint(fragmentSize: number): IpcEndpoint {
  const listeners = new Map<keyof IpcListenerMap, Set<IpcListenerMap[keyof IpcListenerMap]>>()
  let peer: IpcEndpoint | null = null

  function emit<Event extends keyof IpcListenerMap>(
    event: Event,
    ...args: Parameters<IpcListenerMap[Event]>
  ) {
    for (const listener of listeners.get(event) ?? []) {
      Reflect.apply(listener, null, args)
    }
  }

  const ipc: WorkletIPC = {
    on(event, listener) {
      const registered = listeners.get(event) ?? new Set()
      registered.add(listener)
      listeners.set(event, registered)
      return ipc
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
      return ipc
    },
    write(data) {
      if (!peer) throw new Error('IPC peer is not connected')
      for (let offset = 0; offset < data.byteLength; offset += fragmentSize) {
        const fragment = data.slice(offset, offset + fragmentSize)
        queueMicrotask(() => peer?.emit('data', fragment))
      }
      return true
    }
  }

  return {
    ipc,
    emit,
    connect(next: IpcEndpoint) {
      peer = next
    }
  }
}
