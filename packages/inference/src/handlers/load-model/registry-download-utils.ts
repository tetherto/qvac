import type { ModelProgressUpdate } from '@/schemas/index'
import type { QVACBlobBinding } from '@qvac/registry-client'
import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import type { AbortSignal } from 'bare-abort-controller'
import { measureChecksum, calculatePercentage } from '@/utils/index'
import { getRegistryClient } from '@/runtime/registry-client'
import { getConfig } from '@/runtime/state'
import { buildRegistryClientOptions } from '@/handlers/load-model/registry-client-options'
import { ChecksumValidationFailedError, DownloadCancelledError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import type { DownloadHooks } from '@/handlers/load-model/types'
import { partialDownloadPath, publishDownload } from '@/handlers/load-model/download-lock'

const logger = getEngineLogger()

export {
  DEFAULT_REGISTRY_STREAM_TIMEOUT_MS,
  buildRegistryClientOptions
} from '@/handlers/load-model/registry-client-options'
export type { RegistryClientDownloadOptions } from '@/handlers/load-model/registry-client-options'

export function buildBlobBinding(meta: {
  blobCoreKey: string
  blobBlockOffset: number
  blobBlockLength: number
  blobByteOffset: number
  expectedSize: number
  sha256Checksum: string
}): QVACBlobBinding {
  return {
    coreKey: meta.blobCoreKey,
    blockOffset: meta.blobBlockOffset,
    blockLength: meta.blobBlockLength,
    byteOffset: meta.blobByteOffset,
    byteLength: meta.expectedSize,
    sha256: meta.sha256Checksum
  }
}

/**
 * Validate a cached file against expected size and checksum.
 *
 * Never deletes: a mismatched file may be another process's download in
 * progress (from an SDK version that writes in place). A fresh download
 * replaces it through `publishDownload`.
 */
export async function validateCachedFile(
  modelPath: string,
  modelFileName: string,
  expectedSize: number,
  expectedChecksum?: string,
  hooks?: DownloadHooks
): Promise<string | null> {
  try {
    await fsPromises.access(modelPath)

    const localStats = await fsPromises.stat(modelPath)
    const localSize = localStats.size

    if (localSize === expectedSize) {
      logger.info(`✅ Model cached with correct size: ${modelPath}`)

      if (expectedChecksum && expectedChecksum.length === 64) {
        const checksum = await measureChecksum(modelPath, hooks)
        if (checksum !== expectedChecksum) {
          throw new ChecksumValidationFailedError(
            `${modelFileName}. Expected: ${expectedChecksum}. Actual: ${checksum}. File may be corrupted`
          )
        }
      }
      logger.info(`✅ Model already cached and validated: ${modelPath}`)
      return modelPath
    }

    logger.warn(
      `📥 Cached file is incomplete (expected ${expectedSize}, got ${localSize}); downloading: ${modelPath}`
    )
    return null
  } catch (error) {
    if (error instanceof ChecksumValidationFailedError) {
      logger.warn(`📥 Cached file failed checksum validation; downloading: ${modelPath}`)
    }
    return null
  }
}

/**
 * Download a single file from the registry to filesystem.
 * When blobBinding is provided, uses direct blob download (skips metadata sync).
 * Otherwise falls back to metadata-based downloadModel.
 *
 * The file is written to its partial path and moved to `modelPath` only after
 * the size and checksum checks pass. Callers hold the download lock.
 */
export async function downloadSingleFileFromRegistry(
  registryPath: string,
  registrySource: string,
  modelPath: string,
  modelFileName: string,
  downloadKey: string,
  expectedSize: number,
  expectedChecksum: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  signal?: AbortSignal,
  blobBinding?: QVACBlobBinding,
  hooks?: DownloadHooks,
  shouldClearCache?: () => boolean
): Promise<void> {
  if (signal?.aborted) {
    throw new DownloadCancelledError()
  }

  const client = await getRegistryClient()

  const dir = path.dirname(modelPath)
  await fsPromises.mkdir(dir, { recursive: true })

  const onProgress = progressCallback
    ? (progress: { downloaded: number; total: number }) => {
        const total = progress.total || expectedSize || progress.downloaded
        progressCallback({
          type: 'modelProgress',
          downloaded: progress.downloaded,
          total,
          percentage: total > 0 ? calculatePercentage(progress.downloaded, total) : 0,
          downloadKey
        })
      }
    : undefined

  const partialPath = partialDownloadPath(modelPath)
  const clientOptions = buildRegistryClientOptions({
    config: getConfig(),
    outputFile: partialPath,
    onProgress,
    signal,
    shouldClearCache
  })

  if (blobBinding) {
    logger.info(`📥 Downloading blob directly: ${modelFileName}`)
    await client.downloadBlob(blobBinding, clientOptions)
  } else {
    logger.info(`📥 Downloading from registry: ${registryPath}`)
    await client.downloadModel(registryPath, registrySource, clientOptions)
  }

  const stats = await fsPromises.stat(partialPath)
  if (expectedSize && stats.size !== expectedSize) {
    await fsPromises.unlink(partialPath).catch(() => {})
    throw new ChecksumValidationFailedError(
      `${modelFileName}. File size mismatch: expected ${expectedSize}, got ${stats.size}`
    )
  }

  if (expectedChecksum && expectedChecksum.length === 64) {
    const checksum = await measureChecksum(partialPath, hooks)
    if (checksum !== expectedChecksum) {
      await fsPromises.unlink(partialPath).catch(() => {})
      throw new ChecksumValidationFailedError(
        `${modelFileName}. Expected: ${expectedChecksum}. Actual: ${checksum}`
      )
    }
    logger.info(`✅ Checksum validated for ${modelFileName}`)
  }

  await publishDownload(modelPath)
  logger.info(`✅ Downloaded to ${modelPath}`)

  if (progressCallback) {
    progressCallback({
      type: 'modelProgress',
      downloaded: stats.size,
      total: stats.size,
      percentage: 100,
      downloadKey
    })
  }
}
