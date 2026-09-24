import type { FitProbeRequest, FitProbeResult } from '@/resources/model-fit/native-probe/engine-fit'

/**
 * One JSON line in, one JSON line out. The child holds a native addon for the
 * duration of the call, so the boundary stays deliberately narrow: nothing
 * streams, nothing is stateful, and a child that dies mid-call costs only the
 * projection.
 */
export const FIT_PROCESS_PROTOCOL_VERSION = 1

export const FIT_PROCESS_MAX_REQUEST_BYTES = 256 * 1024
export const FIT_PROCESS_MAX_RESPONSE_BYTES = 1024 * 1024

export interface FitProcessRequest {
  version: number
  probe: FitProbeRequest
}

export type FitProcessResponse =
  | { status: 'completed'; probe: FitProbeResult }
  | { status: 'invocation-error'; error: { name: string; message: string } }

export function encodeFitProcessRequest(probe: FitProbeRequest): string {
  const line = `${JSON.stringify({ version: FIT_PROCESS_PROTOCOL_VERSION, probe })}\n`
  if (Buffer.byteLength(line) > FIT_PROCESS_MAX_REQUEST_BYTES) {
    throw new RangeError(`Fit request exceeds ${FIT_PROCESS_MAX_REQUEST_BYTES} bytes`)
  }
  return line
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFitProcessRequest(value: unknown): FitProcessRequest {
  if (!isRecord(value)) throw new TypeError('Fit request must be an object')
  if (value['version'] !== FIT_PROCESS_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported fit protocol version: ${String(value['version'])}`)
  }
  const probe = value['probe']
  if (!isRecord(probe) || typeof probe['engine'] !== 'string' || !isRecord(probe['request'])) {
    throw new TypeError('Fit request must carry an engine and a request')
  }
  return { version: FIT_PROCESS_PROTOCOL_VERSION, probe: probe as unknown as FitProbeRequest }
}

export function parseFitProcessResponse(value: unknown): FitProcessResponse {
  if (!isRecord(value)) throw new TypeError('Fit response must be an object')

  if (value['status'] === 'invocation-error') {
    const error = value['error']
    if (
      !isRecord(error) ||
      typeof error['name'] !== 'string' ||
      typeof error['message'] !== 'string'
    ) {
      throw new TypeError('Fit invocation error must carry a name and a message')
    }
    return { status: 'invocation-error', error: { name: error['name'], message: error['message'] } }
  }

  if (value['status'] !== 'completed') {
    throw new TypeError(`Unknown fit response status: ${String(value['status'])}`)
  }

  const probe = value['probe']
  if (!isRecord(probe) || typeof probe['engine'] !== 'string' || !isRecord(probe['result'])) {
    throw new TypeError('Fit response must carry an engine and a result')
  }
  if (typeof (probe['result'] as Record<string, unknown>)['status'] !== 'string') {
    throw new TypeError('Fit result must carry a status')
  }

  return { status: 'completed', probe: probe as unknown as FitProbeResult }
}
