import type { HarnessAbortSignal } from '@qvac/harness/skill-sandbox'

export interface PinnedHttpsAddress {
  readonly address: string
  readonly family: 4 | 6
}

export interface PinnedHttpsRequest {
  readonly url: URL
  readonly address: PinnedHttpsAddress
  readonly signal: HarnessAbortSignal
  readonly maxResponseBytes: number
  readonly port?: number
  readonly ca?: string | Uint8Array
}

export interface PinnedHttpsResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
}

export class WeatherTransportResponseLimitError extends Error {
  constructor(limit: number) {
    super(`Weather response exceeded the ${limit}-byte response limit`)
    this.name = 'WeatherTransportResponseLimitError'
  }
}

export function weatherTransportAbortError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

export function weatherHostHeader(hostname: string, port: number) {
  return port === 443 ? hostname : `${hostname}:${port}`
}
