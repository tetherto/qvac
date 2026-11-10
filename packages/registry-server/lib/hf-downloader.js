'use strict'

const fs = require('fs')
const { Readable } = require('stream')
const { ReadableStream } = require('stream/web')
const { pipeline } = require('stream/promises')
const { Agent, fetch, Request } = require('undici')

const MAX_ATTEMPTS = 3
const BACKOFF_MS = 3000
const PROGRESS_INTERVAL_MS = 30000
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT'
])

function isTransientHfDownloadError(err) {
  if (!err) return false
  if (typeof err.statusCode === 'number') {
    return err.statusCode === 429 || err.statusCode >= 500
  }
  if (TRANSIENT_CODES.has(err.code || err.cause?.code)) return true
  const message = `${err.message || ''} ${err.cause?.message || ''}`.toLowerCase()
  return message.includes('terminated') || message.includes('socket hang up')
}

async function downloadHuggingFace({ url, localPath, accessToken, logger }) {
  // Keep sockets local to this ingest; a parked connection from an earlier
  // download can have been silently closed by the CDN.
  const dispatcher = new Agent({
    keepAliveTimeout: 30000,
    keepAliveMaxTimeout: 30000,
    connect: { timeout: 30000 }
  })
  const incomplete = `${localPath}.incomplete`
  let validator = null
  let expectedBytes = null
  let bytesDownloaded = 0

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const startedAt = Date.now()
      let lastProgressAt = startedAt
      let response
      const progress = () => ({
        attempt,
        bytesDownloaded,
        expectedBytes,
        elapsedMs: Date.now() - startedAt,
        lastProgressAgeMs: Date.now() - lastProgressAt
      })
      let timer

      try {
        logger.info({ url, ...progress() }, 'Downloading from HuggingFace')
        timer = setInterval(() => {
          logger.info(progress(), 'HuggingFace download progress')
        }, PROGRESS_INTERVAL_MS)
        timer.unref()

        // An ETag is required to avoid joining bytes from different revisions.
        const offset = validator && bytesDownloaded < expectedBytes ? bytesDownloaded : 0
        const headers = { 'Accept-Encoding': 'identity' }
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`
        if (offset > 0) {
          headers.Range = `bytes=${offset}-`
          headers['If-Range'] = validator
        }
        // Invalid URLs or headers are programming errors, not failed I/O.
        const request = new Request(url, { headers })
        try {
          response = await fetch(request, { dispatcher })
        } catch (err) {
          throw downloadFailure(err)
        }
        if (!response.ok) {
          const err = new Error(`HuggingFace download returned HTTP ${response.status}`)
          err.statusCode = response.status
          throw err
        }
        const encoding = response.headers.get('content-encoding')
        if (encoding && encoding !== 'identity') {
          throw new Error(
            'HuggingFace download returned an encoded body; cannot validate byte ranges'
          )
        }

        const length = parseSize(response.headers.get('content-length'))
        if (response.status === 206 && offset > 0) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            response.headers.get('content-range') || ''
          )
          if (
            !range ||
            Number(range[1]) !== offset ||
            Number(range[2]) !== expectedBytes - 1 ||
            Number(range[3]) !== expectedBytes ||
            (length !== null && length !== expectedBytes - offset)
          ) {
            throw new Error('HuggingFace download returned an invalid resume range')
          }
          if (response.headers.get('etag') !== validator) {
            throw new Error('HuggingFace download returned a changed resume validator')
          }
        } else if (response.status === 200) {
          // If-Range returns 200 when the representation changed or Range is
          // unsupported. Replace the partial file rather than appending it.
          bytesDownloaded = 0
          expectedBytes = length
          const etag = response.headers.get('etag')
          validator = etag && /^"[^\"]*"$/.test(etag) ? etag : null
        } else {
          throw new Error(
            `HuggingFace download returned an unexpected range status ${response.status}`
          )
        }

        await pipeline(
          Readable.fromWeb(responseBodyStream(response.body)),
          async function* trackProgress(source) {
            for await (const chunk of source) {
              bytesDownloaded += chunk.length
              lastProgressAt = Date.now()
              if (expectedBytes !== null && bytesDownloaded > expectedBytes) {
                throw new Error('HuggingFace download exceeded its expected size')
              }
              yield chunk
            }
          },
          fs.createWriteStream(incomplete, { flags: response.status === 206 ? 'a' : 'w' })
        )
        if (expectedBytes !== null && bytesDownloaded !== expectedBytes) {
          const err = new Error('HuggingFace download ended before its expected size')
          err.code = 'ECONNRESET'
          throw err
        }
        await fs.promises.rename(incomplete, localPath)
        logger.info(progress(), 'HuggingFace download completed')
        return localPath
      } catch (err) {
        const partial = await fs.promises.stat(incomplete).catch((statErr) => {
          if (statErr.code !== 'ENOENT') throw statErr
          return null
        })
        bytesDownloaded = partial?.size || 0
        const transient = isTransientHfDownloadError(err)
        const code = err.code || err.cause?.code
        const cause = err.cause?.cause || err.cause
        logger.warn(
          {
            url,
            ...progress(),
            maxAttempts: MAX_ATTEMPTS,
            transient,
            code,
            statusCode: err.statusCode,
            error: err.message,
            cause: cause?.message,
            socketBytesRead: cause?.socket?.bytesRead,
            socketBytesWritten: cause?.socket?.bytesWritten
          },
          'HuggingFace download attempt failed'
        )

        if (!transient || attempt === MAX_ATTEMPTS) {
          throw err
        }
      } finally {
        clearInterval(timer)
        await response?.body?.cancel().catch(() => {})
      }
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * attempt))
    }
  } finally {
    await dispatcher.destroy()
  }
}

function downloadFailure(cause) {
  // RPC treats TypeError as fatal, including Undici's operational failures.
  const failure = new Error('HuggingFace download failed', { cause })
  failure.code = cause.code || cause.cause?.code
  return failure
}

function responseBodyStream(body) {
  const reader = body.getReader()
  return new ReadableStream({
    async pull(controller) {
      let chunk
      try {
        chunk = await reader.read()
      } catch (err) {
        reader.releaseLock()
        controller.error(downloadFailure(err))
        return
      }
      if (chunk.done) {
        reader.releaseLock()
        controller.close()
      } else {
        controller.enqueue(chunk.value)
      }
    },
    cancel(reason) {
      return reader.cancel(reason).finally(() => reader.releaseLock())
    }
  })
}

function parseSize(value) {
  if (value === null) return null
  const size = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(size)) {
    throw new Error('HuggingFace download returned an invalid content length')
  }
  return size
}

module.exports = { downloadHuggingFace, isTransientHfDownloadError }
