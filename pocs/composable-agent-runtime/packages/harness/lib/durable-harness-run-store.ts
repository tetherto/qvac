import type { AgentCheckpoint } from '@qvac/agents'
import b4aModule from 'b4a'
import AbortController from '#abort-controller'
import { openDurableWorkProfile, type DurableStateInput } from './durable-state-port.ts'
import type {
  DurableWorkProfileClient,
  DurableStateWatchFrame
} from './durable-state-port.ts'
import type { DurableWorkBytes } from './durable-work-profile.ts'
import { encodeRunIdentity } from './run-identity.ts'
import type {
  HarnessRunIdentity,
  HarnessRunOutcome,
  HarnessRunStore,
  HarnessStoredRunEvent,
  HarnessWorkChange,
  WatchHarnessWork
} from './run-store.ts'

const INLINE_CHECKPOINT = 'inline-json:'
const b4a = b4aModule as {
  from(input: string, encoding?: 'base64' | 'utf8'): Buffer
  toString(input: Uint8Array, encoding?: 'base64' | 'utf8'): string
}

export function createDurableHarnessRunStore(
  state: DurableStateInput
): HarnessRunStore {
  const profile = openDurableWorkProfile(state)

  async function ensureWork(identity: HarnessRunIdentity) {
    const workId = encodeRunIdentity(identity)
    const existing = await profile.query({ type: 'get-work', workId })
    if (existing.work) return
    await profile.apply(
      {
        type: 'record-work',
        workId,
        payload: b4a.from(JSON.stringify(identity)),
        payloadFormat: 'application/vnd.qvac.harness-run+json',
        payloadVersion: 1
      },
      { operationId: `record-work:${workId}` }
    )
  }

  return {
    async loadRun(identity) {
      const workId = encodeRunIdentity(identity)
      const work = await profile.query({ type: 'get-work', workId })
      if (!work.work) return null
      const journal = await profile.query({ type: 'list-journal', workId })
      const checkpoint = await profile.query({
        type: 'get-checkpoint-ref',
        workId
      })
      return {
        version: 1,
        ...identity,
        events: journal.entries.flatMap(({ body }) => decodeEvents(body)),
        checkpoint: decodeCheckpoint(checkpoint.checkpoint?.blobRef),
        outcome: decodeOutcome(work.work.outcomeResult)
      }
    },
    async appendEvents({ operationId, events, ...identity }) {
      await ensureWork(identity)
      const workId = encodeRunIdentity(identity)
      const previous = await profile.query({ type: 'list-journal', workId })
      const offset = previous.entries.reduce(
        (count, { body }) => count + decodeEvents(body).length,
        0
      )
      const revision = (
        await profile.apply(
          {
            type: 'append-journal',
            workId,
            entryType: 'harness-run-events',
            body: b4a.from(
              JSON.stringify(
                events.map((entry, index) => ({
                  ...entry,
                  sequence: offset + index + 1
                }))
              )
            )
          },
          { operationId }
        )
      ).revision
      return revision
    },
    async saveCheckpoint({ operationId, checkpoint, ...identity }) {
      await ensureWork(identity)
      const workId = encodeRunIdentity(identity)
      return (
        await profile.apply(
          {
            type: 'save-checkpoint-ref',
            workId,
            checkpointId: `${workId}:${checkpoint.nextOperationIndex}`,
            format: 'qvac.agents.checkpoint',
            version: checkpoint.version,
            blobRef: encodeCheckpoint(checkpoint)
          },
          { operationId }
        )
      ).revision
    },
    async finish({ operationId, outcome, ...identity }) {
      await ensureWork(identity)
      return (
        await profile.apply(
          {
            type: 'record-outcome',
            workId: encodeRunIdentity(identity),
            status: durableOutcomeStatus(outcome),
            result: b4a.from(JSON.stringify(outcome))
          },
          { operationId }
        )
      ).revision
    },
    watchAvailableWork(input = {}) {
      return watchWork(profile, input)
    },
    async close() {
      // The supplied durable state owns the profile lifecycle.
    }
  }
}

async function* watchWork(
  profile: DurableWorkProfileClient,
  { after, signal }: WatchHarnessWork
): AsyncIterable<HarnessWorkChange> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let previous = new Set<string>()
  try {
    for await (const frame of profile.watch(
      { type: 'list-available-work' },
      { after, signal: controller.signal }
    )) {
      const result = durableWorkResult(frame)
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

function durableWorkResult(frame: DurableStateWatchFrame) {
  return frame.kind === 'snapshot' ? frame.value : frame.change
}

function workIds(result: ReturnType<typeof durableWorkResult>) {
  return new Set(result.works.map(({ workId }) => workId))
}

function decodeEvents(encoded: DurableWorkBytes) {
  return JSON.parse(b4a.toString(encoded)) as HarnessStoredRunEvent[]
}

function encodeCheckpoint(checkpoint: AgentCheckpoint) {
  return `${INLINE_CHECKPOINT}${b4a.toString(b4a.from(JSON.stringify(checkpoint)), 'base64')}`
}

function decodeCheckpoint(encoded: string | null | undefined) {
  if (!encoded?.startsWith(INLINE_CHECKPOINT)) return null
  return JSON.parse(
    b4a.toString(b4a.from(encoded.slice(INLINE_CHECKPOINT.length), 'base64'))
  ) as AgentCheckpoint
}

function decodeOutcome(encoded: DurableWorkBytes | null | undefined) {
  return encoded ? JSON.parse(b4a.toString(encoded)) as HarnessRunOutcome : null
}

function durableOutcomeStatus(outcome: HarnessRunOutcome) {
  if (outcome.status === 'completed') return 'completed' as const
  if (outcome.status === 'canceled') return 'cancelled' as const
  return 'failed' as const
}
