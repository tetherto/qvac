export const DEEP_PROBE_PROTOCOL_VERSION = 1
export const DEEP_PROBE_MESSAGE_KIND = 'qvac-doctor-deep-result'

export type DeepProbePhase = 'import' | 'heartbeat' | 'close'

export interface SerializedProbeError {
  name: string
  message: string
  stack?: string | undefined
  code?: string | number | undefined
  exitCode?: number | null | undefined
  exitSignal?: string | null | undefined
  cause?: SerializedProbeError | undefined
}

interface DeepProbeMessageBase {
  kind: typeof DEEP_PROBE_MESSAGE_KIND
  version: typeof DEEP_PROBE_PROTOCOL_VERSION
  phase: DeepProbePhase
}

export interface DeepProbeSuccessMessage extends DeepProbeMessageBase {
  ok: true
}

export interface DeepProbeFailureMessage extends DeepProbeMessageBase {
  ok: false
  error: SerializedProbeError
  cleanupError?: SerializedProbeError | undefined
}

export type DeepProbeMessage = DeepProbeSuccessMessage | DeepProbeFailureMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPhase(value: unknown): value is DeepProbePhase {
  return value === 'import' || value === 'heartbeat' || value === 'close'
}

function isSerializedError(value: unknown, depth: number = 0): value is SerializedProbeError {
  if (!isRecord(value) || depth > 5) return false
  if (typeof value['name'] !== 'string' || typeof value['message'] !== 'string') return false
  if (value['stack'] !== undefined && typeof value['stack'] !== 'string') return false
  if (
    value['code'] !== undefined &&
    typeof value['code'] !== 'string' &&
    typeof value['code'] !== 'number'
  ) {
    return false
  }
  if (
    value['exitCode'] !== undefined &&
    value['exitCode'] !== null &&
    typeof value['exitCode'] !== 'number'
  ) {
    return false
  }
  if (
    value['exitSignal'] !== undefined &&
    value['exitSignal'] !== null &&
    typeof value['exitSignal'] !== 'string'
  ) {
    return false
  }
  return value['cause'] === undefined || isSerializedError(value['cause'], depth + 1)
}

export function isDeepProbeMessage(value: unknown): value is DeepProbeMessage {
  if (!isRecord(value)) return false
  if (value['kind'] !== DEEP_PROBE_MESSAGE_KIND) return false
  if (value['version'] !== DEEP_PROBE_PROTOCOL_VERSION || !isPhase(value['phase'])) return false
  if (value['ok'] === true) {
    return value['error'] === undefined && value['cleanupError'] === undefined
  }
  return (
    value['ok'] === false &&
    isSerializedError(value['error']) &&
    (value['cleanupError'] === undefined || isSerializedError(value['cleanupError']))
  )
}

export function isDeepProbeProtocolCandidate(value: unknown): boolean {
  return isRecord(value) && value['kind'] === DEEP_PROBE_MESSAGE_KIND
}
