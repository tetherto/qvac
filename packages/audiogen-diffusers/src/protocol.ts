export const PROTOCOL_VERSION = 1 as const
export const MAX_REQUEST_BYTES = 64 * 1024
export const MAX_EVENT_BYTES = 16 * 1024 * 1024
export const MINIMAX_SAMPLE_RATE = 44_100
export const MINIMAX_CHANNELS = 2

function utf8ByteLength (value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export interface RuntimeConfig {
  modelDir: string
  cacheDir?: string
  device?: 'cuda'
  torchDtype?: 'bfloat16'
}

export interface GenerateRequest {
  requestId: string
  caption: string
  lyrics: string
  maxFrames: number
  seed?: number
  inferenceSteps?: number
  cfgScale?: number
}

export type WorkerRequest =
  | { version: typeof PROTOCOL_VERSION, op: 'load', config: RuntimeConfig }
  | ({ version: typeof PROTOCOL_VERSION, op: 'generate' } & GenerateRequest)
  | { version: typeof PROTOCOL_VERSION, op: 'cancel', requestId: string }
  | { version: typeof PROTOCOL_VERSION, op: 'unload' }

export type WorkerEvent =
  | { version: typeof PROTOCOL_VERSION, status: 'loaded' }
  | { version: typeof PROTOCOL_VERSION, status: 'progress', requestId: string, stage: 'ar' | 'flow', step: number, total: number }
  | { version: typeof PROTOCOL_VERSION, status: 'audio', requestId: string, data: string, sampleRate: typeof MINIMAX_SAMPLE_RATE, channels: typeof MINIMAX_CHANNELS }
  | { version: typeof PROTOCOL_VERSION, status: 'completed', requestId: string, totalTimeMs: number }
  | { version: typeof PROTOCOL_VERSION, status: 'cancelled', requestId: string }
  | { version: typeof PROTOCOL_VERSION, status: 'unloaded' }
  | { version: typeof PROTOCOL_VERSION, status: 'error', error: { name: string, message: string }, requestId?: string }

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString (record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${key} must be a non-empty string`)
  }
  return value
}

function requirePositiveInteger (record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${key} must be a positive safe integer`)
  }
  return value
}

function optionalFiniteNumber (record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${key} must be a finite number`)
  }
  return value
}

function validateConfig (value: unknown): RuntimeConfig {
  if (!isRecord(value)) throw new TypeError('config must be an object')
  const modelDir = requireString(value, 'modelDir')
  const cacheDir = value['cacheDir'] === undefined ? undefined : requireString(value, 'cacheDir')
  if (value['device'] !== undefined && value['device'] !== 'cuda') {
    throw new TypeError('device must be cuda')
  }
  if (value['torchDtype'] !== undefined && value['torchDtype'] !== 'bfloat16') {
    throw new TypeError('torchDtype must be bfloat16')
  }
  return { modelDir, cacheDir, device: 'cuda', torchDtype: 'bfloat16' }
}

export function parseWorkerRequest (value: unknown): WorkerRequest {
  if (!isRecord(value)) throw new TypeError('request must be an object')
  if (value['version'] !== PROTOCOL_VERSION) {
    throw new TypeError(`unsupported protocol version: ${String(value['version'])}`)
  }
  switch (value['op']) {
    case 'load':
      return { version: PROTOCOL_VERSION, op: 'load', config: validateConfig(value['config']) }
    case 'generate':
      return {
        version: PROTOCOL_VERSION,
        op: 'generate',
        requestId: requireString(value, 'requestId'),
        caption: requireString(value, 'caption'),
        lyrics: requireString(value, 'lyrics'),
        maxFrames: requirePositiveInteger(value, 'maxFrames'),
        seed: optionalFiniteNumber(value, 'seed'),
        inferenceSteps: optionalFiniteNumber(value, 'inferenceSteps'),
        cfgScale: optionalFiniteNumber(value, 'cfgScale')
      }
    case 'cancel':
      return { version: PROTOCOL_VERSION, op: 'cancel', requestId: requireString(value, 'requestId') }
    case 'unload':
      return { version: PROTOCOL_VERSION, op: 'unload' }
    default:
      throw new TypeError(`unsupported operation: ${String(value['op'])}`)
  }
}

export function encodeWorkerRequest (request: WorkerRequest): string {
  const line = `${JSON.stringify(parseWorkerRequest(request))}\n`
  if (utf8ByteLength(line) > MAX_REQUEST_BYTES) {
    throw new RangeError('worker request exceeds 64 KiB')
  }
  return line
}

export function parseWorkerEvent (value: unknown): WorkerEvent {
  if (!isRecord(value)) throw new TypeError('worker event must be an object')
  if (value['version'] !== PROTOCOL_VERSION) {
    throw new TypeError(`unsupported protocol version: ${String(value['version'])}`)
  }
  if (typeof value['status'] !== 'string') throw new TypeError('worker event status must be a string')
  return value as WorkerEvent
}
