import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import type { AbortSignal } from 'bare-abort-controller'
import type { QVACBlobBinding } from '@qvac/registry-client'
import type { ModelProgressUpdate } from '@/schemas/index'
import type { RegistryItem } from '@/models/registry/index'
import { getModelByPath } from '@/models/registry/index'
import {
  calculatePercentage,
  detectShardedModel,
  generateShardFilenames,
  generateShortHash,
  getCompanionSetCacheDir,
  getCompanionSetPath,
  getShardPath,
  getShardedModelCacheDir,
  getSingleFileCachePath
} from '@/utils/index'
import { validateCachedFile } from '@/handlers/load-model/registry-download-utils'
import { downloadHttpFileToPath } from '@/handlers/load-model/http'
import {
  createRegistryCacheKey,
  createRegistryDownloadKey,
  startOrJoinDownload,
  applyJoinedDownloadStats
} from '@/handlers/load-model/download-manager'
import { acquireDownloadLock, partialDownloadPath } from '@/handlers/load-model/download-lock'
import {
  DownloadCancelledError,
  ModelLoadFailedError,
  RegistryDownloadFailedError
} from '@/errors/index'
import type { DownloadHooks } from '@/handlers/load-model/types'
import {
  resolveRegistryDownloadMetadata,
  type ExplicitRegistryMetadata
} from '@/handlers/load-model/registry-metadata'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

export async function findModelShards(
  registryPath: string,
  signal?: AbortSignal,
  _wait: 'download' | 'query' | 'status' = 'download'
): Promise<
  {
    path: string
    source: string
    size: number
    checksum: string
    blobBinding: QVACBlobBinding | undefined
  }[]
> {
  if (signal?.aborted) throw new DownloadCancelledError()
  const shardInfo = detectShardedModel(registryPath.split('/').pop() || '')
  if (!shardInfo.isSharded) {
    throw new RegistryDownloadFailedError(`Not a sharded model path: ${registryPath}`)
  }
  const metadata = getModelByPath(registryPath)
  if (!metadata?.shardMetadata?.length) {
    throw new RegistryDownloadFailedError(
      `Browser shard discovery requires catalog metadata for ${registryPath}`
    )
  }
  const directory = registryPath.slice(0, registryPath.lastIndexOf('/') + 1)
  return metadata.shardMetadata.map((shard) => ({
    path: directory + shard.filename,
    source: metadata.registrySource,
    size: shard.expectedSize,
    checksum: shard.sha256Checksum,
    blobBinding: undefined
  }))
}

export function selectDeclaredShards<T extends { path: string }>(
  registryPath: string,
  remoteShards: T[]
): T[] {
  const directory = registryPath.slice(0, registryPath.lastIndexOf('/') + 1)
  const byPath = new Map(remoteShards.map((shard) => [shard.path, shard]))
  const expected = generateShardFilenames(registryPath.slice(directory.length))
  const declared = expected.flatMap((name) => byPath.get(directory + name) ?? [])
  if (declared.length !== expected.length) {
    throw new RegistryDownloadFailedError(
      `Expected ${expected.length} shards for ${registryPath} but the registry has ${declared.length}`
    )
  }
  return declared
}

type KnownFile = {
  registryPath: string
  registrySource: string
  targetName: string
  finalPath: string
  expectedSize: number
  expectedChecksum: string
}

export function huggingFaceUrl(registryPath: string): string {
  const [owner, repo, kind, ...rest] = registryPath.split('/')
  if (!owner || !repo || !kind || rest.length === 0) {
    throw new ModelLoadFailedError(`Invalid Hugging Face registry path: ${registryPath}`)
  }
  return `https://huggingface.co/${owner}/${repo}/${kind === 'blob' ? 'resolve' : kind}/${rest.join('/')}`
}

function assertBrowserSource(file: Pick<KnownFile, 'registryPath' | 'registrySource'>): void {
  if (file.registrySource !== 'hf') {
    throw new ModelLoadFailedError(
      `${file.registryPath} is served only through the QVAC peer-to-peer registry, which is not available in a browser. Use an HTTPS URL, an HTTPS-backed registry model, or a browser file.`
    )
  }
}

function assertIntegrity(file: KnownFile): void {
  if (
    !Number.isSafeInteger(file.expectedSize) ||
    file.expectedSize <= 0 ||
    !/^[0-9a-f]{64}$/i.test(file.expectedChecksum)
  ) {
    throw new RegistryDownloadFailedError(
      `Browser registry download requires size and SHA-256 metadata for ${file.registryPath}`
    )
  }
}

async function downloadFile(
  file: KnownFile,
  downloadKey: string,
  progressCallback: ((progress: ModelProgressUpdate) => void) | undefined,
  signal: AbortSignal,
  hooks: DownloadHooks | undefined
): Promise<boolean> {
  assertBrowserSource(file)
  assertIntegrity(file)
  const cached = await validateCachedFile(
    file.finalPath,
    file.targetName,
    file.expectedSize,
    file.expectedChecksum,
    hooks
  )
  if (cached) return true

  await fsPromises.mkdir(path.dirname(file.finalPath), { recursive: true })
  await downloadHttpFileToPath({
    url: huggingFaceUrl(file.registryPath),
    finalPath: file.finalPath,
    downloadKey,
    expectedSize: file.expectedSize,
    expectedChecksum: file.expectedChecksum,
    progressCallback,
    signal,
    hooks
  })
  return false
}

function shardFiles(metadata: RegistryItem): KnownFile[] {
  if (!metadata.shardMetadata?.length) return []
  const directory = metadata.registryPath.slice(0, metadata.registryPath.lastIndexOf('/') + 1)
  const cacheKey = generateShortHash(metadata.registryPath)
  return metadata.shardMetadata.map((shard) => ({
    registryPath: directory + shard.filename,
    registrySource: metadata.registrySource,
    targetName: shard.filename,
    finalPath: getShardPath(cacheKey, shard.filename),
    expectedSize: shard.expectedSize,
    expectedChecksum: shard.sha256Checksum
  }))
}

function companionFiles(metadata: RegistryItem): KnownFile[] {
  return (
    metadata.companionSet?.files.map((file) => ({
      registryPath: file.registryPath,
      registrySource: file.registrySource,
      targetName: file.targetName,
      finalPath: getCompanionSetPath(metadata.companionSet!.setKey, file.targetName),
      expectedSize: file.expectedSize,
      expectedChecksum: file.sha256Checksum
    })) ?? []
  )
}

async function downloadFileSet(options: {
  files: KnownFile[]
  downloadKey: string
  setKey: string
  kind: 'shard' | 'companion'
  progressCallback: ((progress: ModelProgressUpdate) => void) | undefined
  signal: AbortSignal
  hooks: DownloadHooks | undefined
}): Promise<boolean> {
  const overallTotal = options.files.reduce((sum, file) => sum + file.expectedSize, 0)
  let overallDownloaded = 0
  let allCached = true

  for (let index = 0; index < options.files.length; index++) {
    if (options.signal.aborted) throw new DownloadCancelledError()
    const file = options.files[index]!
    const progress = options.progressCallback
      ? (update: ModelProgressUpdate) => {
          const current = overallDownloaded + update.downloaded
          const common = {
            ...update,
            downloadKey: options.downloadKey
          }
          options.progressCallback!(
            options.kind === 'shard'
              ? {
                  ...common,
                  shardInfo: {
                    currentShard: index + 1,
                    totalShards: options.files.length,
                    shardName: file.targetName,
                    overallDownloaded: current,
                    overallTotal,
                    overallPercentage: calculatePercentage(current, overallTotal)
                  }
                }
              : {
                  ...common,
                  fileSetInfo: {
                    setKey: options.setKey,
                    currentFile: file.targetName,
                    fileIndex: index + 1,
                    totalFiles: options.files.length,
                    overallDownloaded: current,
                    overallTotal,
                    overallPercentage: calculatePercentage(current, overallTotal)
                  }
                }
          )
        }
      : undefined
    const cached = await downloadFile(
      file,
      options.downloadKey,
      progress,
      options.signal,
      options.hooks
    )
    allCached &&= cached
    overallDownloaded += file.expectedSize
  }

  if (options.progressCallback) {
    const last = options.files[options.files.length - 1]!
    const base = {
      type: 'modelProgress' as const,
      downloaded: overallTotal,
      total: overallTotal,
      percentage: 100,
      downloadKey: options.downloadKey
    }
    options.progressCallback(
      options.kind === 'shard'
        ? {
            ...base,
            shardInfo: {
              currentShard: options.files.length,
              totalShards: options.files.length,
              shardName: last.targetName,
              overallDownloaded: overallTotal,
              overallTotal,
              overallPercentage: 100
            }
          }
        : {
            ...base,
            fileSetInfo: {
              setKey: options.setKey,
              currentFile: last.targetName,
              fileIndex: options.files.length,
              totalFiles: options.files.length,
              overallDownloaded: overallTotal,
              overallTotal,
              overallPercentage: 100
            }
          }
    )
  }
  return allCached
}

async function clearPartialFiles(files: KnownFile[]): Promise<void> {
  await Promise.all(
    files.map((file) => fsPromises.unlink(partialDownloadPath(file.finalPath)).catch(() => {}))
  )
}

export async function downloadModelFromRegistry(
  registryPath: string,
  registrySource: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  expectedChecksum?: string,
  hooks?: DownloadHooks,
  explicitMetadata?: ExplicitRegistryMetadata
): Promise<string> {
  const metadata = getModelByPath(registryPath)
  const downloadKey = createRegistryDownloadKey(registrySource, registryPath)
  hooks?.onDownloadKey?.(downloadKey)

  const result = startOrJoinDownload(
    downloadKey,
    async (ctx) => {
      await using _lock = await acquireDownloadLock(
        createRegistryCacheKey(registryPath),
        ctx.signal
      )

      const shards = metadata ? shardFiles(metadata) : []
      const companions = metadata ? companionFiles(metadata) : []
      let files: KnownFile[] = []
      let primaryPath: string
      let allCached: boolean

      try {
        if (shards.length > 0) {
          files = shards
          primaryPath = shards[0]!.finalPath
          allCached = await downloadFileSet({
            files,
            downloadKey,
            setKey: generateShortHash(registryPath),
            kind: 'shard',
            progressCallback: ctx.broadcastProgress,
            signal: ctx.signal,
            hooks
          })
        } else if (companions.length > 0) {
          files = companions
          const primaryKey = metadata!.companionSet!.primaryKey
          const primary = metadata!.companionSet!.files.find((file) => file.key === primaryKey)
          if (!primary) {
            throw new RegistryDownloadFailedError(
              `Companion set missing primary file (key: ${primaryKey})`
            )
          }
          primaryPath = getCompanionSetPath(metadata!.companionSet!.setKey, primary.targetName)
          allCached = await downloadFileSet({
            files,
            downloadKey,
            setKey: metadata!.companionSet!.setKey,
            kind: 'companion',
            progressCallback: ctx.broadcastProgress,
            signal: ctx.signal,
            hooks
          })
        } else {
          const resolved = resolveRegistryDownloadMetadata(
            metadata,
            explicitMetadata,
            expectedChecksum
          )
          const filename = registryPath.split('/').pop() || registryPath
          const file: KnownFile = {
            registryPath,
            registrySource,
            targetName: filename,
            finalPath: getSingleFileCachePath(registryPath),
            expectedSize: resolved.expectedSize,
            expectedChecksum: resolved.checksum
          }
          files = [file]
          primaryPath = file.finalPath
          allCached = await downloadFile(
            file,
            downloadKey,
            ctx.broadcastProgress,
            ctx.signal,
            hooks
          )
        }
      } catch (error) {
        if (error instanceof DownloadCancelledError && ctx.shouldClearCache()) {
          await clearPartialFiles(files)
          if (metadata?.shardMetadata) {
            await fsPromises
              .rm(getShardedModelCacheDir(generateShortHash(registryPath)), {
                recursive: true,
                force: true
              })
              .catch(() => {})
          }
          if (metadata?.companionSet) {
            await fsPromises
              .rm(getCompanionSetCacheDir(metadata.companionSet.setKey), {
                recursive: true,
                force: true
              })
              .catch(() => {})
          }
        }
        throw error
      }

      if (allCached) {
        hooks?.markCacheHit?.()
        ctx.setCacheHit(true)
      } else {
        hooks?.markCacheMiss?.()
        ctx.setCacheHit(false)
      }
      logger.info(`Browser registry model ready: ${primaryPath}`)
      return primaryPath
    },
    progressCallback,
    hooks?.requestBinding
  )

  return applyJoinedDownloadStats(result, hooks)
}
