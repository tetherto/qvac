export interface UserProfile {
  id: string
  name: string
  age: number
  deviceIds: readonly string[]
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface Task {
  id: string
  text: string
  order: number
  status: TaskStatus
  result?: string
  error?: string
}

export interface TaskStore {
  loadCurrentUser(): Promise<UserProfile>
  listTasks(userId: string): Promise<readonly Task[]>
  saveTask(userId: string, task: Task): Promise<void>
  watchTasks?(): AsyncIterable<readonly Task[] | void>
}

export interface TaskRunEvent {
  type: 'content' | 'status'
  text?: string
}

export interface TaskRunner {
  run(input: {
    taskId: string
    prompt: string
    user: Pick<UserProfile, 'id' | 'name' | 'age'>
    signal?: AbortSignal
  }): AsyncIterable<TaskRunEvent>
}

export interface TaskOutcome {
  taskId: string
  status: 'completed' | 'failed'
}

export interface RunTaskOptions {
  readonly signal?: AbortSignal
  readonly partialSnapshotIntervalMs?: number
}

export interface WatchTaskOptions extends RunTaskOptions {
  readonly onStaleTasks?: (tasks: readonly Task[]) => void
}

export async function processIncompleteTasks(
  store: TaskStore,
  runner: TaskRunner,
  options: RunTaskOptions = {}
): Promise<readonly TaskOutcome[]> {
  const user = await store.loadCurrentUser()
  const tasks = [...(await store.listTasks(user.id))]
    .filter((task) => task.status === 'pending')
    .sort(compareTasks)
  const outcomes: TaskOutcome[] = []

  for (const task of tasks) {
    outcomes.push(await processTask(store, runner, user, task, options))
    if (options.signal?.aborted) break
  }

  return outcomes
}

export async function processTask(
  store: TaskStore,
  runner: TaskRunner,
  user: UserProfile,
  task: Task,
  options: RunTaskOptions = {}
): Promise<TaskOutcome> {
  const interval = options.partialSnapshotIntervalMs ?? 250
  let result = ''
  let lastSnapshotAt = Number.NEGATIVE_INFINITY
  await store.saveTask(user.id, {
    ...task,
    status: 'running',
    result: undefined,
    error: undefined
  })
  try {
    for await (const event of runner.run({
      taskId: task.id,
      prompt: task.text,
      user: { id: user.id, name: user.name, age: user.age },
      signal: options.signal
    })) {
      if (event.type !== 'content') continue
      result += event.text ?? ''
      const now = Date.now()
      if (now - lastSnapshotAt < interval) continue
      await store.saveTask(user.id, {
        ...task,
        status: 'running',
        result,
        error: undefined
      })
      lastSnapshotAt = now
    }
    throwIfAborted(options.signal)
    await store.saveTask(user.id, {
      ...task,
      status: 'completed',
      result,
      error: undefined
    })
    return { taskId: task.id, status: 'completed' }
  } catch (error) {
    await store.saveTask(user.id, {
      ...task,
      status: 'failed',
      result: result || undefined,
      error: errorMessage(error)
    })
    return { taskId: task.id, status: 'failed' }
  }
}

export async function watchIncompleteTasks(
  store: TaskStore,
  runner: TaskRunner,
  options: WatchTaskOptions = {}
): Promise<void> {
  if (!store.watchTasks) {
    throw new Error('Task store does not support watching tasks')
  }
  const user = await store.loadCurrentUser()
  const initial = await store.listTasks(user.id)
  const stale = initial.filter((task) => task.status === 'running')
  if (stale.length > 0) options.onStaleTasks?.(stale)
  await processIncompleteTasks(store, runner, options)
  if (options.signal?.aborted) return

  const iterator = store.watchTasks()[Symbol.asyncIterator]()
  try {
    while (!options.signal?.aborted) {
      const next = await nextUntilAbort(iterator, options.signal)
      if (next.done) return
      await processIncompleteTasks(store, runner, options)
    }
  } finally {
    // A pending HRPC iterator.next() cannot be cancelled by iterator.return().
    // The owning Assistant closes the transport after an abort.
    if (!options.signal?.aborted) await iterator.return?.()
  }
}

function compareTasks(left: Task, right: Task) {
  return left.order - right.order || left.id.localeCompare(right.id)
}

async function nextUntilAbort<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal
): Promise<IteratorResult<T>> {
  if (!signal) return iterator.next()
  if (signal.aborted) return { done: true, value: undefined }
  let onAbort = () => {}
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    onAbort = () => resolve({ done: true, value: undefined })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([iterator.next(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Task execution aborted'
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
