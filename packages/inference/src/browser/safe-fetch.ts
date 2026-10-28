// Browser replacement for handlers/load-model/safe-fetch.ts. fetch() follows
// redirects itself and hides the intermediate responses, so redirect hops are
// not individually checked, and the Hub SHA-256 that native safeFetch reads
// from the Hugging Face hop is never available: hubSha256 stays undefined
// rather than trusting whatever ETag the final (CDN) response exposes.
import { Readable } from 'bare-stream'
import { isSecureDownloadUrl } from '@/utils/url-security'
import { DownloadCancelledError, InsecureModelSourceError } from '@/errors/index'
import type { SafeFetchOptions, SafeFetchResponse } from '@/handlers/load-model/safe-fetch'
import {
  browser,
  type FetchResponse,
  type WebAbortController,
  type WebReadableStream
} from './globals'
import { readChunks } from './fs'

export type { SafeFetchOptions, SafeFetchResponse }

function assertSecure(url: URL, original: string): void {
  if (!isSecureDownloadUrl(url)) {
    throw new InsecureModelSourceError(
      original,
      'plaintext HTTP is only allowed for loopback hosts'
    )
  }
}

// Destroying the stream (the caller's stall watchdog, a cancel) aborts the
// fetch, which also ends a read that is waiting on a silent connection.
function bodyStream(body: WebReadableStream | null, controller: WebAbortController): Readable {
  const stream = Readable.from(body ? readChunks(body.getReader()) : [])
  stream.on('close', () => controller.abort())
  return stream
}

export async function safeFetch(
  input: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResponse> {
  const enforceSecureTransport = options.enforceSecureTransport ?? false

  let url: URL
  try {
    url = new URL(input)
  } catch (error) {
    throw new InsecureModelSourceError(input, 'invalid URL', error)
  }
  if (enforceSecureTransport) assertSecure(url, input)
  if (options.signal?.aborted) throw new DownloadCancelledError()

  const controller = new browser.AbortController()
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(onAbort, options.timeoutMs)

  let response: FetchResponse
  try {
    response = await browser.fetch(url.href, {
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      redirect: 'follow',
      signal: controller.signal as never
    })
  } catch (error) {
    if (options.signal?.aborted) throw new DownloadCancelledError()
    if (controller.signal.aborted) {
      throw new Error(`HTTP connection timeout after ${options.timeoutMs}ms`)
    }
    throw error
  } finally {
    // The connection timeout ends with the headers. The caller's signal keeps
    // aborting the request while the body streams.
    if (timer !== undefined) clearTimeout(timer)
  }

  const finalUrl = new URL(response.url || url.href)
  if (enforceSecureTransport) assertSecure(finalUrl, input)

  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: bodyStream(response.body, controller),
    finalUrl: finalUrl.href,
    redirected: response.redirected
  }
}
