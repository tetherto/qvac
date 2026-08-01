import type { HarnessEvent } from '@qvac/harness/types'
import type { AssistantStateEndpoint } from './contracts.ts'

const PERSIST_INTERVAL_MS = 250

export function createRunStateAdapter(state: AssistantStateEndpoint) {
  const runs = new Map<string, RunState>()

  return {
    async append(runId: string, event: HarnessEvent) {
      const run = getRun(runs, runId)
      assertNoFailure(run)
      run.pending.push(event)
      if (isTerminal(event)) {
        await flush(state, run)
        return
      }
      scheduleFlush(state, run)
    },
    async read(runId: string) {
      const run = runs.get(runId)
      if (!run) return readPersisted(state, runId)
      await flush(state, run)
      assertNoFailure(run)
      return run.persisted
    },
    async finish(runId: string) {
      const run = runs.get(runId)
      if (!run) return
      await flush(state, run)
      assertNoFailure(run)
    },
    async close() {
      await Promise.all([...runs.keys()].map((runId) => this.finish(runId)))
    }
  }
}

interface RunState {
  readonly id: string
  readonly pending: HarnessEvent[]
  persisted: HarnessEvent[]
  exists: boolean | null
  timer: ReturnType<typeof setTimeout> | null
  flushing: Promise<void> | null
  failure: Error | null
}

function getRun(runs: Map<string, RunState>, runId: string) {
  const existing = runs.get(runId)
  if (existing) return existing
  const run: RunState = {
    id: runStateId(runId),
    pending: [],
    persisted: [],
    exists: null,
    timer: null,
    flushing: null,
    failure: null
  }
  runs.set(runId, run)
  return run
}

function scheduleFlush(state: AssistantStateEndpoint, run: RunState) {
  if (run.timer) return
  run.timer = setTimeout(() => {
    run.timer = null
    void flush(state, run).catch((error: unknown) => {
      run.failure = toError(error)
    })
  }, PERSIST_INTERVAL_MS)
}

function flush(state: AssistantStateEndpoint, run: RunState): Promise<void> {
  if (run.timer) {
    clearTimeout(run.timer)
    run.timer = null
  }
  if (run.flushing) return run.flushing
  run.flushing = flushPending(state, run).finally(() => {
    run.flushing = null
  })
  return run.flushing
}

async function flushPending(state: AssistantStateEndpoint, run: RunState) {
  await loadPersisted(state, run)
  while (run.pending.length > 0) {
    const pending = run.pending.splice(0)
    const lastEvent = pending.at(-1)
    if (!lastEvent) throw new Error('Expected pending Harness event')
    if (!run.exists) {
      await state.createTask({
        id: run.id,
        title: `Harness run ${run.id.replace('@harness/', '')}`,
        input: run.id.replace('@harness/', '')
      })
      run.exists = true
    }
    const events = [...run.persisted, ...pending]
    await state.updateTask({
      id: run.id,
      status: eventStatus(lastEvent),
      result: JSON.stringify(events)
    })
    run.persisted = events
  }
}

async function loadPersisted(state: AssistantStateEndpoint, run: RunState) {
  if (run.exists !== null) return
  const current = await state.getTask({ id: run.id })
  run.exists = Boolean(current.task)
  run.persisted = current.task?.result ? parseEvents(current.task.result) : []
}

async function readPersisted(state: AssistantStateEndpoint, runId: string) {
  const result = await state.getTask({ id: runStateId(runId) })
  return result.task?.result ? parseEvents(result.task.result) : []
}

function assertNoFailure(run: RunState) {
  if (run.failure) throw run.failure
}

function isTerminal(event: HarnessEvent) {
  return event.type === 'error' || event.type === 'aborted'
}

function runStateId(runId: string) {
  return `@harness/${runId}`
}

function eventStatus(event: HarnessEvent) {
  if (event.type === 'error') return 'failed' as const
  if (event.type === 'aborted') return 'cancelled' as const
  return 'running' as const
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function parseEvents(serialized: string): HarnessEvent[] {
  const parsed: unknown = JSON.parse(serialized)
  if (!Array.isArray(parsed) || !parsed.every(isHarnessEvent)) {
    throw new Error('Invalid persisted Harness event stream')
  }
  return parsed
}

function isHarnessEvent(value: unknown): value is HarnessEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const type = Reflect.get(value, 'type')
  return (
    type === 'content' ||
    type === 'thinking' ||
    type === 'tool-call' ||
    type === 'tool-result' ||
    type === 'metrics' ||
    type === 'error' ||
    type === 'aborted'
  )
}
