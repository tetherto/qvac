import type { ModelProgressUpdate, ShardUrl } from '@/schemas/index'
import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { Readable, type Writable } from 'bare-stream'
import { AbortController, type AbortSignal } from 'bare-abort-controller'
import Buffer from 'bare-buffer'
import {
  getModelsCacheDir,
  getShardedModelCacheDir,
  generateShortHash,
  detectShardedModel,
  parsePatternBasedShardUrl,
  extractTensorsFromShards,
  calculatePercentage,
  isArchiveUrl,
  sanitizePathComponent,
  extractAndValidateShardedArchive,
  validateShardedModelCache,
  checkAllShardsExist,
  generateShardFilenames,
  hasValidGGUFHeader
} from '@/utils/index'
import { safeFetch } from '@/handlers/load-model/safe-fetch'
import {
  shouldEnforceSecureTransport,
  verifyHttpModelFile
} from '@/handlers/load-model/http-verify'
import { getConfig } from '@/runtime/state'
import { getLifecycleState, onResume } from '@/runtime/runtime-lifecycle'
import {
  createHttpDownloadKey,
  startOrJoinDownload,
  applyJoinedDownloadStats
} from '@/handlers/load-model/download-manager'
import {
  ChecksumUnavailableError,
  ChecksumValidationFailedError,
  DownloadCancelledError,
  HTTPError,
  InsecureModelSourceError,
  NoResponseBodyError,
  PartialDownloadOfflineError,
  ResponseBodyNotReadableError
} from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import type { DownloadHooks, DownloadSecurityOptions } from '@/handlers/load-model/types'

const logger = getEngineLogger()

const DEFAULT_CONCURRENCY = 3

// Resolve the effective download-security flags: a per-call override wins,
// otherwise the engine config, otherwise off.
function resolveDownloadSecurity(security?: DownloadSecurityOptions) {
  const config = getConfig()
  return {
    requireChecksum: security?.requireHttpChecksum ?? config.requireHttpChecksum ?? false,
    requireSecureTransport:
      security?.requireSecureTransport ?? config.requireSecureTransport ?? false
  }
}

interface ShardDownloadState {
  index: number
  shard: ShardUrl
  shardPath: string
  expectedSize: number
  downloadedBytes: number
  isComplete: boolean
}

const DEFAULT_HTTP_CONNECTION_TIMEOUT_MS = 10_000
// If no bytes arrive for this long mid-stream, treat the transfer as stalled
// (dead socket after a suspend or network drop that didn't surface an error)
// and abort so the caller can resume from the partial via a Range request.
const HTTP_STREAM_STALL_TIMEOUT_MS = 10_000

function extractFilenameFromUrl(url: string): string {
  // Parse URL to get the filename from the path
  const urlParts = url.split('/')
  const filename = urlParts[urlParts.length - 1] || 'model.gguf'

  // Remove query parameters if present
  const cleanFilename = filename.split('?')[0] || 'model.gguf'

  // Sanitize to prevent path traversal via crafted URLs
  return sanitizePathComponent(cleanFilename)
}

// A cache hit is served after a freshness check only — size against the server,
// or a GGUF-header check when offline — and is not re-hashed (that would cost a
// full-file SHA-256 on every load). Verification happens at download time, so a
// cache entry from before this shipped, or one written down the warn-and-proceed
// path, is served as-is: tightening requireHttpChecksum does not retroactively
// verify the cache — clear it to force a fresh, verified download.
async function validateCachedFile(
  modelPath: string,
  url: string,
  requireSecureTransport: boolean,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    await fsPromises.access(modelPath)

    const localStats = await fsPromises.stat(modelPath)
    const localSize = localStats.size

    const config = getConfig()
    const connectionTimeout = config.httpConnectionTimeoutMs ?? DEFAULT_HTTP_CONNECTION_TIMEOUT_MS
    let expectedSize = 0
    try {
      const response = await safeFetch(url, {
        method: 'HEAD',
        timeoutMs: connectionTimeout,
        enforceSecureTransport: shouldEnforceSecureTransport(url, requireSecureTransport),
        ...(signal && { signal })
      })
      response.body.resume()
      expectedSize = parseInt(String(response.headers['content-length'] ?? '0') || '0')
    } catch (headError) {
      // A refused insecure Hugging Face hop is terminal, not an offline fallback.
      if (headError instanceof InsecureModelSourceError) throw headError
      logger.warn(
        `⚠️ HEAD request failed: ${headError instanceof Error ? headError.message : String(headError)}`
      )
      logger.info(`📴 Falling back to GGUF header validation...`)

      const hasValidHeader = await hasValidGGUFHeader(modelPath)
      if (hasValidHeader) {
        logger.info(`✅ Offline - GGUF header valid, using cached file: ${modelPath}`)
        return modelPath
      }

      if (localSize > 0) {
        logger.error(
          `❌ Offline with partial download (${localSize} bytes). Cannot resume without network.`
        )
        throw new PartialDownloadOfflineError(url, localSize)
      }

      logger.warn(`⚠️ Offline and GGUF validation failed - file may be incomplete`)
      return null
    }

    if (localSize !== expectedSize) {
      logger.info(
        `📥 Cached file size mismatch. Expected: ${expectedSize}, Found: ${localSize}. Re-downloading...`
      )
      return null
    }

    logger.info(`✅ Using cached HTTP model: ${modelPath}`)
    return modelPath
  } catch (error) {
    // A refused insecure hop and an offline partial are terminal; everything
    // else (missing file, access error) just means "no usable cache" → re-download.
    if (error instanceof PartialDownloadOfflineError || error instanceof InsecureModelSourceError) {
      throw error
    }
    return null
  }
}

interface HttpDownloadMeta {
  hubSha256?: string | undefined
}

async function performHttpDownload(
  url: string,
  modelPath: string,
  downloadKey: string,
  requireSecureTransport: boolean,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  signal?: AbortSignal
): Promise<HttpDownloadMeta> {
  if (signal?.aborted) {
    throw new DownloadCancelledError()
  }

  logger.info(`📥 Downloading model from HTTP: ${url}`)

  // Check if file exists for resuming
  let startOffset = 0
  let downloadedBytes = 0

  try {
    const existingStats = await fsPromises.stat(modelPath)
    startOffset = existingStats.size
    downloadedBytes = startOffset
    logger.info(`📥 Resuming download from byte ${startOffset}`)
  } catch {
    logger.info(`📥 Starting fresh download`)
  }

  // Prepare headers for resume if needed. Request identity encoding: the raw
  // client streams bytes straight to disk with no Content-Encoding decode, and
  // Range resume assumes unencoded bytes.
  const headers: Record<string, string> = { 'User-Agent': 'qvac', 'Accept-Encoding': 'identity' }

  if (startOffset > 0) {
    headers['Range'] = `bytes=${startOffset}-`
  }

  const config = getConfig()
  const connectionTimeout = config.httpConnectionTimeoutMs ?? DEFAULT_HTTP_CONNECTION_TIMEOUT_MS

  const enforceSecureTransport = shouldEnforceSecureTransport(url, requireSecureTransport)

  let response
  try {
    response = await safeFetch(url, {
      method: 'GET',
      headers,
      timeoutMs: connectionTimeout,
      enforceSecureTransport,
      ...(signal && { signal })
    })
  } catch (error) {
    // A refused insecure hop or a real cancel is terminal; everything else is a
    // connection/network failure the caller can resume from.
    if (signal?.aborted || error instanceof DownloadCancelledError) {
      throw error instanceof DownloadCancelledError ? error : new DownloadCancelledError()
    }
    if (error instanceof InsecureModelSourceError) {
      throw error
    }
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error(`❌ Connection failed: ${errorMsg}. URL: ${url}`)
    throw new HTTPError(0, `Connection failed: ${errorMsg}`, error)
  }

  const meta: HttpDownloadMeta = { hubSha256: response.hubSha256 }
  const isOk = response.status >= 200 && response.status <= 299

  if (!isOk) {
    // 416 Range Not Satisfiable — the partial on disk is already the whole file.
    if (response.status === 416 && startOffset > 0) {
      response.body.destroy()
      logger.info(`✅ File already completely downloaded`)
      // Send 100% progress for already complete file
      if (progressCallback) {
        progressCallback({
          type: 'modelProgress',
          downloaded: startOffset,
          total: startOffset,
          percentage: 100,
          downloadKey
        })
      }
      return meta
    }

    response.body.destroy()
    throw new HTTPError(response.status, response.statusText)
  }

  // A resume sent a Range header but the server ignored it and returned the
  // whole file (200 instead of 206). The write stream truncates in that case
  // (append is keyed on 206 below), so reset the byte counter to 0 or progress
  // would be measured from the discarded partial's size.
  if (startOffset > 0 && response.status !== 206) {
    logger.warn(`⚠️ Server doesn't support resume, starting fresh download`)
    startOffset = 0
    downloadedBytes = 0
  }

  // Get total size from headers
  let totalBytes = 0
  const contentLength =
    response.headers['content-length'] === undefined
      ? null
      : String(response.headers['content-length'])

  if (response.status === 206) {
    // For resumed downloads, parse Content-Range header
    const contentRange =
      response.headers['content-range'] === undefined
        ? null
        : String(response.headers['content-range'])
    if (contentRange) {
      const match = contentRange.match(/bytes \d+-\d+\/(\d+)/)
      if (match && match[1]) {
        totalBytes = parseInt(match[1])
      }
    }
  } else {
    // For fresh downloads
    totalBytes = contentLength ? parseInt(contentLength) : 0
  }

  logger.info(`📏 Total size: ${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`)

  // Create write stream (append if resuming)
  const writeStreamOptions =
    startOffset > 0 && response.status === 206 ? { flags: 'a' as const } : {}
  const writeStream = fs.createWriteStream(modelPath, writeStreamOptions)

  // Get the response body
  const body = response.body

  if (!body) {
    throw new NoResponseBodyError()
  }

  try {
    // Check if body has pipe method (it's a Node/Bare stream)
    const isReadable =
      body instanceof Readable ||
      (typeof (body as unknown as Readable).pipe === 'function' &&
        typeof (body as unknown as Readable).on === 'function')

    if (isReadable) {
      // Wait for download to complete
      await new Promise((resolve, reject) => {
        let stallTimer: ReturnType<typeof setTimeout> | undefined
        const clearStall = () => {
          if (stallTimer) {
            clearTimeout(stallTimer)
            stallTimer = undefined
          }
        }
        // Reset on every chunk; if it ever fires, the socket went quiet
        // mid-stream (suspend/drop) — abort so the caller resumes via Range.
        const armStall = () => {
          clearStall()
          stallTimer = setTimeout(() => {
            ;(body as Readable).destroy()
            writeStream.destroy()
            reject(new Error(`HTTP stream stalled: no data for ${HTTP_STREAM_STALL_TIMEOUT_MS}ms`))
          }, HTTP_STREAM_STALL_TIMEOUT_MS)
        }

        const abortHandler = () => {
          clearStall()
          ;(body as Readable).destroy()
          writeStream.destroy()
          reject(new DownloadCancelledError())
        }

        if (signal) {
          if (signal.aborted) {
            abortHandler()
            return
          }
          signal.addEventListener('abort', abortHandler)
        }

        // Track progress + keep the stall watchdog fed
        ;(body as Readable).on('data', (chunk) => {
          armStall()
          downloadedBytes += (chunk as Buffer).length
          if (progressCallback) {
            progressCallback({
              type: 'modelProgress',
              downloaded: downloadedBytes,
              total: totalBytes,
              percentage: calculatePercentage(downloadedBytes, totalBytes),
              downloadKey
            })
          }
        })

        // Pipe directly to file
        ;(body as Readable).pipe(writeStream as unknown as Writable)
        armStall()

        writeStream.on('finish', () => {
          clearStall()
          logger.info(`✅ Model downloaded successfully to ${modelPath}`)
          if (signal) {
            signal.removeEventListener('abort', abortHandler)
          }
          resolve(undefined)
        })
        writeStream.on('error', (error) => {
          clearStall()
          reject(error)
        })
        ;(body as Readable).on('error', (error) => {
          clearStall()
          reject(error)
        })
      })
    } else {
      throw new ResponseBodyNotReadableError()
    }
  } catch (error) {
    writeStream.destroy()
    logger.error('Error during download:', error instanceof Error ? error.message : String(error))
    throw error instanceof Error ? error : new Error(String(error))
  }

  return meta
}

const DEFAULT_HTTP_DOWNLOAD_MAX_RETRIES = 5
const HTTP_RETRY_BASE_DELAY_MS = 500
const LIFECYCLE_WAIT_POLL_MS = 200
const LIFECYCLE_WAIT_MAX_MS = 5 * 60_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A mid-stream socket/body error, a connection failure (HTTP status 0, no
 * response), or our own resume-triggered abort is recoverable by resuming from
 * the partial. A real HTTP status (4xx/5xx) or a missing/unreadable body is not.
 *
 * `DownloadCancelledError` is intentionally NOT excluded here: this is only
 * reached after the caller's consumer-cancel gate, so a cancellation at this
 * point is our per-attempt abort (resume interrupt), which must be retried.
 */
export function isResumableTransferError(error: unknown): boolean {
  if (
    error instanceof NoResponseBodyError ||
    error instanceof ResponseBodyNotReadableError ||
    error instanceof PartialDownloadOfflineError ||
    error instanceof InsecureModelSourceError ||
    // Integrity failures are terminal — resuming would range-append onto bad
    // bytes. Verification runs after the retry loop today, so these are belt-and-
    // suspenders, but they keep the guarantee if verification ever moves inline.
    error instanceof ChecksumValidationFailedError ||
    error instanceof ChecksumUnavailableError
  ) {
    return false
  }
  if (error instanceof HTTPError) return error.httpStatus === 0
  return error instanceof Error
}

/**
 * Block until the runtime is active again before retrying. After a suspend the
 * socket is dead and the process can't service the transfer; resuming the fetch
 * only makes sense once `resume()` has run. Bounded and abort-aware.
 */
async function waitForLifecycleActive(signal?: AbortSignal): Promise<void> {
  if (getLifecycleState() === 'active') return
  const start = Date.now()
  while (getLifecycleState() !== 'active') {
    if (signal?.aborted) throw new DownloadCancelledError()
    if (Date.now() - start > LIFECYCLE_WAIT_MAX_MS) return
    await sleep(LIFECYCLE_WAIT_POLL_MS)
  }
}

/**
 * Run `performHttpDownload` with bounded retry. On a recoverable interruption
 * (mid-stream socket drop, or a dead socket after suspend/network loss) it
 * waits for the runtime to be active and re-issues the request, which resumes
 * from the on-disk partial via a Range header. No consumer-side babysitting.
 *
 * Each attempt runs on its own AbortController that is aborted either by the
 * consumer `signal` (a real cancel — terminal) or by `resume()` (a proactive
 * recovery — the in-flight socket is dead after a background, so abort and
 * range-resume immediately instead of waiting for the stall watchdog).
 */
async function performHttpDownloadWithResume(
  url: string,
  modelPath: string,
  downloadKey: string,
  requireSecureTransport: boolean,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  signal?: AbortSignal
): Promise<HttpDownloadMeta> {
  const maxRetries = DEFAULT_HTTP_DOWNLOAD_MAX_RETRIES

  let attempt = 0
  for (;;) {
    const attemptController = new AbortController()
    const forwardCancel = () => attemptController.abort(undefined)
    if (signal) {
      if (signal.aborted) attemptController.abort(undefined)
      else signal.addEventListener('abort', forwardCancel, { once: true })
    }
    // resume() → abort this attempt so it range-resumes now, not after the stall.
    const offResume = onResume(() => attemptController.abort(undefined))

    try {
      return await performHttpDownload(
        url,
        modelPath,
        downloadKey,
        requireSecureTransport,
        progressCallback,
        attemptController.signal
      )
    } catch (error) {
      // A real consumer cancel is terminal; anything else (resume abort, stall,
      // network error) is recoverable from the partial.
      if (signal?.aborted) {
        throw error instanceof DownloadCancelledError ? error : new DownloadCancelledError()
      }
      attempt++
      if (attempt > maxRetries || !isResumableTransferError(error)) throw error

      logger.warn(
        `⚠️ HTTP download interrupted (attempt ${attempt}/${maxRetries}), resuming from partial: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      await waitForLifecycleActive(signal)
      await sleep(HTTP_RETRY_BASE_DELAY_MS * attempt)
    } finally {
      if (signal) signal.removeEventListener('abort', forwardCancel)
      offResume()
    }
  }
}

export async function downloadModelFromHttp(
  url: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  hooks?: DownloadHooks,
  security?: DownloadSecurityOptions
) {
  const filename = extractFilenameFromUrl(url)

  if (isArchiveUrl(url)) {
    return downloadShardedModelFromArchive(url, progressCallback, hooks, security)
  }

  const shardInfo = detectShardedModel(filename)

  if (shardInfo.isSharded && shardInfo.totalShards) {
    return downloadShardedModelFromHttp(url, progressCallback, hooks, security)
  }

  const downloadKey = createHttpDownloadKey(url)
  hooks?.onDownloadKey?.(downloadKey)
  const cacheDir = getModelsCacheDir()
  const sourceHash = generateShortHash(url)
  const modelPath = `${cacheDir}/${sourceHash}_${filename}`
  const { requireChecksum, requireSecureTransport } = resolveDownloadSecurity(security)

  const result = startOrJoinDownload(
    downloadKey,
    async (ctx) => {
      try {
        // Check if already cached
        const cached = await validateCachedFile(modelPath, url, requireSecureTransport, ctx.signal)
        if (cached) {
          hooks?.markCacheHit?.()
          ctx.setCacheHit(true)
          try {
            const stats = await fsPromises.stat(cached)
            ctx.broadcastProgress({
              type: 'modelProgress',
              downloaded: stats.size,
              total: stats.size,
              percentage: 100,
              downloadKey
            })
          } catch (error) {
            logger.debug('Failed to get file stats for progress callback', {
              path: cached,
              error
            })
          }
          return cached
        }

        // Download the file
        hooks?.markCacheMiss?.()
        ctx.setCacheHit(false)
        const meta = await performHttpDownloadWithResume(
          url,
          modelPath,
          downloadKey,
          requireSecureTransport,
          ctx.broadcastProgress,
          ctx.signal
        )

        await verifyHttpModelFile(url, modelPath, meta.hubSha256, requireChecksum, hooks)

        try {
          const stats = await fsPromises.stat(modelPath)
          ctx.broadcastProgress({
            type: 'modelProgress',
            downloaded: stats.size,
            total: stats.size,
            percentage: 100,
            downloadKey
          })
        } catch (error) {
          logger.debug('Failed to get file stats for final progress update', {
            path: modelPath,
            error
          })
        }

        return modelPath
      } catch (error) {
        logger.error(
          '❌ Error downloading model:',
          error instanceof Error ? error.message : String(error)
        )

        // Check if we should delete the partial file (clearCache was requested)
        if (error instanceof DownloadCancelledError) {
          if (ctx.shouldClearCache()) {
            logger.info('🗑️ Clearing cache - deleting partial file')
            try {
              await fsPromises.unlink(modelPath)
              logger.info(`✅ Deleted partial file: ${modelPath}`)
            } catch (error) {
              logger.debug('Failed to delete partial file during cleanup', {
                path: modelPath,
                error
              })
            }
          } else {
            logger.info('📥 Download paused - partial file preserved for resume')
          }
        }

        const errorToThrow = error instanceof Error ? error : new Error(String(error))
        throw errorToThrow
      }
    },
    progressCallback,
    hooks?.requestBinding
  )

  return applyJoinedDownloadStats(result, hooks)
}

async function downloadShardedModelFromHttp(
  shardUrl: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  hooks?: DownloadHooks,
  security?: DownloadSecurityOptions
) {
  const config = getConfig()
  const concurrency = config.httpDownloadConcurrency ?? DEFAULT_CONCURRENCY
  const connectionTimeout = config.httpConnectionTimeoutMs ?? DEFAULT_HTTP_CONNECTION_TIMEOUT_MS
  const { requireChecksum, requireSecureTransport } = resolveDownloadSecurity(security)
  const { shardUrls: shardInfos, cacheKey } = parsePatternBasedShardUrl(shardUrl)
  const downloadKey = `http-sharded:${cacheKey}`
  hooks?.onDownloadKey?.(downloadKey)

  logger.info(`📥 HTTP sharded download: ${shardInfos.length} shards detected from ${shardUrl}`)

  const shardDir = getShardedModelCacheDir(cacheKey)

  const result = startOrJoinDownload(
    downloadKey,
    async (ctx) => {
      try {
        const shardStates: ShardDownloadState[] = await Promise.all(
          shardInfos.map(async (shard, index) => {
            const shardPath = path.join(shardDir, shard.filename)
            let expectedSize = 0

            try {
              const response = await safeFetch(shard.url, {
                method: 'HEAD',
                timeoutMs: connectionTimeout,
                enforceSecureTransport: shouldEnforceSecureTransport(
                  shard.url,
                  requireSecureTransport
                ),
                signal: ctx.signal
              })
              response.body.resume()
              expectedSize = parseInt(String(response.headers['content-length'] ?? '0') || '0')
            } catch (error) {
              // A refused insecure hop is terminal; fail fast instead of logging a
              // misleading "failed to get shard size" and hitting it again on GET.
              if (error instanceof InsecureModelSourceError) throw error
              logger.warn('Failed to get shard size via HEAD request', {
                url: shard.url,
                error
              })
            }

            return {
              index,
              shard,
              shardPath,
              expectedSize,
              downloadedBytes: 0,
              isComplete: false
            }
          })
        )

        const overallTotal = shardStates.reduce((sum, s) => sum + s.expectedSize, 0)

        logger.info(
          `📏 Total size: ${overallTotal} bytes (${(overallTotal / 1024 / 1024).toFixed(2)} MB)`
        )

        const cacheChecks = await Promise.all(
          shardStates.map(async (state) => {
            const cached = await validateCachedFile(
              state.shardPath,
              state.shard.url,
              requireSecureTransport,
              ctx.signal
            )
            return { state, isCached: cached !== null }
          })
        )

        const shardsToDownload = cacheChecks.filter((c) => !c.isCached).map((c) => c.state)

        for (const check of cacheChecks) {
          if (check.isCached) {
            check.state.isComplete = true
            check.state.downloadedBytes = check.state.expectedSize
          }
        }

        logger.info(`📥 ${shardsToDownload.length} of ${shardInfos.length} shards need downloading`)

        if (shardsToDownload.length === 0) {
          hooks?.markCacheHit?.()
          ctx.setCacheHit(true)
        } else {
          hooks?.markCacheMiss?.()
          ctx.setCacheHit(false)
        }

        await downloadShardsWithConcurrency(
          shardsToDownload,
          shardStates,
          concurrency,
          ctx.signal,
          downloadKey,
          overallTotal,
          requireSecureTransport,
          ctx.broadcastProgress,
          requireChecksum,
          hooks
        )

        logger.info(`✅ All ${shardInfos.length} shards downloaded successfully`)

        await extractTensorsFromShards(shardDir, shardInfos[0]!.filename)

        return path.join(shardDir, shardInfos[0]!.filename)
      } catch (error) {
        logger.error(
          '❌ Error during sharded download:',
          error instanceof Error ? error.message : String(error)
        )

        if (error instanceof DownloadCancelledError) {
          if (ctx.shouldClearCache()) {
            logger.info('🗑️ Clearing cache - deleting partial shard files')
            try {
              await fsPromises.rm(shardDir, { recursive: true, force: true })
              logger.info(`✅ Deleted shard directory: ${shardDir}`)
            } catch (cleanupError) {
              logger.debug('Failed to delete shard directory during cleanup', {
                path: shardDir,
                error: cleanupError
              })
            }
          }
        }

        throw error
      }
    },
    progressCallback,
    hooks?.requestBinding
  )

  return applyJoinedDownloadStats(result, hooks)
}

async function downloadShardedModelFromArchive(
  archiveUrl: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  hooks?: DownloadHooks,
  security?: DownloadSecurityOptions
) {
  const filename = extractFilenameFromUrl(archiveUrl)
  const sourceHash = generateShortHash(archiveUrl)
  const downloadKey = `http-archive:${sourceHash}`
  hooks?.onDownloadKey?.(downloadKey)
  const { requireChecksum, requireSecureTransport } = resolveDownloadSecurity(security)

  logger.info(`📦 HTTP archive download: ${filename}`)

  const extractDir = getShardedModelCacheDir(sourceHash)
  const archivePath = path.join(extractDir, `${sourceHash}_${filename}`)

  const result = startOrJoinDownload(
    downloadKey,
    async (ctx) => {
      try {
        await fsPromises.mkdir(extractDir, { recursive: true })

        const files = await fsPromises.readdir(extractDir)
        const shardedFile = files.find((f) => detectShardedModel(String(f)).isSharded)

        if (!shardedFile) {
          hooks?.markCacheMiss?.()
          ctx.setCacheHit(false)
          return downloadAndExtractArchive()
        }

        const shardFilename = String(shardedFile)
        const allShardsExist = await checkAllShardsExist(extractDir, shardFilename)

        if (!allShardsExist) {
          logger.warn(`⚠️ Incomplete shards found, re-downloading archive`)
          hooks?.markCacheMiss?.()
          ctx.setCacheHit(false)
          return downloadAndExtractArchive()
        }

        const shardFilenames = generateShardFilenames(shardFilename)
        const firstShard = path.join(extractDir, shardFilenames[0]!)
        const isComplete = await validateShardedModelCache(extractDir, shardFilename)

        if (isComplete) {
          logger.info(`✅ Archive already extracted: ${extractDir}`)
          hooks?.markCacheHit?.()
          ctx.setCacheHit(true)
          ctx.broadcastProgress({
            type: 'modelProgress',
            downloaded: 1,
            total: 1,
            percentage: 100,
            downloadKey
          })
          return firstShard
        }

        logger.info(`📝 All shards present but tensors.txt missing, extracting tensors...`)
        try {
          await extractTensorsFromShards(extractDir, shardFilename)
          logger.info(`✅ Tensors extracted successfully`)
          hooks?.markCacheHit?.()
          ctx.setCacheHit(true)
          ctx.broadcastProgress({
            type: 'modelProgress',
            downloaded: 1,
            total: 1,
            percentage: 100,
            downloadKey
          })
          return firstShard
        } catch (error) {
          logger.warn(`Failed to extract tensors, will re-download archive`, {
            error
          })
          hooks?.markCacheMiss?.()
          ctx.setCacheHit(false)
          return downloadAndExtractArchive()
        }
      } catch (error) {
        logger.error('❌ Error downloading/extracting archive:', error)

        if (error instanceof DownloadCancelledError) {
          if (ctx.shouldClearCache()) {
            logger.info('🗑️ Clearing cache - deleting archive extract directory')
            try {
              await fsPromises.rm(extractDir, {
                recursive: true,
                force: true
              })
              logger.info(`✅ Deleted extract directory: ${extractDir}`)
            } catch (cleanupError) {
              logger.debug('Failed to delete extract directory during cleanup', {
                path: extractDir,
                error: cleanupError
              })
            }
          }
        }

        throw error
      }

      async function downloadAndExtractArchive() {
        const meta = await performHttpDownloadWithResume(
          archiveUrl,
          archivePath,
          downloadKey,
          requireSecureTransport,
          ctx.broadcastProgress,
          ctx.signal
        )

        // Verify the downloaded archive before extraction so tampered bytes
        // never reach the extractor.
        await verifyHttpModelFile(archiveUrl, archivePath, meta.hubSha256, requireChecksum, hooks)

        logger.info(`✅ Archive downloaded, extracting to: ${extractDir}`)

        const firstShardPath = await extractAndValidateShardedArchive(
          archivePath,
          extractDir,
          ctx.signal
        )

        try {
          await fsPromises.unlink(archivePath)
          logger.info(`🗑️ Cleaned up archive file: ${archivePath}`)
        } catch (cleanupError) {
          logger.debug('Failed to delete archive file during cleanup', {
            path: archivePath,
            error: cleanupError
          })
        }

        return firstShardPath
      }
    },
    progressCallback,
    hooks?.requestBinding
  )

  return applyJoinedDownloadStats(result, hooks)
}

async function downloadShardsWithConcurrency(
  shardsToDownload: ShardDownloadState[],
  allShards: ShardDownloadState[],
  concurrency: number,
  signal: AbortSignal,
  downloadKey: string,
  overallTotal: number,
  requireSecureTransport: boolean,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  requireChecksum = false,
  hooks?: DownloadHooks
) {
  const queue = [...shardsToDownload]
  const inFlight = new Set<Promise<void>>()

  while (queue.length > 0 || inFlight.size > 0) {
    if (signal.aborted) {
      throw new DownloadCancelledError()
    }

    while (queue.length > 0 && inFlight.size < concurrency) {
      const state = queue.shift()!

      const downloadPromise = (async () => {
        logger.info(`📥 Downloading shard ${state.index + 1}: ${state.shard.filename}`)

        const meta = await performHttpDownloadWithResume(
          state.shard.url,
          state.shardPath,
          downloadKey,
          requireSecureTransport,
          (progress) => {
            state.downloadedBytes = progress.downloaded

            if (progressCallback) {
              const overallDownloaded = allShards.reduce((sum, s) => sum + s.downloadedBytes, 0)

              progressCallback({
                type: 'modelProgress',
                downloaded: state.downloadedBytes,
                total: state.expectedSize,
                percentage: calculatePercentage(state.downloadedBytes, state.expectedSize),
                downloadKey,
                shardInfo: {
                  currentShard: state.index + 1,
                  totalShards: allShards.length,
                  shardName: state.shard.filename,
                  overallDownloaded,
                  overallTotal,
                  overallPercentage: calculatePercentage(overallDownloaded, overallTotal)
                }
              })
            }
          },
          signal
        )

        await verifyHttpModelFile(
          state.shard.url,
          state.shardPath,
          meta.hubSha256,
          requireChecksum,
          hooks
        )

        logger.info(`✅ Shard ${state.index + 1} complete: ${state.shard.filename}`)
      })().finally(() => {
        inFlight.delete(downloadPromise)
      })

      inFlight.add(downloadPromise)
    }

    if (inFlight.size > 0) {
      await Promise.race(inFlight)
    }
  }

  // Mark all downloaded shards as complete
  for (const state of shardsToDownload) {
    state.isComplete = true
    state.downloadedBytes = state.expectedSize
  }

  if (progressCallback) {
    progressCallback({
      type: 'modelProgress',
      downloaded: overallTotal,
      total: overallTotal,
      percentage: 100,
      downloadKey,
      shardInfo: {
        currentShard: allShards.length,
        totalShards: allShards.length,
        shardName: allShards[allShards.length - 1]!.shard.filename,
        overallDownloaded: overallTotal,
        overallTotal,
        overallPercentage: 100
      }
    })
  }
}
