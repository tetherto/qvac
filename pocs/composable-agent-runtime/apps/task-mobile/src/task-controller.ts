import {
  createAssistant,
  type AssistantFacade,
  type AssistantRunInput
} from '@qvac/assistant'
import {
  createReplicatedTaskRepository,
  type ReplicatedTask,
  type ReplicatedTaskRepository
} from '@qvac-poc/task-shared/sync-store'
import { parsePairingUri } from './pairing-uri.ts'

const TASK_PREFIX = 'phone-'
const COMPATIBLE_TASK_PREFIX = 'task-cli/task/'
const STREAM_PERSIST_INTERVAL_MS = 250

export type TaskControllerState =
  | 'idle'
  | 'connecting'
  | 'awaiting-approval'
  | 'writable'
  | 'offline'
  | 'error'

export interface TaskControllerSnapshot {
  readonly state: TaskControllerState
  readonly error: string | null
}

export interface TaskControllerTaskList {
  readonly tasks: TaskControllerTask[]
}

interface ActiveRun {
  readonly controller: AbortController
  readonly completion: Promise<void>
}

type TaskAssistantFacade = Pick<
  AssistantFacade,
  'ready' | 'registerAgent' | 'run' | 'close' | 'onLifecycle'
> & {
  readonly state: object
}

export type TaskControllerTask = ReplicatedTask

export interface TaskControllerOptions {
  readonly storagePath: string
  readonly onState?: (snapshot: TaskControllerSnapshot) => void
  readonly createAssistant?: (options: {
    readonly storagePath: string
    readonly invite?: string
  }) => TaskAssistantFacade
  readonly createTaskRepository?: (
    state: object
  ) => ReplicatedTaskRepository
  readonly hasPersistentPairing?: () => boolean
  readonly createTaskId?: () => string
}

export interface TaskController {
  snapshot(): TaskControllerSnapshot
  connect(pairingUri?: string, now?: number): Promise<void>
  reconnect(): Promise<void>
  disconnect(): Promise<void>
  createTask(request: { readonly title: string; readonly input: string }): Promise<TaskControllerTask>
  cancelTask(taskId: string, reason?: string): Promise<boolean>
  watchTasks(listener: (tasks: readonly TaskControllerTask[]) => void): () => void
}

export function createTaskController(options: TaskControllerOptions): TaskController {
  let current: TaskControllerSnapshot = { state: 'idle', error: null }
  let assistant: TaskAssistantFacade | null = null
  let stopLifecycle: (() => void) | null = null
  let generation = 0
  const activeRuns = new Map<string, ActiveRun>()
  const stopWatches = new Set<() => void>()
  const createTaskId = options.createTaskId ?? defaultTaskId
  const createMobileAssistant = options.createAssistant ?? createAssistant
  const createTasks =
    options.createTaskRepository ??
    ((state: object) =>
      createReplicatedTaskRepository(
        state as Pick<AssistantFacade['state'], 'work'>
      ))
  const hasPersistentPairing = options.hasPersistentPairing ?? (() => false)

  function snapshot() {
    return current
  }

  async function connect(pairingUri?: string, now?: number) {
    await closeAssistant(++generation)
    const invite = pairingUri ? parsePairingUri(pairingUri, now).invite : undefined
    const currentGeneration = generation
    update({ state: 'connecting', error: null })
    if (invite) {
      update({ state: 'awaiting-approval', error: null })
    }

    const started = createMobileAssistant({
      storagePath: options.storagePath,
      ...(invite ? { invite } : {})
    })
    const stopStartedLifecycle = started.onLifecycle((event) => {
      if (currentGeneration !== generation) return
      if (event.type === 'child-died' || event.type === 'gave-up') {
        void closeAssistant(++generation).finally(() => {
          update({ state: 'offline', error: event.error?.message ?? null })
        })
      }
    })
    try {
      await started.ready()
      await started.registerAgent({
        id: 'task-mobile-runner',
        model:
          'registry://hf/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf',
        skills: [],
        toolPolicy: { allow: [], requireApproval: [] }
      })
      if (currentGeneration !== generation) {
        stopStartedLifecycle()
        await started.close()
        return
      }
      assistant = started
      stopLifecycle = stopStartedLifecycle
      update({ state: 'writable', error: null })
    } catch (error) {
      stopStartedLifecycle()
      await started.close().catch(() => {})
      if (currentGeneration === generation) {
        update({ state: 'error', error: errorMessage(error) })
      }
      throw error
    }
  }

  async function reconnect() {
    if (!hasPersistentPairing()) {
      update({ state: 'idle', error: null })
      return
    }
    await connect()
  }

  async function disconnect() {
    await closeAssistant(++generation)
    update({ state: 'offline', error: null })
  }

  async function createTask(request: { readonly title: string; readonly input: string }) {
    const runtime = writableAssistant()
    const tasks = taskRepository(runtime)
    const taskId = createTaskId()
    const created = await tasks.create({
      id: taskId,
      title: request.title,
      input: request.input
    })
    const run = executeTask(runtime, created.id, request.input)
    activeRuns.set(created.id, run)
    await run.completion
    const latest = await tasks.get(created.id)
    return projectTaskResult(latest ?? created)
  }

  async function cancelTask(taskId: string, reason = 'Task cancelled') {
    const running = activeRuns.get(taskId)
    if (!running) return false
    running.controller.abort(reason)
    await running.completion
    return true
  }

  function watchTasks(listener: (tasks: readonly TaskControllerTask[]) => void) {
    const runtime = writableAssistant()
    const iterator = taskRepository(runtime).watch()[Symbol.asyncIterator]()
    let stopped = false

    async function consume() {
      while (!stopped) {
        const next = await iterator.next()
        if (stopped || next.done) return
        listener(
          visibleTasks(
            projectApplicationTasks({ tasks: [...next.value] }).tasks
          )
        )
      }
    }

    void consume().catch((error) => {
      if (stopped) return
      update({ state: 'error', error: errorMessage(error) })
    })

    function stop() {
      if (stopped) return
      stopped = true
      stopWatches.delete(stop)
      void iterator.return?.()
    }

    stopWatches.add(stop)
    return stop
  }

  function executeTask(
    runtime: TaskAssistantFacade,
    taskId: string,
    prompt: string
  ): ActiveRun {
    const controller = new AbortController()
    const completion = runTask(runtime, taskId, prompt, controller).finally(() => {
      activeRuns.delete(taskId)
    })
    return { controller, completion }
  }

  async function runTask(
    runtime: TaskAssistantFacade,
    taskId: string,
    prompt: string,
    controller: AbortController
  ) {
    let output = ''
    let lastPersistedAt = 0
    const tasks = taskRepository(runtime)
    await tasks.update({ id: taskId, status: 'running', result: null })
    try {
      for await (const event of createRun(runtime, taskId, prompt, controller.signal)) {
        if (event.type === 'content') {
          output += event.text ?? ''
          const now = Date.now()
          if (now - lastPersistedAt >= STREAM_PERSIST_INTERVAL_MS) {
            lastPersistedAt = now
            await tasks.update({
              id: taskId,
              status: 'running',
              result: taskResultEnvelope(output, null)
            })
          }
          continue
        }
        if (event.type === 'error') {
          throw new Error(event.message)
        }
        if (event.type === 'aborted') {
          throw new Error(abortMessage(controller.signal.reason))
        }
      }
      await tasks.update({
        id: taskId,
        status: 'completed',
        result: taskResultEnvelope(output, null)
      })
    } catch (error) {
      const aborted = controller.signal.aborted
      await tasks.update({
        id: taskId,
        status: aborted ? 'cancelled' : 'failed',
        result: taskResultEnvelope(output, aborted ? abortMessage(controller.signal.reason) : errorMessage(error))
      })
    }
  }

  function createRun(
    runtime: TaskAssistantFacade,
    taskId: string,
    prompt: string,
    signal: AbortSignal
  ) {
    const input: AssistantRunInput = {
      agentId: 'task-mobile-runner',
      runId: `task-${taskId}`,
      input: prompt,
      signal
    }
    return runtime.run(input)
  }

  async function closeAssistant(nextGeneration: number) {
    generation = nextGeneration
    stopAllWatches()
    for (const run of [...activeRuns.values()]) {
      run.controller.abort('Controller disconnected')
    }
    await Promise.allSettled([...activeRuns.values()].map((run) => run.completion))
    activeRuns.clear()
    stopLifecycle?.()
    stopLifecycle = null
    if (!assistant) return
    const closing = assistant
    assistant = null
    await closing.close()
  }

  function writableAssistant() {
    if (!assistant || current.state !== 'writable') {
      throw new Error('Mobile assistant is not writable')
    }
    return assistant
  }

  function stopAllWatches() {
    for (const stop of [...stopWatches]) {
      stop()
    }
  }

  function update(next: TaskControllerSnapshot) {
    current = next
    options.onState?.(next)
  }

  function taskRepository(runtime: TaskAssistantFacade) {
    return createTasks(runtime.state)
  }

  return {
    snapshot,
    connect,
    reconnect,
    disconnect,
    createTask,
    cancelTask,
    watchTasks
  }
}

function projectApplicationTasks(snapshot: TaskControllerTaskList): TaskControllerTaskList {
  return {
    tasks: snapshot.tasks
      .filter(
        (task) =>
          task.id.startsWith(TASK_PREFIX) || task.id.startsWith(COMPATIBLE_TASK_PREFIX)
      )
      .map(projectTaskResult)
  }
}

function projectTaskResult(task: TaskControllerTask): TaskControllerTask {
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

function visibleTasks(tasks: readonly TaskControllerTask[]) {
  return [...tasks].sort((left, right) => right.updatedAt - left.updatedAt)
}

function defaultTaskId() {
  const entropy = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(36)
    .padStart(7, '0')
  return `${TASK_PREFIX}${Date.now().toString(36)}-${entropy}`
}

function abortMessage(reason: unknown) {
  if (typeof reason === 'string' && reason.length > 0) return reason
  return 'Task execution aborted'
}

function taskResultEnvelope(result: string, error: string | null) {
  return JSON.stringify({
    result: result.length > 0 ? result : null,
    error
  })
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  // A component start failure wraps the reason it failed. Showing only the
  // outer message leaves "sync failed to start" with no way to find out why.
  const causes: string[] = []
  let cause: unknown = error.cause
  while (cause instanceof Error && causes.length < 4) {
    causes.push(cause.message)
    cause = cause.cause
  }
  if (causes.length > 0) console.error('[task-mobile]', error.message, causes)
  return causes.length > 0 ? `${error.message}: ${causes.join(': ')}` : error.message
}
