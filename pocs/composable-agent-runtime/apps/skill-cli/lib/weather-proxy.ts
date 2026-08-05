import crypto from '#crypto'
import dns from '#dns-promises'
import http from '#http'
import Buffer from '#buffer'
import AbortController from '#abort-controller'
import type { HarnessJsonValue } from '@qvac/harness/skill-sandbox'
import {
  requestPinnedHttps,
  WeatherTransportResponseLimitError
} from './weather-transport.ts'

const WEATHER_HOST = 'wttr.in'
const DEFAULT_TIMEOUT_MS = 10_000
export const WEATHER_DEFAULT_MAX_RESPONSE_BYTES = 8_192
export const WEATHER_MAX_RESPONSE_BYTES_LIMIT = 65_536
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_TOKEN_AGENT = 'test-agent'
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface WeatherFetchResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
}

export interface WeatherResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export type WeatherFetch = (
  url: URL,
  signal: AbortSignal,
  maxResponseBytes: number,
  address: WeatherResolvedAddress
) => Promise<WeatherFetchResponse>

export type WeatherResolve = (
  hostname: string
) => Promise<readonly WeatherResolvedAddress[]>

export interface CreateWeatherProxyOptions {
  readonly token?: string
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxRedirects?: number
  readonly fetch?: WeatherFetch
  readonly resolve?: WeatherResolve
}

export interface WeatherProxy {
  readonly port: number
  readonly token: string
  readonly maxResponseBytes: number
  tokenForAgent(agentId: string): string
  close(): Promise<void>
}

export function validateWeatherRequest(
  input: Readonly<Record<string, HarnessJsonValue>>
):
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string } {
  const supported = new Set(['url', 'method'])
  const extra = Object.keys(input).find((key) => !supported.has(key))
  if (extra) {
    return {
      ok: false,
      error: `unsupported Weather input: ${extra}`
    }
  }
  if (typeof input.url !== 'string') {
    return { ok: false, error: 'Weather url must be a string' }
  }
  if (input.method !== undefined && input.method !== 'GET') {
    return { ok: false, error: 'Weather supports only GET' }
  }
  return validateWeatherUrl(input.url)
}

export async function createWeatherProxy({
  token = crypto.randomBytes(32).toString('base64url'),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = WEATHER_DEFAULT_MAX_RESPONSE_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  fetch = fetchWeather,
  resolve = resolveWeatherHost
}: CreateWeatherProxyOptions = {}): Promise<WeatherProxy> {
  validatePositiveInteger(timeoutMs, 'Weather timeout')
  validatePositiveInteger(maxResponseBytes, 'Weather response limit')
  if (maxResponseBytes > WEATHER_MAX_RESPONSE_BYTES_LIMIT) {
    throw new Error(
      `Weather response limit must not exceed ${WEATHER_MAX_RESPONSE_BYTES_LIMIT}`
    )
  }
  validateNonNegativeInteger(maxRedirects, 'Weather redirect limit')
  if (!token) throw new Error('Weather proxy token must not be empty')

  const active = new Set<AbortController>()
  const agentTokens = new Map<string, string>()
  const issuedTokens = new Map([[token, DEFAULT_TOKEN_AGENT]])
  agentTokens.set(DEFAULT_TOKEN_AGENT, token)
  let closed = false
  const server = http.createServer(async (request, response) => {
    if (closed) {
      sendJson(response, 503, { error: 'Weather proxy is closed' })
      return
    }
    const authorizedAgent = authenticateAgent(
      request.headers.authorization,
      issuedTokens
    )
    if (!authorizedAgent) {
      sendJson(response, 401, { error: 'Weather proxy authentication failed' })
      return
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Weather proxy accepts only GET' })
      return
    }
    if (request.headers['content-length'] || request.headers['transfer-encoding']) {
      sendJson(response, 400, { error: 'Weather proxy does not accept a body' })
      return
    }

    let target: string | null
    let routeAgent: string | null
    try {
      const rawRequestUrl = request.url ?? '/'
      const prefix = '/agents/'
      const marker = '/request?url='
      const markerIndex = rawRequestUrl.indexOf(marker, prefix.length)
      if (
        !rawRequestUrl.startsWith(prefix) ||
        markerIndex < prefix.length ||
        rawRequestUrl.slice(markerIndex + marker.length).includes('&') ||
        rawRequestUrl.includes('#')
      ) {
        sendJson(response, 404, { error: 'Weather proxy route not found' })
        return
      }
      routeAgent =
        decodeURIComponent(
          rawRequestUrl.slice(prefix.length, markerIndex)
        ) || null
      target =
        decodeURIComponent(
          rawRequestUrl.slice(markerIndex + marker.length)
        ) || null
    } catch {
      routeAgent = null
      target = null
    }
    if (!routeAgent || routeAgent !== authorizedAgent) {
      sendJson(response, 401, { error: 'Weather proxy authentication failed' })
      return
    }
    if (!target) {
      sendJson(response, 400, { error: 'Weather proxy requires one url' })
      return
    }

    const controller = new AbortController()
    active.add(controller)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort('Weather request timed out')
    }, timeoutMs)
    const onClientAbort = () => controller.abort('Weather caller disconnected')
    request.once('aborted', onClientAbort)
    response.once('close', () => {
      if (!response.writableEnded) onClientAbort()
    })

    try {
      const result = await fetchWithRedirects({
        target,
        signal: controller.signal,
        fetch,
        resolve,
        maxRedirects,
        maxResponseBytes
      })
      sendJson(response, 200, result)
    } catch (error) {
      if (timedOut) {
        sendJson(response, 504, { error: 'Weather request timed out' })
      } else if (isResponseLimitError(error)) {
        sendJson(response, 413, { error: error.message })
      } else if (controller.signal.aborted) {
        if (!response.headersSent) {
          sendJson(response, 499, { error: 'Weather request cancelled' })
        }
      } else {
        sendJson(response, 400, {
          error: humanError(error, 'Weather request failed')
        })
      }
    } finally {
      clearTimeout(timer)
      active.delete(controller)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Weather proxy did not bind an IP loopback socket')
  }

  return {
    port: address.port,
    token,
    maxResponseBytes,
    tokenForAgent(agentId) {
      if (!agentId) throw new Error('Weather agent id must not be empty')
      const existing = agentTokens.get(agentId)
      if (existing) return existing
      const issued = crypto.randomBytes(32).toString('base64url')
      agentTokens.set(agentId, issued)
      issuedTokens.set(issued, agentId)
      return issued
    },
    async close() {
      if (closed) return
      closed = true
      for (const controller of active) {
        controller.abort('Weather proxy closed')
      }
      agentTokens.clear()
      issuedTokens.clear()
      const closing = closeServer(server)
      server.closeAllConnections?.()
      await closing
    }
  }
}

function validateWeatherUrl(
  raw: string
):
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'Weather URL is invalid' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Weather requires HTTPS' }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Weather URL must not contain credentials' }
  }
  if (url.hostname !== WEATHER_HOST) {
    return { ok: false, error: `Weather hostname must be exactly ${WEATHER_HOST}` }
  }
  if (url.port) {
    return { ok: false, error: 'Weather URL must use the default HTTPS port 443' }
  }
  if (url.hash) {
    return { ok: false, error: 'Weather URL must not contain a fragment' }
  }
  return { ok: true, url: url.href }
}

async function fetchWithRedirects({
  target,
  signal,
  fetch,
  resolve,
  maxRedirects,
  maxResponseBytes
}: {
  readonly target: string
  readonly signal: AbortSignal
  readonly fetch: WeatherFetch
  readonly resolve: WeatherResolve
  readonly maxRedirects: number
  readonly maxResponseBytes: number
}) {
  let validated = validateWeatherUrl(target)
  if (!validated.ok) throw new Error(validated.error)
  let current = new URL(validated.url)

  for (let redirects = 0; ; redirects++) {
    const address = await resolvePublicAddress(current.hostname, resolve)
    const response = await fetch(
      current,
      signal,
      maxResponseBytes,
      address
    )
    if (!REDIRECT_STATUSES.has(response.status)) {
      assertBodyLimit(response.body, maxResponseBytes)
      return { status: response.status, body: response.body }
    }
    const location = response.headers.location
    if (!location) {
      return { status: response.status, body: '' }
    }
    if (redirects >= maxRedirects) throw new Error('Weather request has too many redirects')
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      throw new Error('Weather redirect URL is invalid')
    }
    validated = validateWeatherUrl(next.href)
    if (!validated.ok) throw new Error(validated.error)
    current = new URL(validated.url)
  }
}

function fetchWeather(
  url: URL,
  signal: AbortSignal,
  maxResponseBytes: number,
  address: WeatherResolvedAddress
) {
  return requestPinnedHttps({
    url,
    address,
    signal,
    maxResponseBytes
  })
}

async function resolveWeatherHost(
  hostname: string
): Promise<readonly WeatherResolvedAddress[]> {
  return dns.lookup(hostname)
}

async function resolvePublicAddress(
  hostname: string,
  resolve: WeatherResolve
): Promise<WeatherResolvedAddress> {
  const addresses = await resolve(hostname)
  if (addresses.length === 0) {
    throw new Error(`Weather hostname ${hostname} resolved to no addresses`)
  }
  if (addresses.some((address) => !isPublicAddress(address))) {
    throw new Error(
      `Weather hostname ${hostname} must resolve only to public addresses`
    )
  }
  const ordered = [...addresses].sort((left, right) => {
    if (left.family !== right.family) return left.family === 4 ? -1 : 1
    return left.address < right.address
      ? -1
      : left.address > right.address
        ? 1
        : 0
  })
  const first = ordered[0]
  if (!first) throw new Error('Weather resolver returned no usable address')
  return first
}

function isPublicAddress({ address, family }: WeatherResolvedAddress) {
  return family === 4 ? isPublicIpv4(address) : isPublicIpv6(address)
}

function isPublicIpv4(address: string) {
  const octets = address.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255
    )
  ) {
    return false
  }
  const [a = 0, b = 0] = octets
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0) return false
  if (a === 192 && b === 88) return false
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false
  if (a === 203 && b === 0) return false
  return true
}

function isPublicIpv6(address: string) {
  const words = parseIpv6(address)
  if (!words) return false
  const [first = 0, second = 0] = words
  if (first < 0x2000 || first > 0x3fff) return false
  if (first === 0x2001 && second === 0x0000) return false
  if (first === 0x2001 && second === 0x0002) return false
  if (first === 0x2001 && second >= 0x0010 && second <= 0x002f) return false
  if (first === 0x2001 && second === 0x0db8) return false
  if (first === 0x2002 || first === 0x3ffe) return false
  return true
}

function parseIpv6(address: string) {
  if (address.includes('%') || address.includes('.')) return undefined
  const halves = address.split('::')
  if (halves.length > 2) return undefined
  const left = parseIpv6Words(halves[0] ?? '')
  const right = parseIpv6Words(halves[1] ?? '')
  if (!left || !right) return undefined
  if (halves.length === 1) return left.length === 8 ? left : undefined
  const missing = 8 - left.length - right.length
  if (missing < 1) return undefined
  return [...left, ...new Array<number>(missing).fill(0), ...right]
}

function parseIpv6Words(value: string) {
  if (!value) return []
  const words = value.split(':').map((word) => Number.parseInt(word, 16))
  if (
    words.some(
      (word, index) =>
        !/^[0-9a-f]{1,4}$/i.test(value.split(':')[index] ?? '') ||
        !Number.isInteger(word) ||
        word < 0 ||
        word > 0xffff
    )
  ) {
    return undefined
  }
  return words
}

function assertBodyLimit(body: string, maxResponseBytes: number) {
  if (Buffer.byteLength(body, 'utf8') > maxResponseBytes) {
    throw new WeatherTransportResponseLimitError(maxResponseBytes)
  }
}

function authenticateAgent(
  header: string | undefined,
  tokens: ReadonlyMap<string, string>
) {
  if (!header?.startsWith('Bearer ')) return undefined
  const provided = Buffer.from(header.slice('Bearer '.length))
  for (const [token, agentId] of tokens) {
    const expected = Buffer.from(token)
    if (
      provided.byteLength === expected.byteLength &&
      crypto.timingSafeEqual(provided, expected)
    ) {
      return agentId
    }
  }
  return undefined
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  value: Readonly<Record<string, HarnessJsonValue>>
) {
  if (response.headersSent || response.destroyed) return
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    connection: 'close'
  })
  response.end(body)
}

function closeServer(server: http.Server) {
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function validatePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}

function validateNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
}

function humanError(error: unknown, fallback: string) {
  return error instanceof Error && error.message
    ? error.message
    : fallback
}

function isResponseLimitError(
  error: unknown
): error is WeatherTransportResponseLimitError {
  return error instanceof WeatherTransportResponseLimitError
}
