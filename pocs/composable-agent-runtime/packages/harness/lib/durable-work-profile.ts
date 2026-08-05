export type DurableWorkBytes = Buffer

export type DurableWorkCommand =
  | {
      readonly type: 'record-work'
      readonly workId: string
      readonly payload: DurableWorkBytes
      readonly payloadFormat: string
      readonly payloadVersion: number
      readonly target?: string
    }
  | {
      readonly type: 'append-journal'
      readonly workId: string
      readonly entryType: string
      readonly body: DurableWorkBytes
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
      readonly type: 'record-outcome'
      readonly workId: string
      readonly status: 'completed' | 'failed' | 'cancelled'
      readonly result?: DurableWorkBytes
    }

export type DurableWorkQuery =
  | { readonly type: 'get-work'; readonly workId: string }
  | { readonly type: 'list-available-work' }
  | { readonly type: 'get-checkpoint-ref'; readonly workId: string }
  | { readonly type: 'list-journal'; readonly workId: string }

export interface DurableWorkRecord {
  readonly workId: string
  readonly payload?: DurableWorkBytes
  readonly payloadFormat?: string
  readonly payloadVersion?: number
  readonly target?: string | null
  readonly createdAt?: number
  readonly cancelRequested?: boolean
  readonly cancelReason?: string | null
  readonly outcomeStatus?: 'completed' | 'failed' | 'cancelled' | null
  readonly outcomeResult?: DurableWorkBytes | null
}

export interface DurableWorkJournalEntry {
  readonly id?: string
  readonly workId?: string
  readonly entryType?: string
  readonly body: DurableWorkBytes
  readonly recordedAt?: number
}

export interface DurableWorkCheckpoint {
  readonly workId?: string
  readonly checkpointId?: string
  readonly format?: string
  readonly version?: number
  readonly blobRef: string
  readonly recordedAt?: number
}

export interface DurableWorkExecutor {
  readonly executorId: string
  readonly capabilities: readonly string[]
  readonly expiresAt: number
  readonly recordedAt?: number
}

export interface DurableWorkResult {
  readonly work?: DurableWorkRecord | null
  readonly works: readonly DurableWorkRecord[]
  readonly checkpoint?: DurableWorkCheckpoint | null
  readonly entries: readonly DurableWorkJournalEntry[]
  readonly executors: readonly DurableWorkExecutor[]
}

export interface DurableWorkProfileContract {
  readonly id: string
  readonly version: number
  readonly capabilities: readonly string[]
  readonly visibility: 'mesh-wide'
  readonly types?: {
    readonly command: DurableWorkCommand
    readonly query: DurableWorkQuery
    readonly result: DurableWorkResult
    readonly change: DurableWorkResult
  }
}

export const durableWorkProfileCapabilities = [
  'work-envelope',
  'journal',
  'cancellation',
  'checkpoint-ref',
  'gate',
  'outcome',
  'executor-presence'
] as const

export const durableWorkProfile = {
  id: 'qvac.sync.profiles.durable-work',
  version: 1,
  capabilities: durableWorkProfileCapabilities,
  visibility: 'mesh-wide'
} satisfies DurableWorkProfileContract
