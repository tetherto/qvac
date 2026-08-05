import https from 'node:https'
import type {
  PinnedHttpsRequest,
  PinnedHttpsResponse
} from './weather-transport-types.ts'
import {
  WeatherTransportResponseLimitError,
  weatherHostHeader,
  weatherTransportAbortError
} from './weather-transport-types.ts'

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
    const request = https.request(
      {
        protocol: 'https:',
        hostname: address.address,
        family: address.family,
        port,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        rejectUnauthorized: true,
        ...(ca ? { ca: Buffer.from(ca) } : {}),
        headers: {
          accept: 'text/plain',
          host: weatherHostHeader(url.hostname, port),
          'user-agent': 'qvac-harness-weather/1'
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer | string) => {
          if (settled) return
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.byteLength
          if (bytes > maxResponseBytes) {
            settled = true
            response.destroy()
            cleanup()
            reject(new WeatherTransportResponseLimitError(maxResponseBytes))
            return
          }
          chunks.push(buffer)
        })
        response.once('end', () => {
          if (settled) return
          settled = true
          cleanup()
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
      fail(error)
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    request.once('error', fail)
    signal.addEventListener('abort', onAbort, { once: true })
    request.end()
  })
}
