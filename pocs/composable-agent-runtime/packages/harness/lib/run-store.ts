import type { AgentCheckpoint, AgentEvent } from '@qvac/agents'
import type { HarnessAbortSignal, HarnessEvent } from './types.ts'

export interface HarnessRunIdentity {
  readonly agentId: string
  readonly runId: string
}

export type HarnessStoredRunEvent =
  | {
      readonly sequence: number
      readonly kind: 'agent'
      readonly event: AgentEvent
    }
  | {
      readonly sequence: number
      readonly kind: 'execution'
      readonly event: HarnessEvent
    }

export type HarnessRunOutcome =
  | { readonly status: 'completed'; readonly output: string }
  | { readonly status: 'canceled'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'interrupted'; readonly reason: string }
  | { readonly status: 'indeterminate'; readonly reason: string }

export interface HarnessRunRecord extends HarnessRunIdentity {
  readonly version: 1
  readonly events: readonly HarnessStoredRunEvent[]
  readonly checkpoint: AgentCheckpoint | null
  readonly outcome: HarnessRunOutcome | null
}

export interface AppendHarnessRunEvents extends HarnessRunIdentity {
  readonly operationId: string
  readonly events: readonly (
    | { readonly kind: 'agent'; readonly event: AgentEvent }
    | { readonly kind: 'execution'; readonly event: HarnessEvent }
  )[]
}

export interface SaveHarnessRunCheckpoint extends HarnessRunIdentity {
  readonly operationId: string
  readonly checkpoint: AgentCheckpoint
}

export interface FinishHarnessRun extends HarnessRunIdentity {
  readonly operationId: string
  readonly outcome: HarnessRunOutcome
}

export interface WatchHarnessWork {
  readonly after?: string
  readonly signal?: HarnessAbortSignal
}

export type HarnessWorkChange =
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

export type HarnessRevision = string

export interface HarnessRunStore {
  loadRun(identity: HarnessRunIdentity): Promise<HarnessRunRecord | null>
  appendEvents(input: AppendHarnessRunEvents): Promise<HarnessRevision>
  saveCheckpoint(input: SaveHarnessRunCheckpoint): Promise<HarnessRevision>
  finish(input: FinishHarnessRun): Promise<HarnessRevision>
  watchAvailableWork(input?: WatchHarnessWork): AsyncIterable<HarnessWorkChange>
  close(): Promise<void>
}
