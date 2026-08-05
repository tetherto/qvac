import test from 'brittle'
import Buffer from '#buffer'
import { createDurableHarnessRunStore } from '../lib/durable-harness-run-store.ts'
import type {
  DurableStateWatchFrame,
  DurableWorkProfileClient
} from '../lib/durable-state-port.ts'
import type {
  DurableWorkCommand,
  DurableWorkBytes,
  DurableWorkQuery,
  DurableWorkRecord,
  DurableWorkResult
} from '../lib/durable-work-profile.ts'
import { verifyAvailabilityLifecycle } from './harness-run-store-conformance.ts'

const checkpoint = {
  version: 2 as const,
  agentId: 'agent-1',
  runId: 'run-1',
  nextOperationIndex: 1,
  outputs: [{ operationId: 'run-1/respond', output: 'hello' }]
}

test('harness: durable HarnessRunStore maps through DurableStatePort', async (t) => {
  const state = createFakeDurableStatePort()
  const store = createDurableHarnessRunStore(state)
  await verifyAvailabilityLifecycle(t, store, 'durable')
  await store.appendEvents({
    agentId: 'agent-1',
    runId: 'run-1',
    operationId: 'events-1',
    events: [
      {
        kind: 'agent',
        event: { type: 'run-started', runId: 'run-1' }
      }
    ]
  })
  await store.saveCheckpoint({
    agentId: 'agent-1',
    runId: 'run-1',
    operationId: 'checkpoint-1',
    checkpoint
  })

  const loaded = await store.loadRun({
    agentId: 'agent-1',
    runId: 'run-1'
  })
  const firstEvent = loaded?.events.at(0)
  t.is(firstEvent?.kind, 'agent')
  if (firstEvent?.kind === 'agent') t.is(firstEvent.event.type, 'run-started')
  t.is(loaded?.checkpoint?.runId, 'run-1')
})

function createFakeDurableStatePort() {
  const profile = createFakeDurableWorkProfileClient()
  return {
    openDurableWorkProfile() {
      return profile
    }
  }
}

function createFakeDurableWorkProfileClient(): DurableWorkProfileClient {
  let revision = 0
  const works = new Map<string, DurableWorkRecord>()
  const journals = new Map<
    string,
    { readonly body: DurableWorkBytes }[]
  >()
  const checkpoints = new Map<string, { readonly blobRef: string }>()
  const watchers = new Set<() => void>()

  function nextRevision() {
    revision += 1
    return String(revision)
  }

  function notify() {
    for (const watcher of watchers) watcher()
  }

  function result(query: DurableWorkQuery): DurableWorkResult {
    const workId = 'workId' in query ? query.workId : null
    return {
      work: workId ? works.get(workId) ?? null : null,
      works: [...works.values()].filter((work) => !work.outcomeStatus),
      checkpoint: workId ? checkpoints.get(workId) ?? null : null,
      entries: workId ? journals.get(workId) ?? [] : [],
      executors: []
    }
  }

  return {
    async apply(command: DurableWorkCommand) {
      if (command.type === 'record-work') {
        works.set(command.workId, {
          workId: command.workId,
          payload: command.payload,
          payloadFormat: command.payloadFormat,
          payloadVersion: command.payloadVersion,
          target: command.target ?? null,
          createdAt: Date.now()
        })
      }
      if (command.type === 'append-journal') {
        const entries = journals.get(command.workId) ?? []
        entries.push({ body: command.body })
        journals.set(command.workId, entries)
      }
      if (command.type === 'save-checkpoint-ref') {
        checkpoints.set(command.workId, { blobRef: command.blobRef })
      }
      if (command.type === 'record-outcome') {
        const existing = works.get(command.workId)
        if (existing) {
          works.set(command.workId, {
            ...existing,
            outcomeStatus: command.status,
            outcomeResult: command.result ?? null
          })
        }
      }
      const next = nextRevision()
      notify()
      return { revision: next }
    },
    async query(query) {
      return result(query)
    },
    async *watch(query, options = {}) {
      let observedRevision = revision
      yield frame('snapshot', String(observedRevision), result(query))
      while (!options.signal?.aborted) {
        if (observedRevision === revision) {
          await new Promise<void>((resolve) => {
            const done = () => {
              watchers.delete(done)
              resolve()
            }
            watchers.add(done)
            options.signal?.addEventListener('abort', done, { once: true })
          })
        }
        if (!options.signal?.aborted) {
          observedRevision = revision
          yield frame('change', String(revision), result(query))
        }
      }
    }
  }
}

function frame(
  kind: DurableStateWatchFrame['kind'],
  cursor: string,
  value: DurableWorkResult
): DurableStateWatchFrame {
  return kind === 'snapshot'
    ? { kind, generation: 'test', cursor, value }
    : { kind, generation: 'test', cursor, change: value }
}
