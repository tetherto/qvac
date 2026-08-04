export type SyncErrorCategory =
  | 'unavailable'
  | 'suspended'
  | 'incompatible'
  | 'profile-not-installed'
  | 'revision-conflict'
  | 'unauthorized'
  | 'invalid-invitation'
  | 'invalid-transition'
  | 'generation-ended'
  | 'migration-or-storage-failure'

export interface SyncErrorEnvelope {
  readonly category: SyncErrorCategory
  readonly message: string
  readonly retryable: boolean
  readonly operationId?: string
  readonly traceId?: string
  readonly causes: readonly { readonly message: string }[]
}

export function toSyncError(
  error: unknown,
  context: {
    readonly operationId?: string
    readonly traceId?: string
  } = {}
) {
  const message = safeMessage(error)
  const category = categorize(message)
  const envelope: SyncErrorEnvelope = {
    category,
    message,
    retryable: category === 'unavailable',
    ...context,
    causes: [{ message }]
  }
  const result = new Error(envelope.message)
  result.name = 'SyncError'
  Object.assign(result, envelope)
  Object.defineProperty(result, 'stack', {
    value: undefined,
    enumerable: false,
    configurable: true
  })
  return result as Error & SyncErrorEnvelope
}

export class SyncSuspendedError extends Error {
  readonly category: SyncErrorCategory = 'suspended'

  constructor(message = 'Sync runtime is suspended') {
    super(message)
    this.name = 'SyncSuspendedError'
  }
}

export class SyncGenerationEndedError extends Error {
  readonly category: SyncErrorCategory = 'generation-ended'

  constructor(message = 'Sync runtime generation ended') {
    super(message)
    this.name = 'SyncGenerationEndedError'
  }
}

function categorize(message: string): SyncErrorCategory {
  if (/generation ended/i.test(message)) return 'generation-ended'
  if (/suspend/i.test(message)) return 'suspended'
  if (/revision conflict/i.test(message)) return 'revision-conflict'
  if (/invalid.*transition/i.test(message)) return 'invalid-transition'
  if (/profile.*not.*installed|unknown sync profile/i.test(message)) {
    return 'profile-not-installed'
  }
  if (/invite|pairing/i.test(message)) return 'invalid-invitation'
  if (/unauthori|not permitted|read-only/i.test(message)) return 'unauthorized'
  if (/storage|migration|rocks|corestore/i.test(message)) {
    return 'migration-or-storage-failure'
  }
  return 'unavailable'
}

function safeMessage(error: unknown) {
  if (!(error instanceof Error)) return 'Sync operation failed'
  const message = error.message.trim()
  if (!message) return 'Sync operation failed'
  return message.slice(0, 512)
}
