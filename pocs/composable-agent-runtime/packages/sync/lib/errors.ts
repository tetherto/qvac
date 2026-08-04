import { QvacErrorBase, addCodes } from '@qvac/error'

export {
  SyncSuspendedError,
  type SyncErrorCategory
} from './runtime/errors.ts'

export const SYNC_ERROR_CODES = {
  COMPONENT_START_FAILED: 59001
} as const

addCodes(
  {
    [SYNC_ERROR_CODES.COMPONENT_START_FAILED]: {
      name: 'SYNC_COMPONENT_START_FAILED',
      message: () => 'Sync sidecar failed to start'
    }
  },
  { name: '@qvac/sync', version: '0.0.0-poc' }
)

export class SyncComponentStartError extends QvacErrorBase {
  readonly recoverable = true

  constructor(cause?: unknown) {
    super({
      code: SYNC_ERROR_CODES.COMPONENT_START_FAILED,
      adds: [],
      cause: errorCause(cause)
    })
  }
}

function errorCause(cause: unknown): Error | undefined {
  if (cause === undefined) return undefined
  return cause instanceof Error ? cause : new Error(String(cause))
}
