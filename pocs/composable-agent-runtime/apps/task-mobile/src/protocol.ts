export const PROTOCOL_CONTRACT = 'qvac.mobile-runtime-feasibility'
export const PROTOCOL_VERSION = 1
export const BUILD_VERSION = '0.0.0-poc'

export const COMPONENTS = ['Sync', 'Harness', 'SDK'] as const
export type ComponentName = (typeof COMPONENTS)[number]

export type RuntimeState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'suspended'
  | 'stopping'
  | 'stopped'
  | 'died'
  | 'error'

export interface TraceMetadata {
  readonly component: ComponentName | 'MobileHost'
  readonly contract: string
  readonly protocolVersion: number
  readonly capabilities: readonly string[]
  readonly buildVersion: string
  readonly runtimeId: string
  readonly processId: number | null
  readonly runtime: 'bare' | 'hermes'
}

export type RuntimeCommandName =
  | 'handshake'
  | 'prepare-suspend'
  | 'resume'
  | 'hard-crash'

export interface RuntimeCommand {
  readonly type: 'command'
  readonly command: RuntimeCommandName
  readonly requestId: string
  readonly traceId: string
  readonly timestamp: number
  readonly source: TraceMetadata
}

export interface RuntimeEvent {
  readonly type: 'event'
  readonly event:
    | 'runtime.ready'
    | 'runtime.suspended'
    | 'runtime.resumed'
    | 'runtime.stopped'
  readonly requestId: string | null
  readonly traceId: string
  readonly timestamp: number
  readonly source: TraceMetadata
  readonly compatible?: boolean
  readonly reason?: string
}

export type RuntimeMessage = RuntimeCommand | RuntimeEvent

export function capabilitiesFor(component: ComponentName) {
  const capabilities = [
    'protocol-handshake',
    'trace-metadata',
    'graceful-termination',
    'suspend-resume'
  ]
  if (component === 'SDK') capabilities.push('test-only-native-abort')
  return capabilities
}

export function createTraceId(prefix = 'trc') {
  const entropy = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(36)
    .padStart(7, '0')
  return `${prefix}_${Date.now().toString(36)}_${entropy}`
}

export function encodeMessage(message: RuntimeMessage) {
  return `${JSON.stringify(message)}\n`
}

export function parseMessage(line: string): RuntimeMessage {
  const parsed: unknown = JSON.parse(line)
  if (!isRecord(parsed) || (parsed.type !== 'command' && parsed.type !== 'event')) {
    throw new Error('Invalid mobile runtime protocol message')
  }
  if (
    typeof parsed.traceId !== 'string' ||
    typeof parsed.timestamp !== 'number' ||
    !isTraceMetadata(parsed.source)
  ) {
    throw new Error('Mobile runtime message is missing trace metadata')
  }
  if (
    parsed.type === 'command' &&
    (typeof parsed.requestId !== 'string' || !isRuntimeCommand(parsed.command))
  ) {
    throw new Error('Invalid mobile runtime command')
  }
  if (
    parsed.type === 'event' &&
    ((typeof parsed.requestId !== 'string' && parsed.requestId !== null) ||
      !isRuntimeEvent(parsed.event))
  ) {
    throw new Error('Invalid mobile runtime event')
  }
  return parsed as unknown as RuntimeMessage
}

export function isCompatibleHandshake(
  host: TraceMetadata,
  runtime: TraceMetadata
) {
  if (host.contract !== runtime.contract) {
    return `contract mismatch: ${host.contract} != ${runtime.contract}`
  }
  if (host.protocolVersion !== runtime.protocolVersion) {
    return `protocol mismatch: ${host.protocolVersion} != ${runtime.protocolVersion}`
  }
  if (!host.capabilities.includes('host-runner-broker')) {
    return 'host runner broker capability missing'
  }
  if (!runtime.capabilities.includes('protocol-handshake')) {
    return 'runtime handshake capability missing'
  }
  return null
}

function isTraceMetadata(value: unknown): value is TraceMetadata {
  if (!isRecord(value) || !Array.isArray(value.capabilities)) return false
  return (
    typeof value.component === 'string' &&
    value.contract === PROTOCOL_CONTRACT &&
    typeof value.protocolVersion === 'number' &&
    value.capabilities.every((capability) => typeof capability === 'string') &&
    typeof value.buildVersion === 'string' &&
    typeof value.runtimeId === 'string' &&
    (typeof value.processId === 'number' || value.processId === null) &&
    (value.runtime === 'bare' || value.runtime === 'hermes')
  )
}

function isRuntimeCommand(value: unknown): value is RuntimeCommandName {
  return (
    value === 'handshake' ||
    value === 'prepare-suspend' ||
    value === 'resume' ||
    value === 'hard-crash'
  )
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent['event'] {
  return (
    value === 'runtime.ready' ||
    value === 'runtime.suspended' ||
    value === 'runtime.resumed' ||
    value === 'runtime.stopped'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
