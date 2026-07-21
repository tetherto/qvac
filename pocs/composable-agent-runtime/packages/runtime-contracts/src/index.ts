import { QvacErrorBase, addCodes } from '@qvac/error'
import QvacLogger, { type LogLevel } from '@qvac/logging'

export type RuntimeKind = 'bare' | 'bun' | 'node' | 'hermes' | 'unknown'

export interface RuntimeHandshake {
  contract: string
  protocolVersion: number
  capabilities: string[]
  requiredPeerCapabilities: string[]
  buildVersion: string
}

export interface CompatibilityResult {
  compatible: boolean
  negotiatedCapabilities: string[]
  missingLocalCapabilities: string[]
  missingRemoteCapabilities: string[]
  reason?: string
}

export interface RuntimeIdentity {
  component: string
  runtime: RuntimeKind
  instanceId: string
  processId?: number
  buildVersion: string
}

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type BoundaryEventType =
  | 'boundary.request'
  | 'boundary.response'
  | 'runtime.ready'
  | 'runtime.stopped'
  | 'runtime.died'
  | 'runtime.suspended'
  | 'runtime.resumed'

export interface BoundaryEvent {
  type: BoundaryEventType
  traceId: string
  source: RuntimeIdentity
  timestamp: number
  details?: { [key: string]: JsonValue }
  error?: RuntimeErrorEnvelope
}

export interface RuntimeErrorEnvelope {
  name: string
  message: string
  code?: string
  recoverable: boolean
  traceId?: string
  boundary?: string
  cause?: RuntimeErrorEnvelope
}

export interface SerializeErrorOptions {
  traceId?: string
  boundary?: string
  maxCauseDepth?: number
}

export type RuntimeLogLevel = LogLevel

export interface RuntimeLoggingConfig {
  readonly level?: RuntimeLogLevel
}

export interface RuntimeLogger {
  error(...values: unknown[]): void
  warn(...values: unknown[]): void
  info(...values: unknown[]): void
  debug(...values: unknown[]): void
}

export const RUNTIME_ERROR_CODES = {
  COMPONENT_START_FAILED: 59001,
  COMPONENT_INCOMPATIBLE: 59002,
  COMPONENT_EXITED: 59003,
  EXECUTION_FAILED: 59004
} as const

addCodes(
  {
    [RUNTIME_ERROR_CODES.COMPONENT_START_FAILED]: {
      name: 'RUNTIME_COMPONENT_START_FAILED',
      message: (component: string) => `${component} failed to start`
    },
    [RUNTIME_ERROR_CODES.COMPONENT_INCOMPATIBLE]: {
      name: 'RUNTIME_COMPONENT_INCOMPATIBLE',
      message: (component: string, reason: string) =>
        `${component} handshake failed: ${reason}`
    },
    [RUNTIME_ERROR_CODES.COMPONENT_EXITED]: {
      name: 'RUNTIME_COMPONENT_EXITED',
      message: (component: string, exit: string) =>
        `${component} runtime exited (${exit})`
    },
    [RUNTIME_ERROR_CODES.EXECUTION_FAILED]: {
      name: 'RUNTIME_EXECUTION_FAILED',
      message: (boundary: string) => `Runtime execution failed at ${boundary}`
    }
  },
  { name: '@qvac/runtime-contracts', version: '0.0.0-poc' }
)

let traceSequence = 0

export class RuntimeComponentStartError extends QvacErrorBase {
  readonly component: string
  readonly recoverable = true

  constructor(component: string, cause?: unknown) {
    super({
      code: RUNTIME_ERROR_CODES.COMPONENT_START_FAILED,
      adds: [component],
      cause: errorCause(cause)
    })
    this.component = component
  }
}

export class RuntimeCompatibilityError extends QvacErrorBase {
  readonly component: string
  readonly reason: string
  readonly recoverable = false

  constructor(component: string, reason: string, cause?: unknown) {
    super({
      code: RUNTIME_ERROR_CODES.COMPONENT_INCOMPATIBLE,
      adds: [component, reason],
      cause: errorCause(cause)
    })
    this.component = component
    this.reason = reason
  }
}

export class RuntimeComponentExitedError extends QvacErrorBase {
  readonly component: string
  readonly recoverable = true

  constructor(
    component: string,
    exit: { readonly code: number | null; readonly signal: string | null },
    cause?: unknown
  ) {
    super({
      code: RUNTIME_ERROR_CODES.COMPONENT_EXITED,
      adds: [component, formatExit(exit)],
      cause: errorCause(cause)
    })
    this.component = component
  }
}

export class RuntimeExecutionError extends QvacErrorBase {
  readonly boundary: string
  readonly recoverable = true

  constructor(boundary: string, cause?: unknown) {
    super({
      code: RUNTIME_ERROR_CODES.EXECUTION_FAILED,
      adds: [boundary],
      cause: errorCause(cause)
    })
    this.boundary = boundary
  }
}

export function createRuntimeLogger(
  component: string,
  config: RuntimeLoggingConfig = {}
): RuntimeLogger {
  const write = (...values: unknown[]) => console.error(...values)
  const logger = new QvacLogger({
    error: write,
    warn: write,
    info: write,
    debug: write
  })
  logger.setLevel(config.level ?? 'off')
  const prefix = `[${component}]`
  return {
    error: (...values) => logger.error(prefix, ...values),
    warn: (...values) => logger.warn(prefix, ...values),
    info: (...values) => logger.info(prefix, ...values),
    debug: (...values) => logger.debug(prefix, ...values)
  }
}

export function checkCompatibility(
  local: RuntimeHandshake,
  remote: RuntimeHandshake
) {
  const negotiatedCapabilities = local.capabilities.filter((capability) =>
    remote.capabilities.includes(capability)
  )
  const missingLocalCapabilities = remote.requiredPeerCapabilities.filter(
    (capability) => !local.capabilities.includes(capability)
  )
  const missingRemoteCapabilities = local.requiredPeerCapabilities.filter(
    (capability) => !remote.capabilities.includes(capability)
  )
  const base = {
    negotiatedCapabilities,
    missingLocalCapabilities,
    missingRemoteCapabilities
  }

  if (local.contract !== remote.contract) {
    return {
      compatible: false,
      ...base,
      reason: `contract mismatch: ${local.contract} != ${remote.contract}`
    } satisfies CompatibilityResult
  }

  if (local.protocolVersion !== remote.protocolVersion) {
    return {
      compatible: false,
      ...base,
      reason: `protocol mismatch: ${local.protocolVersion} != ${remote.protocolVersion}`
    } satisfies CompatibilityResult
  }

  if (
    missingLocalCapabilities.length > 0 ||
    missingRemoteCapabilities.length > 0
  ) {
    return {
      compatible: false,
      ...base,
      reason: 'required capabilities missing'
    } satisfies CompatibilityResult
  }

  return {
    compatible: true,
    ...base
  } satisfies CompatibilityResult
}

export function createTraceId() {
  traceSequence = (traceSequence + 1) % Number.MAX_SAFE_INTEGER
  const time = Date.now().toString(36)
  const sequence = traceSequence.toString(36)
  const entropy = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(36)
    .padStart(7, '0')

  return `trc_${time}_${sequence}_${entropy}`
}

export function isTraceId(value: string) {
  return /^trc_[a-z0-9]+_[a-z0-9]+_[a-z0-9]{7}$/.test(value)
}

export function createRuntimeIdentity(identity: RuntimeIdentity) {
  if (
    identity.component.length === 0 ||
    identity.instanceId.length === 0 ||
    identity.buildVersion.length === 0
  ) {
    throw new Error('Runtime identity fields must not be empty')
  }

  return { ...identity }
}

export function createBoundaryEvent(event: BoundaryEvent) {
  if (!isTraceId(event.traceId)) {
    throw new Error('Invalid trace ID')
  }

  return {
    ...event,
    source: { ...event.source },
    details: event.details === undefined ? undefined : { ...event.details }
  }
}

export function serializeError(
  error: unknown,
  options: SerializeErrorOptions = {}
) {
  const maxCauseDepth = options.maxCauseDepth ?? 4
  return toEnvelope(error, options, maxCauseDepth)
}

export function deserializeError(envelope: RuntimeErrorEnvelope) {
  return new RuntimeBoundaryError(envelope)
}

export class RuntimeBoundaryError extends Error {
  readonly code?: string
  readonly recoverable: boolean
  readonly traceId?: string
  readonly boundary?: string
  override readonly cause?: RuntimeBoundaryError

  constructor(envelope: RuntimeErrorEnvelope) {
    const cause =
      envelope.cause === undefined
        ? undefined
        : new RuntimeBoundaryError(envelope.cause)
    super(envelope.message, { cause })
    this.name = envelope.name
    this.code = envelope.code
    this.recoverable = envelope.recoverable
    this.traceId = envelope.traceId
    this.boundary = envelope.boundary
    this.cause = cause
  }
}

function toEnvelope(
  error: unknown,
  options: SerializeErrorOptions,
  remainingCauseDepth: number
): RuntimeErrorEnvelope {
  if (!(error instanceof Error)) {
    return {
      name: 'Error',
      message:
        typeof error === 'string' && error.length > 0
          ? error
          : 'Unknown runtime error',
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
    message: error.message || 'Unknown runtime error',
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
