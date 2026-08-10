import type { FitConfig, FitResult } from './index'
import {
  FIT_PROCESS_MAX_REQUEST_BYTES,
  FIT_PROCESS_MAX_RESPONSE_BYTES,
  FIT_PROCESS_PROTOCOL_VERSION,
  type FitProcessRequest,
  type FitProcessResponse
} from './process'

export interface FitProcessOutcome {
  response: FitProcessResponse
  /** The response already encoded, so a caller never re-serialises it to write it. */
  responseLine: string
  exitCode: 0 | 1 | 2
}

export type FitProcessFit = (config: FitConfig) => FitResult

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFitProcessRequest (value: unknown): FitProcessRequest {
  if (!isRecord(value)) {
    throw new TypeError('Fit process request must be an object')
  }
  if (value['version'] !== FIT_PROCESS_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported fit process protocol version: ${String(value['version'])}`)
  }

  const config = value['config']
  if (!isRecord(config)) {
    throw new TypeError('Fit process request config must be an object')
  }
  if (typeof config['modelPath'] !== 'string') {
    throw new TypeError('Fit process request config modelPath must be a string')
  }

  return {
    version: FIT_PROCESS_PROTOCOL_VERSION,
    config: config as unknown as FitConfig
  }
}

export function encodeFitProcessResponse (response: FitProcessResponse): string {
  const encoded = `${JSON.stringify(response)}\n`
  if (Buffer.byteLength(encoded, 'utf8') > FIT_PROCESS_MAX_RESPONSE_BYTES) {
    throw new RangeError('Fit process response exceeds 1 MiB')
  }
  return encoded
}

function invocationError (error: unknown): FitProcessResponse {
  return {
    version: FIT_PROCESS_PROTOCOL_VERSION,
    status: 'invocation-error',
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function boundedInvocationError (error: unknown, exitCode: 1 | 2): FitProcessOutcome {
  const response = invocationError(error)
  try {
    return { response, responseLine: encodeFitProcessResponse(response), exitCode }
  } catch {
    const bounded = invocationError(new RangeError('Fit process response exceeds 1 MiB'))
    return { response: bounded, responseLine: encodeFitProcessResponse(bounded), exitCode }
  }
}

export function runFitProcessLine (line: string, fit: FitProcessFit): FitProcessOutcome {
  // The sender spends a byte of its budget on the newline delimiter, so charge
  // the request for it here too rather than bounding a different quantity.
  if (Buffer.byteLength(line, 'utf8') + 1 > FIT_PROCESS_MAX_REQUEST_BYTES) {
    return boundedInvocationError(new RangeError('Fit process request exceeds 64 KiB'), 2)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    return boundedInvocationError(error, 2)
  }

  let request: FitProcessRequest
  try {
    request = parseFitProcessRequest(parsed)
  } catch (error) {
    return boundedInvocationError(error, 2)
  }

  try {
    const response: FitProcessResponse = {
      version: FIT_PROCESS_PROTOCOL_VERSION,
      status: 'completed',
      result: fit(request.config)
    }
    return { response, responseLine: encodeFitProcessResponse(response), exitCode: 0 }
  } catch (error) {
    return boundedInvocationError(error, 1)
  }
}
