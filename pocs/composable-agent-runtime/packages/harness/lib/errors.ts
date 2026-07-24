import { QvacErrorBase, addCodes } from '@qvac/error'
import type { HarnessErrorEnvelope } from './types.ts'

export const HARNESS_ERROR_CODES = {
  SDK_EXITED: 59201,
  EXECUTION_FAILED: 59202
} as const

addCodes(
  {
    [HARNESS_ERROR_CODES.SDK_EXITED]: {
      name: 'HARNESS_SDK_EXITED',
      message: (exit: string) => `SDK runtime exited (${exit})`
    },
    [HARNESS_ERROR_CODES.EXECUTION_FAILED]: {
      name: 'HARNESS_EXECUTION_FAILED',
      message: (boundary: string) => `Harness execution failed at ${boundary}`
    }
  },
  { name: '@qvac/harness', version: '0.0.0-poc' }
)

export class HarnessSdkExitedError extends QvacErrorBase {
  readonly recoverable = true

  constructor(
    exit: { readonly code: number | null; readonly signal: string | null },
    cause?: unknown
  ) {
    super({
      code: HARNESS_ERROR_CODES.SDK_EXITED,
      adds: [formatExit(exit)],
      cause: errorCause(cause)
    })
  }
}

export class HarnessExecutionError extends QvacErrorBase {
  readonly boundary: string
  readonly recoverable = true

  constructor(boundary: string, cause?: unknown) {
    super({
      code: HARNESS_ERROR_CODES.EXECUTION_FAILED,
      adds: [boundary],
      cause: errorCause(cause)
    })
    this.boundary = boundary
  }
}

export function serializeHarnessError(
  error: unknown,
  options: {
    readonly traceId?: string
    readonly boundary?: string
    readonly maxCauseDepth?: number
  } = {}
): HarnessErrorEnvelope {
  return toEnvelope(error, options, options.maxCauseDepth ?? 4)
}

function toEnvelope(
  error: unknown,
  options: { readonly traceId?: string; readonly boundary?: string },
  remainingCauseDepth: number
): HarnessErrorEnvelope {
  if (!(error instanceof Error)) {
    return {
      name: 'Error',
      message:
        typeof error === 'string' && error.length > 0
          ? error
          : 'Unknown harness error',
      recoverable: false,
      ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
      ...(options.boundary === undefined ? {} : { boundary: options.boundary })
    }
  }

  const fields = error as Error & {
    code?: string | number
    recoverable?: boolean
    cause?: unknown
  }
  const code =
    typeof fields.code === 'string' || typeof fields.code === 'number'
      ? String(fields.code)
      : undefined
  const cause =
    remainingCauseDepth > 0 && fields.cause !== undefined
      ? toEnvelope(fields.cause, {}, remainingCauseDepth - 1)
      : undefined

  return {
    name: error.name || 'Error',
    message: error.message || 'Unknown harness error',
    ...(code === undefined ? {} : { code }),
    recoverable: fields.recoverable === true,
    ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
    ...(options.boundary === undefined ? {} : { boundary: options.boundary }),
    ...(cause === undefined ? {} : { cause })
  }
}

function errorCause(cause: unknown): Error | undefined {
  if (cause === undefined) return undefined
  return cause instanceof Error ? cause : new Error(String(cause))
}

function formatExit(exit: {
  readonly code: number | null
  readonly signal: string | null
}) {
  if (exit.signal) return `signal ${exit.signal}`
  return `code ${exit.code ?? 'unknown'}`
}
