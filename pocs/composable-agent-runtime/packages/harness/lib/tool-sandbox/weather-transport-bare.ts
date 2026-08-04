import Buffer from 'bare-buffer'
import * as https from 'bare-https'
import type {
  PinnedHttpsRequest,
  PinnedHttpsResponse
} from './weather-transport-types.ts'
import {
  WeatherTransportResponseLimitError,
  weatherHostHeader,
  weatherTransportAbortError
} from './weather-transport-types.ts'

class PinnedHttpsAgent extends https.Agent {
  readonly address: string
  readonly family: 4 | 6
  readonly tlsHost: string
  readonly port: number
  readonly ca?: string | Uint8Array

  constructor(input: {
    readonly address: string
    readonly family: 4 | 6
    readonly tlsHost: string
    readonly port: number
    readonly ca?: string | Uint8Array
  }) {
    super()
    this.address = input.address
    this.family = input.family
    this.tlsHost = input.tlsHost
    this.port = input.port
    if (input.ca) this.ca = input.ca
  }

  createConnection(options: https.HTTPSSocketOptions = {}) {
    const createConnection = Reflect.get(
      https.Agent.prototype,
      'createConnection'
    )
    if (typeof createConnection !== 'function') {
      throw new Error('bare-https Agent.createConnection is unavailable')
    }
    const lookup = (
      _hostname: string,
      _options: object,
      callback: (
        error: Error | null,
        addresses: readonly { address: string; family: 4 | 6 }[]
      ) => void
    ) => {
      callback(null, [{
        address: this.address,
        family: this.family
      }])
    }
    return Reflect.apply(createConnection, this, [{
      ...options,
      host: this.tlsHost,
      port: this.port,
      lookup,
      rejectUnauthorized: true,
      ...(this.ca ? { ca: toBuffer(this.ca) } : {})
    }])
  }

  getName() {
    return `${this.tlsHost}:${this.port}/${this.address}/${this.family}`
  }
}

export function requestPinnedHttps({
  url,
  address,
  signal,
  maxResponseBytes,
  port = 443,
  ca
}: PinnedHttpsRequest): Promise<PinnedHttpsResponse> {
  if (signal.aborted) return Promise.reject(weatherTransportAbortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const agent = new PinnedHttpsAgent({
      address: address.address,
      family: address.family,
      tlsHost: url.hostname,
      port,
      ...(ca ? { ca } : {})
    })
    const request = https.request(
      {
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent,
        headers: {
          accept: 'text/plain',
          host: weatherHostHeader(url.hostname, port),
          'user-agent': 'qvac-harness-weather/1'
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: unknown) => {
          if (settled) return
          if (
            typeof chunk !== 'string' &&
            !(chunk instanceof Uint8Array)
          ) {
            response.destroy()
            fail(new Error('Weather transport returned invalid response bytes'))
            return
          }
          const buffer = toBuffer(chunk)
          bytes += buffer.byteLength
          if (bytes > maxResponseBytes) {
            settled = true
            response.destroy()
            cleanup()
            agent.destroy()
            reject(new WeatherTransportResponseLimitError(maxResponseBytes))
            return
          }
          chunks.push(buffer)
        })
        response.once('end', () => {
          if (settled) return
          settled = true
          cleanup()
          agent.destroy()
          resolve({
            status: response.statusCode ?? 502,
            headers: {
              location:
                typeof response.headers.location === 'string'
                  ? response.headers.location
                  : undefined
            },
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
        response.once('error', fail)
      }
    )
    const onAbort = () => {
      const error = weatherTransportAbortError()
      request.destroy(error)
      agent.destroy()
      fail(error)
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      agent.destroy()
      reject(error)
    }
    request.once('error', fail)
    signal.addEventListener('abort', onAbort, { once: true })
    request.end()
  })
}

function toBuffer(value: string | Uint8Array) {
  return typeof value === 'string'
    ? Buffer.from(value)
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}
