import type {
  AgentAbortSignal,
  AgentCheckpoint,
  AgentEvent
} from '../index.ts'

export interface AppendEvents {
  readonly runId: string
  readonly operationId: string
  readonly events: readonly AgentEvent[]
}

export interface SaveCheckpoint {
  readonly runId: string
  readonly operationId: string
  readonly checkpoint: AgentCheckpoint
}

export interface WatchWork {
  readonly after?: string
  readonly signal?: AgentAbortSignal
}

export type WorkChange =
  | {
      readonly kind: 'snapshot'
      readonly workIds: readonly string[]
      readonly cursor: string
    }
  | {
      readonly kind: 'available'
      readonly workId: string
      readonly cursor: string
    }
  | {
      readonly kind: 'unavailable'
      readonly workId: string
      readonly cursor: string
    }

export type Revision = string

export interface RunState {
  readonly runId: string
  readonly events: readonly AgentEvent[]
  readonly checkpoint: AgentCheckpoint | null
}

export interface AgentStateStore {
  loadRun(runId: string): Promise<RunState | null>
  appendEvents(input: AppendEvents): Promise<Revision>
  saveCheckpoint(input: SaveCheckpoint): Promise<Revision>
  watchAvailableWork(input?: WatchWork): AsyncIterable<WorkChange>
}
