import http from 'bare-http1'
import https from 'bare-https'
import type { Readable } from 'bare-stream'
import type { AbortSignal } from 'bare-abort-controller'
import { extractHubSha256, isHuggingFaceHost, isSecureDownloadUrl } from '@/utils/url-security'
import { DownloadCancelledError, InsecureModelSourceError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

const MAX_REDIRECTS = 20
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

type IncomingMessage = http.IncomingMessage

export interface SafeFetchResponse {
  status: number
  statusText: string
  headers: Record<string, string | number>
  /** Terminal response body. Consume or destroy it to free the socket. */
  body: Readable
  /** URL of the final (non-redirect) response. */
  finalUrl: string
  redirected: boolean
  /**
   * SHA-256 captured from a Hugging Face hop's `X-Linked-Etag`, if the chain
   * passed through huggingface.co / hf.co and exposed a SHA-256-shaped hash.
   */
  hubSha256?: string | undefined
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Per-hop connection timeout. */
  timeoutMs?: number
  /**
   * Reject plaintext HTTP (non-loopback) and HTTPS→HTTP downgrade hops. Off by
   * default: a bring-your-own HTTP server on any domain, plaintext included, is
   * allowed. Callers turn this on for a strict, verified-only posture.
   */
  enforceSecureTransport?: boolean
  /**
   * Which hop hosts are trusted to publish the integrity hash we read from
   * `X-Linked-Etag`. Defaults to Hugging Face; overridable for tests.
   */
  captureHashFromHost?: (host: string) => boolean
}

function protocolFor(url: URL) {
  return url.protocol === 'https:' ? https : http
}

function assertSecureHop(url: URL, previous: URL | null): void {
  if (isSecureDownloadUrl(url)) return
  const reason = previous
    ? `${previous.protocol}//${previous.host} redirected to plaintext HTTP, which is only allowed for loopback`
    : 'plaintext HTTP is only allowed for loopback hosts'
  throw new InsecureModelSourceError(url.href, reason)
}

// Issue a single request and resolve with the raw response (redirects NOT
// followed). Aborts on `signal` and destroys the socket on timeout so a stalled
// connect can't leak.
function requestOnce(
  url: URL,
  method: 'GET' | 'HEAD',
  headers: Record<string, string>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const protocol = protocolFor(url)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        req.destroy()
      } catch {
        /* best effort */
      }
      reject(error)
    }
    const onAbort = () => fail(new DownloadCancelledError())

    const req = protocol.request(url, { method, headers }, (res) => {
      if (settled) {
        res.destroy()
        return
      }
      settled = true
      cleanup()
      resolve(res)
    })

    req.on('error', (error: Error) => fail(error))

    if (signal) {
      if (signal.aborted) {
        fail(new DownloadCancelledError())
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => fail(new Error(`HTTP connection timeout after ${timeoutMs}ms`)),
        timeoutMs
      )
    }

    req.end()
  })
}

/**
 * Fetch a model URL, walking redirects ourselves so every hop is checked:
 * plaintext HTTP (non-loopback) and HTTPS→HTTP downgrades are refused before a
 * request is issued to the insecure hop, and the Hugging Face Hub SHA-256 is
 * captured from the pre-redirect resolve response (bare-fetch's auto-follow
 * would discard it). The returned body is the terminal response stream.
 */
export async function safeFetch(
  input: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResponse> {
  const method = options.method ?? 'GET'
  const headers = { ...(options.headers ?? {}) }
  const { signal, timeoutMs } = options
  const enforceSecureTransport = options.enforceSecureTransport ?? false
  const captureHashFromHost = options.captureHashFromHost ?? isHuggingFaceHost

  let current: URL
  try {
    current = new URL(input)
  } catch (error) {
    throw new InsecureModelSourceError(input, 'invalid URL', error)
  }

  let previous: URL | null = null
  let hubSha256: string | undefined
  let redirects = 0

  for (;;) {
    if (signal?.aborted) throw new DownloadCancelledError()
    if (enforceSecureTransport) assertSecureHop(current, previous)

    const res = await requestOnce(current, method, headers, timeoutMs, signal)

    if (hubSha256 === undefined && captureHashFromHost(current.hostname)) {
      hubSha256 = extractHubSha256(res.headers)
    }

    const status = res.statusCode
    const location = res.headers['location']

    if (location !== undefined && REDIRECT_STATUSES.has(status)) {
      // Drain the redirect body so the socket can be reused/closed.
      res.resume()

      if (redirects >= MAX_REDIRECTS) {
        throw new InsecureModelSourceError(current.href, 'too many redirects')
      }
      redirects++

      let next: URL
      try {
        next = new URL(String(location), current)
      } catch (error) {
        throw new InsecureModelSourceError(current.href, 'invalid redirect location', error)
      }

      // Strip credentials when crossing origins.
      if (next.protocol !== current.protocol || next.host !== current.host) {
        delete headers['authorization']
        delete headers['Authorization']
        delete headers['cookie']
        delete headers['Cookie']
      }

      previous = current
      current = next
      continue
    }

    if (hubSha256 === undefined && captureHashFromHost(previous?.hostname ?? current.hostname)) {
      logger.debug('No Hub SHA-256 found in resolve headers', { url: current.href })
    }

    return {
      status,
      statusText: res.statusMessage,
      headers: res.headers,
      body: res,
      finalUrl: current.href,
      redirected: redirects > 0,
      hubSha256
    }
  }
}
