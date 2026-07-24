import { QvacErrorBase, addCodes } from '@qvac/error'

export const ASSISTANT_ERROR_CODES = {
  COMPONENT_START_FAILED: 59101,
  COMPONENT_INCOMPATIBLE: 59102,
  COMPONENT_EXITED: 59103
} as const

addCodes(
  {
    [ASSISTANT_ERROR_CODES.COMPONENT_START_FAILED]: {
      name: 'ASSISTANT_COMPONENT_START_FAILED',
      message: (component: string) => `${component} failed to start`
    },
    [ASSISTANT_ERROR_CODES.COMPONENT_INCOMPATIBLE]: {
      name: 'ASSISTANT_COMPONENT_INCOMPATIBLE',
      message: (component: string, reason: string) =>
        `${component} handshake failed: ${reason}`
    },
    [ASSISTANT_ERROR_CODES.COMPONENT_EXITED]: {
      name: 'ASSISTANT_COMPONENT_EXITED',
      message: (component: string, exit: string) =>
        `${component} runtime exited (${exit})`
    }
  },
  { name: '@qvac/assistant', version: '0.0.0-poc' }
)

export class AssistantComponentStartError extends QvacErrorBase {
  readonly component: string
  readonly recoverable = true

  constructor(component: string, cause?: unknown) {
    super({
      code: ASSISTANT_ERROR_CODES.COMPONENT_START_FAILED,
      adds: [component],
      cause: errorCause(cause)
    })
    this.component = component
  }
}

export class AssistantCompatibilityError extends QvacErrorBase {
  readonly component: string
  readonly reason: string
  readonly recoverable = false

  constructor(component: string, reason: string, cause?: unknown) {
    super({
      code: ASSISTANT_ERROR_CODES.COMPONENT_INCOMPATIBLE,
      adds: [component, reason],
      cause: errorCause(cause)
    })
    this.component = component
    this.reason = reason
  }
}

export class AssistantComponentExitedError extends QvacErrorBase {
  readonly component: string
  readonly recoverable = true

  constructor(
    component: string,
    exit: { readonly code: number | null; readonly signal: string | null },
    cause?: unknown
  ) {
    super({
      code: ASSISTANT_ERROR_CODES.COMPONENT_EXITED,
      adds: [component, formatExit(exit)],
      cause: errorCause(cause)
    })
    this.component = component
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
