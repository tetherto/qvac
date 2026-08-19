import type { FitConfig, FitResult, LlamaLoadFitConfig } from './index'

export const FIT_PROCESS_PROTOCOL_VERSION = 1 as const
export const FIT_PROCESS_PROTOCOL_VERSION_V2 = 2 as const
export const FIT_PROCESS_MAX_REQUEST_BYTES = 64 * 1024
export const FIT_PROCESS_MAX_RESPONSE_BYTES = 1024 * 1024

export interface FitProcessRequestV1 {
  version: typeof FIT_PROCESS_PROTOCOL_VERSION
  config: FitConfig
}

export interface FitProcessRequestV2 {
  version: typeof FIT_PROCESS_PROTOCOL_VERSION_V2
  config: LlamaLoadFitConfig
}

export type FitProcessRequest = FitProcessRequestV1 | FitProcessRequestV2

export interface FitProcessCompletedResponseV1 {
  version: typeof FIT_PROCESS_PROTOCOL_VERSION
  status: 'completed'
  result: FitResult
}

export interface FitProcessCompletedResponseV2 {
  version: typeof FIT_PROCESS_PROTOCOL_VERSION_V2
  status: 'completed'
  result: FitResult
}

export interface FitProcessInvocationErrorResponseV1 {
  version: typeof FIT_PROCESS_PROTOCOL_VERSION
  status: 'invocation-error'
  error: {
    name: string
    message: string
  }
}

export interface FitProcessInvocationErrorResponseV2 {
  version: typeof FIT_PROCESS_PROTOCOL_VERSION_V2
  status: 'invocation-error'
  error: {
    name: string
    message: string
  }
}

export type FitProcessResponse =
  | FitProcessCompletedResponseV1
  | FitProcessCompletedResponseV2
  | FitProcessInvocationErrorResponseV1
  | FitProcessInvocationErrorResponseV2

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNumber (record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
    throw new TypeError(`Fit process result ${key} must be a number`)
  }
}

function assertOptionalNumber (record: Record<string, unknown>, key: string): void {
  if (record[key] !== undefined) assertNumber(record, key)
}

function assertFitPlan (result: Record<string, unknown>, required: boolean): void {
  for (const key of [
    'nGpuLayers',
    'nCtx',
    'nBatch',
    'nUbatch',
    'splitMode',
    'mainGpu',
    'typeK',
    'typeV',
    'flashAttnType'
  ]) {
    if (required) assertNumber(result, key)
    else assertOptionalNumber(result, key)
  }
  if (
    (required || result['tensorSplit'] !== undefined) &&
    (!Array.isArray(result['tensorSplit']) ||
      !result['tensorSplit'].every(entry => typeof entry === 'number' && Number.isFinite(entry)))
  ) {
    throw new TypeError('Fit process result tensorSplit must be an array of numbers')
  }
  if ((required || result['buftOverrides'] !== undefined) && !Array.isArray(result['buftOverrides'])) {
    throw new TypeError('Fit process result buftOverrides must be an array')
  }
  if (Array.isArray(result['buftOverrides'])) {
    for (const override of result['buftOverrides']) {
      if (
        !isRecord(override) ||
        typeof override['pattern'] !== 'string' ||
        typeof override['bufferType'] !== 'string'
      ) {
        throw new TypeError('Fit process result buftOverrides entries must contain string fields')
      }
    }
  }
}

function assertFitResult (value: unknown): asserts value is FitResult {
  if (!isRecord(value)) {
    throw new TypeError('Fit process result must be an object')
  }
  assertNumber(value, 'maxDevices')
  assertNumber(value, 'nDevices')
  assertNumber(value, 'nGpuDevices')

  switch (value['status']) {
    case 0:
      if (value['fits'] !== true || value['reason'] !== 'fits') {
        throw new TypeError("Fit process result must report fits for status 0")
      }
      assertFitPlan(value, true)
      if ((value['nCtx'] as number) <= 0) {
        throw new TypeError('Fit process result nCtx must be greater than 0 for status 0')
      }
      return
    case 1:
      if (value['fits'] !== false || value['reason'] !== 'does-not-fit') {
        throw new TypeError("Fit process result must report does-not-fit for status 1")
      }
      assertFitPlan(value, false)
      return
    case 2:
      if (
        value['fits'] !== false ||
        !['model-unreadable', 'no-backend-device', 'unsupported-config'].includes(
          value['reason'] as string
        )
      ) {
        throw new TypeError('Fit process result reason is invalid for status 2')
      }
      assertFitPlan(value, false)
      return
    default:
      throw new TypeError(`Fit process result status is invalid: ${String(value['status'])}`)
  }
}

function encodeFitProcessRequestEnvelope (request: FitProcessRequest): string {
  const encoded = `${JSON.stringify(request)}\n`
  if (Buffer.byteLength(encoded, 'utf8') > FIT_PROCESS_MAX_REQUEST_BYTES) {
    throw new RangeError('Fit process request exceeds 64 KiB')
  }
  return encoded
}

function assertLlamaLoadFitConfig (config: LlamaLoadFitConfig): void {
  if (!isRecord(config) || typeof config.modelPath !== 'string' || config.modelPath.length === 0) {
    throw new TypeError('Fit process llama config modelPath must be a non-empty string')
  }
  const allowedFields = new Set(['modelPath', 'config', 'backendsDir', 'marginMiB', 'nCtxMin'])
  for (const key of Object.keys(config)) {
    if (!allowedFields.has(key)) {
      throw new TypeError(`Fit process llama config unknown top-level field '${key}'`)
    }
  }
  if (Buffer.byteLength(config.modelPath, 'utf8') > 4096) {
    throw new RangeError('Fit process llama config modelPath must not exceed 4096 bytes')
  }
  if (
    config.backendsDir !== undefined &&
    (typeof config.backendsDir !== 'string' ||
      config.backendsDir.length === 0 ||
      Buffer.byteLength(config.backendsDir, 'utf8') > 4096)
  ) {
    throw new RangeError(
      'Fit process llama config backendsDir must be a non-empty string no longer than 4096 bytes'
    )
  }
  if (!isRecord(config.config)) {
    throw new TypeError('Fit process llama config config must be an object')
  }
  const entries = Object.entries(config.config)
  if (entries.length > 256) {
    throw new RangeError('Fit process llama config must not contain more than 256 entries')
  }
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      throw new TypeError(`Fit process llama config config.${key} must be a string`)
    }
    if (Buffer.byteLength(key, 'utf8') === 0 || Buffer.byteLength(key, 'utf8') > 128) {
      throw new RangeError('Fit process llama config keys must be 1 to 128 bytes')
    }
    if (Buffer.byteLength(value, 'utf8') > 4096) {
      throw new RangeError('Fit process llama config values must not exceed 4096 bytes')
    }
  }
  for (const key of ['marginMiB', 'nCtxMin'] as const) {
    const value = config[key]
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 0 || value > 4294967295)
    ) {
      throw new RangeError(`Fit process llama config ${key} must be a uint32`)
    }
  }
}

export function encodeFitProcessRequest (config: FitConfig): string {
  return encodeFitProcessRequestEnvelope({
    version: FIT_PROCESS_PROTOCOL_VERSION,
    config
  })
}

export function encodeFitLlamaProcessRequest (config: LlamaLoadFitConfig): string {
  assertLlamaLoadFitConfig(config)
  return encodeFitProcessRequestEnvelope({
    version: FIT_PROCESS_PROTOCOL_VERSION_V2,
    config
  })
}

export function parseFitProcessResponse (value: unknown): FitProcessResponse {
  if (!isRecord(value)) {
    throw new TypeError('Fit process response must be an object')
  }
  if (
    value['version'] !== FIT_PROCESS_PROTOCOL_VERSION &&
    value['version'] !== FIT_PROCESS_PROTOCOL_VERSION_V2
  ) {
    throw new TypeError(`Unsupported fit process protocol version: ${String(value['version'])}`)
  }
  const version = value['version']

  switch (value['status']) {
    case 'completed':
      assertFitResult(value['result'])
      return { version, status: 'completed', result: value['result'] }
    case 'invocation-error': {
      const error = value['error']
      if (!isRecord(error)) {
        throw new TypeError('Fit process response error must be an object')
      }
      if (typeof error['name'] !== 'string' || typeof error['message'] !== 'string') {
        throw new TypeError('Fit process response error fields must be strings')
      }
      return {
        version,
        status: 'invocation-error',
        error: { name: error['name'], message: error['message'] }
      }
    }
    default:
      throw new TypeError(`Fit process response status is invalid: ${String(value['status'])}`)
  }
}

export function resolveFitProcessRunnerPath (): string {
  return require.resolve('./process-runner.js')
}
