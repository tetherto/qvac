import { describe, expect, test } from 'bun:test'
import type {
  AssistantLifecycleEvent,
  AssistantRun,
  AssistantRunInput
} from '@qvac/assistant'
import {
  createTaskController,
  type TaskControllerTask
} from './task-controller.ts'

describe('task controller', () => {
  test('streams task output and reflects updates through task watch', async () => {
    const events = [
      { type: 'content' as const, text: 'Hello' },
      { type: 'content' as const, text: ' world' }
    ]
    const harness = createAssistantHarness({
      run: async function* () {
        for (const event of events) yield event
      }
    })
    const states: string[] = []
    const snapshots: Array<readonly TaskControllerTask[]> = []
    const controller = createTaskController({
      storagePath: '/tmp/task-mobile',
      createAssistant: harness.createAssistant,
      createTaskRepository: harness.createTaskRepository,
      createTaskId: () => 'phone-task-1',
      onState: (snapshot) => states.push(snapshot.state)
    })

    await controller.connect('qvac-poc://pair?invite=-_8AAQ&expiresAt=123000', 100_000)
    const stop = controller.watchTasks((tasks) => {
      snapshots.push(tasks)
    })
    await controller.createTask({
      title: 'Greeting',
      input: 'Say hello'
    })
    await waitFor(() => snapshots.length > 0)

    const finalTask = harness.readTask('phone-task-1')
    expect(states).toEqual(['connecting', 'awaiting-approval', 'writable'])
    expect(finalTask?.status).toBe('completed')
    expect(finalTask?.result).toContain('"result":"Hello world"')
    expect(
      snapshots.at(-1)?.find((task) => task.id === 'phone-task-1')?.result
    ).toBe('Hello world')
    stop()
  })

  test('disconnect is idempotent and cancellation marks tasks cancelled', async () => {
    const gate = Promise.withResolvers<void>()
    const harness = createAssistantHarness({
      run: async function* (input) {
        yield { type: 'content' as const, text: 'partial' }
        await gate.promise
        if (input.signal?.aborted) {
          yield { type: 'aborted' as const }
        }
      }
    })
    const controller = createTaskController({
      storagePath: '/tmp/task-mobile',
      createAssistant: harness.createAssistant,
      createTaskRepository: harness.createTaskRepository,
      createTaskId: () => 'phone-task-2'
    })
    await controller.connect()

    const run = controller.createTask({ title: 'Cancelable', input: 'Stop me' })
    await waitFor(() => harness.readTask('phone-task-2')?.status === 'running')
    const cancel = controller.cancelTask('phone-task-2', 'cancel from ui')
    gate.resolve()
    await cancel
    await run

    const cancelledTask = harness.readTask('phone-task-2')
    expect(cancelledTask?.status).toBe('cancelled')
    expect(cancelledTask?.result).toContain('cancel from ui')

    await controller.disconnect()
    await controller.disconnect()
    expect(harness.closeCalls()).toBe(1)
  })

  test('does not auto-reconnect on first run without persisted pairing marker', async () => {
    const harness = createAssistantHarness({
      run: async function* () {}
    })
    const controller = createTaskController({
      storagePath: '/tmp/task-mobile',
      createAssistant: harness.createAssistant,
      createTaskRepository: harness.createTaskRepository,
      hasPersistentPairing: () => false
    })
    await controller.reconnect()
    expect(controller.snapshot().state).toBe('idle')
    expect(harness.starts()).toBe(0)
  })

  test('reconnects saved session when pairing marker exists', async () => {
    const harness = createAssistantHarness({
      run: async function* () {}
    })
    const controller = createTaskController({
      storagePath: '/tmp/task-mobile',
      createAssistant: harness.createAssistant,
      createTaskRepository: harness.createTaskRepository,
      hasPersistentPairing: () => true
    })
    await controller.reconnect()
    expect(controller.snapshot().state).toBe('writable')
    expect(harness.starts()).toBe(1)
  })

  test('moves offline after lifecycle disconnect and releases listener on close', async () => {
    const harness = createAssistantHarness({
      run: async function* () {}
    })
    const controller = createTaskController({
      storagePath: '/tmp/task-mobile',
      createAssistant: harness.createAssistant,
      createTaskRepository: harness.createTaskRepository
    })
    await controller.connect()
    harness.emitLifecycle({
      type: 'child-died',
      timestamp: Date.now(),
      name: 'sync',
      error: { name: 'Error', message: 'peer gone' }
    })
    await waitFor(() => controller.snapshot().state === 'offline')
    await controller.disconnect()
    expect(harness.lifecycleUnsubscribes()).toBe(1)
  })

  test('filters application tasks to mobile and task-cli prefixes', async () => {
    const harness = createAssistantHarness({
      run: async function* () {}
    })
    await harness.seedTask({
      id: 'phone-task-3',
      title: 'Visible mobile',
      input: 'A',
      status: 'pending'
    })
    await harness.seedTask({
      id: 'task-cli/task/3',
      title: 'Visible cli',
      input: 'B',
      status: 'pending'
    })
    await harness.seedTask({
      id: '@harness/internal',
      title: 'Hidden internal',
      input: 'C',
      status: 'pending'
    })
    const controller = createTaskController({
      storagePath: '/tmp/task-mobile',
      createAssistant: harness.createAssistant,
      createTaskRepository: harness.createTaskRepository
    })
    await controller.connect()
    let latest: readonly TaskControllerTask[] = []
    const stop = controller.watchTasks((tasks) => {
      latest = tasks
    })
    await waitFor(() => latest.length > 0)
    expect(latest.map((task) => task.id).sort()).toEqual(['phone-task-3', 'task-cli/task/3'])
    stop()
  })

  test('throttles persistence while keeping final streamed result', async () => {
    const harness = createAssistantHarness({
      run: async function* () {
        yield { type: 'content' as const, text: 'a' }
        yield { type: 'content' as const, text: 'b' }
        yield { type: 'content' as const, text: 'c' }
      }
    })
    const controller = createTaskController({
      storagePath: '/tmp/task-mobile',
      createAssistant: harness.createAssistant,
      createTaskRepository: harness.createTaskRepository,
      createTaskId: () => 'phone-task-throttle'
    })
    await controller.connect()
    await controller.createTask({ title: 'Throttle', input: 'abc' })
    const updated = harness.updateCallsFor('phone-task-throttle')
    expect(updated).toBeLessThan(4)
    expect(harness.readTask('phone-task-throttle')?.status).toBe('completed')
    expect(harness.readTask('phone-task-throttle')?.result).toContain('"result":"abc"')
  })
})

function createAssistantHarness({
  run
}: {
  readonly run: (
    input: AssistantRunInput
  ) => AsyncIterable<AssistantRunEvent>
}) {
  const tasks = new Map<string, TaskControllerTask>()
  const watchers = new Set<(tasks: TaskControllerTask[]) => void>()
  let closes = 0
  let starts = 0
  let lifecycleUnsubscribes = 0
  const lifecycleListeners = new Set<(event: AssistantLifecycleEvent) => void>()
  const updatesByTask = new Map<string, number>()

  function publish() {
    const snapshot = [...tasks.values()]
    for (const watcher of watchers) watcher(snapshot)
  }

  function createAssistant() {
    starts += 1
    return {
      state: {},
      async ready() {},
      run(input: AssistantRunInput) {
        const stream = run(input)
        return {
          id: input.runId ?? 'run',
          traceId: input.traceId ?? 'trace',
          [Symbol.asyncIterator]() {
            return stream[Symbol.asyncIterator]()
          }
        }
      },
      async readRun() {
        return []
      },
      async suspend() {},
      async resume() {},
      async close() {
        closes += 1
      },
      inspect() {
        return { sdkStarts: 0, children: [] }
      },
      onLifecycle(listener: (event: AssistantLifecycleEvent) => void) {
        lifecycleListeners.add(listener)
        return () => {
          lifecycleUnsubscribes += 1
          lifecycleListeners.delete(listener)
        }
      }
    }
  }

  return {
    async seedTask(input: {
      readonly id: string
      readonly title: string
      readonly input: string
      readonly status: TaskControllerTask['status']
    }) {
      tasks.set(input.id, {
        ...input,
        createdAt: 1,
        updatedAt: 1,
        result: null
      })
      publish()
    },
    emitLifecycle(event: AssistantLifecycleEvent) {
      for (const listener of lifecycleListeners) {
        listener(event)
      }
    },
    createAssistant,
    createTaskRepository() {
      return {
        async create(request: {
          readonly id: string
          readonly title: string | null
          readonly input: string
        }) {
          const task: TaskControllerTask = {
            id: request.id,
            title: request.title,
            input: request.input,
            status: 'pending',
            result: null,
            createdAt: 1,
            updatedAt: 1
          }
          tasks.set(request.id, task)
          publish()
          return task
        },
        async update(request: {
          readonly id: string
          readonly status: TaskControllerTask['status']
          readonly result?: string | null
        }) {
          const current = tasks.get(request.id)
          if (!current) throw new Error('task missing')
          updatesByTask.set(
            request.id,
            (updatesByTask.get(request.id) ?? 0) + 1
          )
          const next = {
            ...current,
            status: request.status,
            ...(request.result === undefined
              ? {}
              : { result: request.result }),
            updatedAt: current.updatedAt + 1
          }
          tasks.set(request.id, next)
          publish()
          return next
        },
        async get(id: string) {
          return tasks.get(id) ?? null
        },
        async list() {
          return [...tasks.values()]
        },
        watch() {
          return (async function* () {
            let pending:
              | ((value: IteratorResult<TaskControllerTask[]>) => void)
              | null = null
            const queue = [[...tasks.values()]]
            const watcher = (next: TaskControllerTask[]) => {
              queue.push([...next])
              if (!pending) return
              const resolve = pending
              pending = null
              const value = queue.shift()
              if (value) resolve({ value, done: false })
            }
            watchers.add(watcher)
            try {
              while (true) {
                const value = queue.shift()
                if (value) {
                  yield value
                  continue
                }
                const next = await new Promise<
                  IteratorResult<TaskControllerTask[]>
                >((resolve) => {
                  pending = resolve
                })
                if (next.done) return
                yield next.value
              }
            } finally {
              watchers.delete(watcher)
            }
          })()
        }
      }
    },
    readTask(taskId: string) {
      return tasks.get(taskId)
    },
    updateCallsFor(taskId: string) {
      return updatesByTask.get(taskId) ?? 0
    },
    closeCalls() {
      return closes
    },
    starts() {
      return starts
    },
    lifecycleUnsubscribes() {
      return lifecycleUnsubscribes
    }
  }
}

type AssistantRunEvent = AssistantRun extends AsyncIterable<infer Event>
  ? Event
  : never

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for expected condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
