import type {
  AgentCheckpoint,
  AgentEvent,
  AgentStateStore,
  WorkChange
} from '@qvac/agents'

interface MutableRunState {
  readonly events: AgentEvent[]
  checkpoint: AgentCheckpoint | null
}

export function createInMemoryAgentStateStore(): AgentStateStore {
  const runs = new Map<string, MutableRunState>()
  const available = new Set<string>()
  const operations = new Set<string>()
  const listeners = new Set<(change: WorkChange) => void>()
  let cursor = 0

  function stateFor(runId: string) {
    let state = runs.get(runId)
    if (!state) {
      state = { events: [], checkpoint: null }
      runs.set(runId, state)
    }
    return state
  }

  return {
    async loadRun(runId) {
      const state = runs.get(runId)
      if (!state) return null
      return {
        runId,
        events: [...state.events],
        checkpoint: state.checkpoint
      }
    },
    async appendEvents({ runId, operationId, events }) {
      if (operations.has(operationId)) return operationId
      const existed = runs.has(runId)
      stateFor(runId).events.push(...events)
      operations.add(operationId)
      if (!existed) {
        available.add(runId)
        cursor += 1
        const change: WorkChange = {
          kind: 'available',
          workId: runId,
          cursor: String(cursor)
        }
        for (const listener of listeners) listener(change)
      }
      if (available.has(runId) && events.some(isTerminalEvent)) {
        available.delete(runId)
        cursor += 1
        const change: WorkChange = {
          kind: 'unavailable',
          workId: runId,
          cursor: String(cursor)
        }
        for (const listener of listeners) listener(change)
      }
      return operationId
    },
    async saveCheckpoint({ runId, operationId, checkpoint }) {
      if (operations.has(operationId)) return operationId
      stateFor(runId).checkpoint = checkpoint
      operations.add(operationId)
      return operationId
    },
    watchAvailableWork({ signal } = {}) {
      return createWorkWatch(available, listeners, signal, () => String(cursor))
    }
  }
}

async function* createWorkWatch(
  available: ReadonlySet<string>,
  listeners: Set<(change: WorkChange) => void>,
  signal: { readonly aborted: boolean; addEventListener(type: 'abort', listener: () => void): void; removeEventListener(type: 'abort', listener: () => void): void } | undefined,
  currentCursor: () => string
) {
  const queue: WorkChange[] = []
  let wake: (() => void) | null = null
  const onChange = (change: WorkChange) => {
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

function isTerminalEvent(event: AgentEvent) {
  return event.type === 'run-completed' || event.type === 'run-canceled'
}
