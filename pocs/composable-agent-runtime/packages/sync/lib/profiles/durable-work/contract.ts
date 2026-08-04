import type {
  SyncDurableWork,
  SyncDurableWorkCheckpoint,
  SyncDurableWorkExecutor,
  SyncDurableWorkJournalEntry
} from '../../../spec/mesh/hyperschema/types.d.ts'
import type { SyncProfileContract } from '../../runtime/types.ts'

export type DurableWorkCommand =
  | {
      readonly type: 'record-work'
      readonly workId: string
      readonly payload: Buffer
      readonly payloadFormat: string
      readonly payloadVersion: number
      readonly target?: string
    }
  | {
      readonly type: 'append-journal'
      readonly workId: string
      readonly entryType: string
      readonly body: Buffer
    }
  | {
      readonly type: 'request-cancel'
      readonly workId: string
      readonly reason: string
    }
  | {
      readonly type: 'save-checkpoint-ref'
      readonly workId: string
      readonly checkpointId: string
      readonly format: string
      readonly version: number
      readonly blobRef: string
    }
  | {
      readonly type: 'open-gate'
      readonly workId: string
      readonly gateId: string
      readonly kind: string
    }
  | {
      readonly type: 'resolve-gate'
      readonly workId: string
      readonly gateId: string
      readonly decision: string
    }
  | {
      readonly type: 'record-outcome'
      readonly workId: string
      readonly status: 'completed' | 'failed' | 'cancelled'
      readonly result?: Buffer
    }
  | {
      readonly type: 'advertise-executor'
      readonly executorId: string
      readonly capabilities: readonly string[]
      readonly expiresAt: number
    }

export type DurableWorkQuery =
  | { readonly type: 'get-work'; readonly workId: string }
  | { readonly type: 'list-work' }
  | { readonly type: 'list-available-work' }
  | { readonly type: 'get-checkpoint-ref'; readonly workId: string }
  | { readonly type: 'list-journal'; readonly workId: string }
  | { readonly type: 'list-executor-presence' }

export interface DurableWorkResult {
  readonly work?: SyncDurableWork | null
  readonly works: SyncDurableWork[]
  readonly checkpoint?: SyncDurableWorkCheckpoint | null
  readonly entries: SyncDurableWorkJournalEntry[]
  readonly executors: SyncDurableWorkExecutor[]
}

export const durableWorkProfile: SyncProfileContract<
  DurableWorkCommand,
  DurableWorkQuery,
  DurableWorkResult
> = {
  id: 'qvac.sync.profiles.durable-work',
  version: 1,
  capabilities: [
    'work-envelope',
    'journal',
    'cancellation',
    'checkpoint-ref',
    'gate',
    'outcome',
    'executor-presence'
  ],
  visibility: 'mesh-wide'
}
