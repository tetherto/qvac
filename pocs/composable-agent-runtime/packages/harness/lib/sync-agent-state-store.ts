import type {
  AgentCheckpoint,
  AgentEvent,
  AgentStateStore,
  WatchWork,
  WorkChange
} from '@qvac/agents'
import type { SyncProfileClient, SyncRuntime } from '@qvac/sync'
import {
  durableWorkProfile,
  type DurableWorkCommand,
  type DurableWorkQuery,
  type DurableWorkResult
} from '@qvac/sync/profiles/durable-work'
import AbortController from '#abort-controller'

const INLINE_CHECKPOINT = 'inline-json:'

export function createSyncAgentStateStore(sync: SyncRuntime): AgentStateStore {
  const profile = sync.openProfile(durableWorkProfile)

  async function ensureWork(runId: string) {
    const existing = await profile.query({ type: 'get-work', workId: runId })
    if (existing.work) return
    await profile.apply(
      {
        type: 'record-work',
        workId: runId,
        payload: Buffer.from(JSON.stringify({ runId })),
        payloadFormat: 'application/vnd.qvac.agent-run+json',
        payloadVersion: 1
      },
      { operationId: `record-work:${runId}` }
    )
  }

  return {
    async loadRun(runId) {
      const work = await profile.query({ type: 'get-work', workId: runId })
      if (!work.work) return null
      const journal = await profile.query({ type: 'list-journal', workId: runId })
      const checkpoint = await profile.query({
        type: 'get-checkpoint-ref',
        workId: runId
      })
      return {
        runId,
        events: journal.entries.flatMap(({ body }) => decodeEvents(body)),
        checkpoint: decodeCheckpoint(checkpoint.checkpoint?.blobRef)
      }
    },
    async appendEvents({ runId, operationId, events }) {
      await ensureWork(runId)
      const revision = (
        await profile.apply(
          {
            type: 'append-journal',
            workId: runId,
            entryType: 'agent-events',
            body: Buffer.from(JSON.stringify(events))
          },
          { operationId }
        )
      ).revision
      const terminal = events.find(isTerminalEvent)
      if (terminal) {
        await profile.apply(
          {
            type: 'record-outcome',
            workId: runId,
            status: terminal.type === 'run-completed' ? 'completed' : 'cancelled',
            result: Buffer.from(JSON.stringify(terminal))
          },
          { operationId: `${operationId}:outcome` }
        )
      }
      return revision
    },
    async saveCheckpoint({ runId, operationId, checkpoint }) {
      await ensureWork(runId)
      return (
        await profile.apply(
          {
            type: 'save-checkpoint-ref',
            workId: runId,
            checkpointId: `${runId}:${checkpoint.nextOperationIndex}`,
            format: 'qvac.agents.checkpoint',
            version: checkpoint.version,
            blobRef: encodeCheckpoint(checkpoint)
          },
          { operationId }
        )
      ).revision
    },
    watchAvailableWork(input = {}) {
      return watchWork(profile, input)
    }
  }
}

async function* watchWork(
  profile: SyncProfileClient<
    DurableWorkCommand,
    DurableWorkQuery,
    DurableWorkResult
  >,
  { after, signal }: WatchWork
): AsyncIterable<WorkChange> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let previous = new Set<string>()
  try {
    for await (const frame of profile.watch(
      { type: 'list-available-work' },
      { after, signal: controller.signal }
    )) {
      const result = frame.kind === 'snapshot' ? frame.value : frame.change
      const current = workIds(result)
      if (frame.kind === 'snapshot') {
        previous = current
        yield {
          kind: 'snapshot',
          workIds: [...current],
          cursor: frame.cursor
        }
        continue
      }
      for (const workId of current) {
        if (!previous.has(workId)) {
          yield { kind: 'available', workId, cursor: frame.cursor }
        }
      }
      for (const workId of previous) {
        if (!current.has(workId)) {
          yield { kind: 'unavailable', workId, cursor: frame.cursor }
        }
      }
      previous = current
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}

function workIds(result: DurableWorkResult) {
  return new Set(result.works.map(({ workId }) => workId))
}

function decodeEvents(encoded: Buffer) {
  return JSON.parse(encoded.toString()) as AgentEvent[]
}

function encodeCheckpoint(checkpoint: AgentCheckpoint) {
  return `${INLINE_CHECKPOINT}${Buffer.from(JSON.stringify(checkpoint)).toString('base64')}`
}

function decodeCheckpoint(encoded: string | null | undefined) {
  if (!encoded?.startsWith(INLINE_CHECKPOINT)) return null
  return JSON.parse(
    Buffer.from(encoded.slice(INLINE_CHECKPOINT.length), 'base64').toString()
  ) as AgentCheckpoint
}

function isTerminalEvent(event: AgentEvent) {
  return event.type === 'run-completed' || event.type === 'run-canceled'
}
