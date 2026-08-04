import { encodeRunIdentity } from './run-identity.ts'
import type {
  HarnessRunIdentity,
  HarnessRunOutcome,
  HarnessRunRecord,
  HarnessRunStore,
  HarnessStoredRunEvent,
  HarnessWorkChange
} from './run-store.ts'

interface MutableRunState extends HarnessRunIdentity {
  readonly version: 1
  readonly events: HarnessStoredRunEvent[]
  checkpoint: HarnessRunRecord['checkpoint']
  outcome: HarnessRunOutcome | null
}

export function createInMemoryHarnessRunStore(): HarnessRunStore {
  const runs = new Map<string, MutableRunState>()
  const available = new Set<string>()
  const operations = new Set<string>()
  const listeners = new Set<(change: HarnessWorkChange) => void>()
  let cursor = 0

  function stateFor(identity: HarnessRunIdentity) {
    const key = encodeRunIdentity(identity)
    let state = runs.get(key)
    if (!state) {
      state = {
        version: 1,
        ...identity,
        events: [],
        checkpoint: null,
        outcome: null
      }
      runs.set(key, state)
      available.add(key)
      publish({ kind: 'available', workId: key, cursor: nextCursor() })
    }
    return state
  }

  function nextCursor() {
    cursor += 1
    return String(cursor)
  }

  function publish(change: HarnessWorkChange) {
    for (const listener of listeners) listener(change)
  }

  return {
    async loadRun(identity) {
      const state = runs.get(encodeRunIdentity(identity))
      return state ? copyRecord(state) : null
    },
    async appendEvents({ operationId, events, ...identity }) {
      if (operations.has(operationId)) return operationId
      const state = stateFor(identity)
      state.events.push(
        ...events.map((entry) => ({
          ...entry,
          sequence: state.events.length + 1
        }))
      )
      operations.add(operationId)
      return operationId
    },
    async saveCheckpoint({ operationId, checkpoint, ...identity }) {
      if (operations.has(operationId)) return operationId
      stateFor(identity).checkpoint = checkpoint
      operations.add(operationId)
      return operationId
    },
    async finish({ operationId, outcome, ...identity }) {
      if (operations.has(operationId)) return operationId
      const key = encodeRunIdentity(identity)
      stateFor(identity).outcome = outcome
      operations.add(operationId)
      if (available.delete(key)) {
        publish({ kind: 'unavailable', workId: key, cursor: nextCursor() })
      }
      return operationId
    },
    watchAvailableWork({ signal } = {}) {
      return createWorkWatch(available, listeners, signal, () => String(cursor))
    },
    async close() {
      listeners.clear()
    }
  }
}

async function* createWorkWatch(
  available: ReadonlySet<string>,
  listeners: Set<(change: HarnessWorkChange) => void>,
  signal: {
    readonly aborted: boolean
    addEventListener(type: 'abort', listener: () => void): void
    removeEventListener(type: 'abort', listener: () => void): void
  } | undefined,
  currentCursor: () => string
) {
  const queue: HarnessWorkChange[] = []
  let wake: (() => void) | null = null
  const onChange = (change: HarnessWorkChange) => {
    queue.push(change)
    wake?.()
    wake = null
  }
  const onAbort = () => {
    wake?.()
    wake = null
  }
  listeners.add(onChange)
  signal?.addEventListener('abort', onAbort)
  try {
    yield {
      kind: 'snapshot' as const,
      workIds: [...available],
      cursor: currentCursor()
    }
    while (!signal?.aborted) {
      const change = queue.shift()
      if (change) {
        yield change
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    listeners.delete(onChange)
    signal?.removeEventListener('abort', onAbort)
  }
}

function copyRecord(state: MutableRunState): HarnessRunRecord {
  return {
    version: 1,
    agentId: state.agentId,
    runId: state.runId,
    events: state.events.map((entry) => ({ ...entry })),
    checkpoint: state.checkpoint,
    outcome: state.outcome
  }
}
