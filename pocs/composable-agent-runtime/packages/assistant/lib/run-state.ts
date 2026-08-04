import type { HarnessEvent } from '@qvac/harness/types'
import type { AssistantStateEndpoint } from './contracts.ts'
import type { SyncProfileClient } from '@qvac/sync'
import {
  durableWorkProfile,
  type DurableWorkCommand,
  type DurableWorkQuery,
  type DurableWorkResult
} from '@qvac/sync/profiles/durable-work'

const PERSIST_INTERVAL_MS = 250

export function createRunStateAdapter(sync: AssistantStateEndpoint) {
  const profile = sync.openProfile(durableWorkProfile)
  const runs = new Map<string, RunState>()

  return {
    async append(runId: string, event: HarnessEvent) {
      const run = getRun(runs, runId)
      assertNoFailure(run)
      run.pending.push(event)
      if (isTerminal(event)) {
        await flush(profile, run)
        return
      }
      scheduleFlush(profile, run)
    },
    async read(runId: string) {
      const run = runs.get(runId)
      if (!run) return readPersisted(profile, runId)
      await flush(profile, run)
      assertNoFailure(run)
      return run.persisted
    },
    async finish(runId: string, completed = false) {
      const run = runs.get(runId)
      if (!run) return
      await flush(profile, run)
      if (completed && !run.terminal && run.exists) {
        await profile.apply(
          {
            type: 'record-outcome',
            workId: run.id,
            status: 'completed'
          },
          { operationId: `assistant-outcome:${run.id}:completed` }
        )
        run.terminal = true
      }
      assertNoFailure(run)
    },
    async close() {
      await Promise.all([...runs.keys()].map((runId) => this.finish(runId)))
    }
  }
}

type Profile = SyncProfileClient<
  DurableWorkCommand,
  DurableWorkQuery,
  DurableWorkResult
>

interface RunState {
  readonly id: string
  readonly pending: HarnessEvent[]
  persisted: HarnessEvent[]
  loaded: boolean
  exists: boolean
  timer: ReturnType<typeof setTimeout> | null
  flushing: Promise<void> | null
  failure: Error | null
  terminal: boolean
}

function getRun(runs: Map<string, RunState>, runId: string) {
  const existing = runs.get(runId)
  if (existing) return existing
  const run: RunState = {
    id: runId,
    pending: [],
    persisted: [],
    loaded: false,
    exists: false,
    timer: null,
    flushing: null,
    failure: null,
    terminal: false
  }
  runs.set(runId, run)
  return run
}

function scheduleFlush(profile: Profile, run: RunState) {
  if (run.timer) return
  run.timer = setTimeout(() => {
    run.timer = null
    void flush(profile, run).catch((error: unknown) => {
      run.failure = toError(error)
    })
  }, PERSIST_INTERVAL_MS)
}

function flush(profile: Profile, run: RunState): Promise<void> {
  if (run.timer) {
    clearTimeout(run.timer)
    run.timer = null
  }
  if (run.flushing) return run.flushing
  run.flushing = flushPending(profile, run)
    .then(() => {
      run.failure = null
    })
    .finally(() => {
      run.flushing = null
    })
  return run.flushing
}

async function flushPending(profile: Profile, run: RunState) {
  await loadPersisted(profile, run)
  while (run.pending.length > 0) {
    const pending = run.pending.slice()
    if (!run.exists) {
      await profile.apply(
        {
          type: 'record-work',
          workId: run.id,
          payload: Buffer.from(JSON.stringify({ runId: run.id })),
          payloadFormat: 'application/vnd.qvac.assistant-run+json',
          payloadVersion: 1
        },
        { operationId: `assistant-run:${run.id}` }
      )
      run.exists = true
    }
    await profile.apply(
      {
        type: 'append-journal',
        workId: run.id,
        entryType: 'harness-events',
        body: Buffer.from(JSON.stringify(pending))
      },
      {
        operationId: `assistant-events:${run.id}:${run.persisted.length}`
      }
    )
    const terminal = pending.findLast(isTerminal)
    if (terminal) {
      await profile.apply(
        {
          type: 'record-outcome',
          workId: run.id,
          status: terminal.type === 'aborted' ? 'cancelled' : 'failed',
          result: Buffer.from(JSON.stringify(terminal))
        },
        {
          operationId: `assistant-outcome:${run.id}:${run.persisted.length}`
        }
      )
      run.terminal = true
    }
    run.persisted.push(...pending)
    run.pending.splice(0, pending.length)
  }
}

async function loadPersisted(profile: Profile, run: RunState) {
  if (run.loaded) return
  const [work, journal] = await Promise.all([
    profile.query({ type: 'get-work', workId: run.id }),
    profile.query({ type: 'list-journal', workId: run.id })
  ])
  run.exists = work.work != null
  run.persisted = journal.entries
    .filter(({ entryType }) => entryType === 'harness-events')
    .flatMap(({ body }) => parseEvents(body))
  run.terminal = run.persisted.some(isTerminal)
  run.loaded = true
}

async function readPersisted(profile: Profile, runId: string) {
  const journal = await profile.query({ type: 'list-journal', workId: runId })
  return journal.entries
    .filter(({ entryType }) => entryType === 'harness-events')
    .flatMap(({ body }) => parseEvents(body))
}

function assertNoFailure(run: RunState) {
  if (run.failure) throw run.failure
}

function isTerminal(event: HarnessEvent) {
  return event.type === 'error' || event.type === 'aborted'
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function parseEvents(serialized: Buffer): HarnessEvent[] {
  const parsed: unknown = JSON.parse(serialized.toString())
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
