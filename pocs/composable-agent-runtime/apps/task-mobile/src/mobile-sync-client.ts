import type { PairingInvite } from './pairing-uri.ts'
import { parsePairingUri } from './pairing-uri.ts'

export type MobileSyncState =
  | 'idle'
  | 'connecting'
  | 'awaiting-approval'
  | 'writable'
  | 'offline'
  | 'error'

export interface MobileSyncSnapshot {
  readonly state: MobileSyncState
  readonly error: string | null
}

export interface MobileSyncTask {
  readonly id: string
  readonly title: string
  readonly input: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly result?: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly originDeviceId: Uint8Array
}

export interface MobileSyncTaskList {
  readonly tasks: MobileSyncTask[]
}

export interface MobileSyncTaskWatch extends AsyncIterable<MobileSyncTaskList> {
  destroy(error?: Error): void
}

export interface MobileSyncBackend {
  ready(): Promise<void>
  close(): Promise<void>
  describeRuntime(): Promise<{
    readonly contract: string
    readonly capabilities: readonly string[]
  }>
  createTask(request: {
    readonly id: string
    readonly title: string
    readonly input: string
  }): Promise<MobileSyncTask>
  listTasks(): Promise<MobileSyncTaskList>
  watchTasks(): MobileSyncTaskWatch
}

export interface MobileSyncLaunchOptions {
  readonly storagePath: string
  readonly invite?: string
  readonly onDisconnect: () => void
}

export interface MobileSyncWorklet {
  readonly backend: MobileSyncBackend
  terminate(): void
}

export interface MobileSyncClientOptions {
  readonly storagePath: string
  readonly launch: (options: MobileSyncLaunchOptions) => Promise<MobileSyncWorklet>
  readonly onState?: (snapshot: MobileSyncSnapshot) => void
  readonly createTaskId?: () => string
}

export interface MobileSyncClient {
  snapshot(): MobileSyncSnapshot
  connect(pairingUri?: string, now?: number): Promise<void>
  reconnect(): Promise<void>
  disconnect(): Promise<void>
  createTask(request: { readonly title: string; readonly input: string }): Promise<MobileSyncTask>
  listTasks(): Promise<MobileSyncTaskList>
  watchTasks(listener: (tasks: readonly MobileSyncTask[]) => void): () => void
}

export function createMobileSyncClient(options: MobileSyncClientOptions): MobileSyncClient {
  let current: MobileSyncSnapshot = { state: 'idle', error: null }
  let active: MobileSyncWorklet | null = null
  let generation = 0
  const stopWatches = new Set<() => void>()
  const createTaskId = options.createTaskId ?? defaultTaskId

  function snapshot() {
    return current
  }

  async function connect(pairingUri?: string, now?: number) {
    if (active) await closeActive()
    const pairing = pairingUri ? parsePairingUri(pairingUri, now) : null
    const currentGeneration = ++generation
    update({ state: 'connecting', error: null })
    if (pairing) update({ state: 'awaiting-approval', error: null })

    try {
      const launched = await options.launch({
        storagePath: options.storagePath,
        ...(pairing ? { invite: pairing.invite } : {}),
        onDisconnect() {
          if (generation !== currentGeneration) return
          active = null
          stopAllWatches()
          update({ state: 'offline', error: null })
        }
      })
      if (generation !== currentGeneration) {
        launched.terminate()
        return
      }
      active = launched
      await launched.backend.ready()
      const runtime = await launched.backend.describeRuntime()
      validateRuntime(runtime)
      if (generation === currentGeneration) {
        update({ state: 'writable', error: null })
      }
    } catch (error) {
      if (generation === currentGeneration) {
        active?.terminate()
        active = null
        update({ state: 'error', error: errorMessage(error) })
      }
      throw error
    }
  }

  async function reconnect() {
    await closeActive()
    await connect()
  }

  async function disconnect() {
    generation += 1
    await closeActive()
    update({ state: 'offline', error: null })
  }

  async function createTask(request: { readonly title: string; readonly input: string }) {
    const backend = writableBackend()
    return backend.createTask({
      id: createTaskId(),
      title: request.title,
      input: request.input
    })
  }

  async function listTasks() {
    return projectApplicationTasks(await writableBackend().listTasks())
  }

  function watchTasks(listener: (tasks: readonly MobileSyncTask[]) => void) {
    const watch = writableBackend().watchTasks()
    let stopped = false

    function stop() {
      if (stopped) return
      stopped = true
      stopWatches.delete(stop)
      watch.destroy()
    }

    stopWatches.add(stop)
    void consumeWatch(watch, listener, () => stopped).catch((error) => {
      if (stopped) return
      stop()
      update({ state: 'error', error: errorMessage(error) })
    })
    return stop
  }

  async function closeActive() {
    stopAllWatches()
    const closing = active
    active = null
    if (!closing) return
    try {
      await closing.backend.close()
    } finally {
      closing.terminate()
    }
  }

  function stopAllWatches() {
    for (const stop of [...stopWatches]) stop()
  }

  function writableBackend() {
    if (current.state !== 'writable' || !active) {
      throw new Error('Mobile Sync writer is not writable')
    }
    return active.backend
  }

  function update(next: MobileSyncSnapshot) {
    current = next
    options.onState?.(next)
  }

  return {
    snapshot,
    connect,
    reconnect,
    disconnect,
    createTask,
    listTasks,
    watchTasks
  }
}

async function consumeWatch(
  watch: MobileSyncTaskWatch,
  listener: (tasks: readonly MobileSyncTask[]) => void,
  stopped: () => boolean
) {
  for await (const snapshot of watch) {
    if (stopped()) return
    listener(projectApplicationTasks(snapshot).tasks)
  }
}

function projectApplicationTasks(snapshot: MobileSyncTaskList): MobileSyncTaskList {
  return {
    tasks: snapshot.tasks
      .filter(
        (task) =>
          task.id.startsWith('phone-') || task.id.startsWith('task-cli/task/')
      )
      .map(projectTaskResult)
  }
}

function projectTaskResult(task: MobileSyncTask): MobileSyncTask {
  if (!task.result) return task
  try {
    const value: unknown = JSON.parse(task.result)
    if (typeof value !== 'object' || value === null) return task
    const result = Reflect.get(value, 'result')
    const error = Reflect.get(value, 'error')
    if (typeof result === 'string') return { ...task, result }
    if (typeof error === 'string') return { ...task, result: `Error: ${error}` }
    return { ...task, result: null }
  } catch {
    return task
  }
}

function validateRuntime(runtime: {
  readonly contract: string
  readonly capabilities: readonly string[]
}) {
  if (runtime.contract !== 'qvac.sync') {
    throw new Error(`Unexpected Sync contract: ${runtime.contract}`)
  }
  for (const capability of ['tasks', 'task-watches', 'writer-pairing']) {
    if (!runtime.capabilities.includes(capability)) {
      throw new Error(`Sync runtime is missing capability: ${capability}`)
    }
  }
}

function defaultTaskId() {
  const entropy = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(36)
    .padStart(7, '0')
  return `phone-${Date.now().toString(36)}-${entropy}`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export type { PairingInvite }
