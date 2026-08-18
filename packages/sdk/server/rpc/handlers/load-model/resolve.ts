import { models, getModelByPath } from '@/models/registry/models'
import {
  hyperdriveUrlSchema,
  registryUrlSchema,
  SUPPORTED_ARCHIVE_EXTENSIONS,
  type ModelProgressUpdate
} from '@/schemas'
import {
  getModelsCacheDir,
  getShardedModelCacheDir,
  generateShortHash,
  extractAndValidateShardedArchive,
  measureChecksum
} from '@/server/utils'
import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { downloadModelFromHttp } from './http'
import { downloadModelFromHyperdrive } from './hyperdrive'
import { downloadModelFromRegistry } from './registry'
import { getExplicitRegistryMetadata } from './registry-metadata'
import {
  downloadModelFromHttpWithStats,
  downloadModelFromHyperdriveWithStats,
  downloadModelFromRegistryWithStats
} from './download-stats'
import type { ResolveResult, DownloadResult, DownloadHooks } from './types'
import type { AbortSignal } from 'bare-abort-controller'
import {
  ChecksumValidationFailedError,
  DownloadCancelledError,
  InferenceCancelledError,
  ModelFileNotFoundError,
  ModelLoadFailedError,
  ModelNotFoundError,
  SeedingNotSupportedError
} from '@/utils/errors-server'
import { validateAndJoinPath } from '@/server/utils/path-security'
import { getServerLogger } from '@/logging'
import { modelInputToSrcSchema } from '@/schemas'

type ResolveMode = 'base' | 'stats'

const logger = getServerLogger()

function isArchivePath(filePath: string) {
  const filename = path.basename(filePath).toLowerCase()
  return SUPPORTED_ARCHIVE_EXTENSIONS.some((ext) => filename.endsWith(ext))
}

/**
 * Resolves a local file path or cached file
 */
async function resolveLocalOrCachedFile(modelIdOrPath: string) {
  // Check if it's a hex string (arbitrary hyperdrive key)
  const isHexString = /^[0-9a-fA-F]{64}$/.test(modelIdOrPath)
  if (isHexString) {
    throw new ModelLoadFailedError(
      `Direct hyperdrive keys not supported. Use hyperdriveKey parameter instead. Example: loadModel("model.gguf", "${modelIdOrPath}")`
    )
  }

  // Check if it's a cached file or local file
  const cacheDir = getModelsCacheDir()
  const cachedPath = validateAndJoinPath(cacheDir, modelIdOrPath)

  try {
    await fsPromises.access(cachedPath)
    logger.info(`Loading cached model: ${cachedPath}`)

    // Check if cached file is an archive
    if (isArchivePath(cachedPath)) {
      logger.info(`Extracting cached archive: ${cachedPath}`)
      const archiveHash = generateShortHash(cachedPath)
      const extractDir = getShardedModelCacheDir(archiveHash)
      const extractedPath = await extractAndValidateShardedArchive(cachedPath, extractDir)
      return extractedPath
    }

    return cachedPath
  } catch {
    // Try as local file in current directory
    try {
      await fsPromises.access(modelIdOrPath)
      logger.info(`Loading local file: ${modelIdOrPath}`)

      // Check if local file is an archive
      if (isArchivePath(modelIdOrPath)) {
        logger.info(`Extracting local archive: ${modelIdOrPath}`)
        const archiveHash = generateShortHash(modelIdOrPath)
        const extractDir = getShardedModelCacheDir(archiveHash)
        const extractedPath = await extractAndValidateShardedArchive(modelIdOrPath, extractDir)
        return extractedPath
      }

      return modelIdOrPath
    } catch {
      // Invalid model ID - provide helpful error
      const availableModels = models.map((m) => m.modelId)
      throw new ModelNotFoundError(
        `${modelIdOrPath}". Available models: ${availableModels.join(', ')}`
      )
    }
  }
}

function isDownloadResult(value: string | DownloadResult): value is DownloadResult {
  return value !== null && typeof value === 'object' && 'path' in value
}

function buildResult(
  pathOrResult: string | DownloadResult,
  sourceType: ResolveResult['sourceType']
): ResolveResult {
  if (isDownloadResult(pathOrResult)) {
    return pathOrResult.stats
      ? { path: pathOrResult.path, sourceType, downloadStats: pathOrResult.stats }
      : { path: pathOrResult.path, sourceType }
  }
  return { path: pathOrResult, sourceType }
}

// A fallback is a non-P2P source: only HTTP URLs and file paths are valid.
// registry:// and pear:// are rejected.
export async function resolveFallbackModel(
  fallbackSrc: string,
  expectedChecksum: string | undefined,
  progressCallback: ((progress: ModelProgressUpdate) => void) | undefined,
  mode: ResolveMode,
  signal: AbortSignal | undefined,
  hooks: DownloadHooks | undefined
): Promise<ResolveResult> {
  if (fallbackSrc.startsWith('registry://') || fallbackSrc.startsWith('pear://')) {
    throw new ModelLoadFailedError('fallbackSrc must be an HTTP URL or a local file path.')
  }

  // seed applies only to hyperdrive sources, which a fallback can never be.
  const result = await resolveModelPathCore(
    fallbackSrc,
    progressCallback,
    false,
    mode,
    signal,
    hooks
  )

  // Report a missing fallback file as a not-found error before checksumming.
  try {
    await fsPromises.access(result.path)
  } catch {
    throw new ModelFileNotFoundError(result.path)
  }

  if (expectedChecksum && expectedChecksum.length === 64) {
    const actualChecksum = await measureChecksum(result.path, hooks)
    if (actualChecksum !== expectedChecksum) {
      // http downloads are cached under the models dir; drop a corrupt one.
      if (result.sourceType === 'http') {
        await fsPromises.unlink(result.path).catch(() => {})
      }
      throw new ChecksumValidationFailedError(fallbackSrc)
    }
  }

  return result
}

// Registry download with optional fallback. A user-initiated cancel always
// propagates. On any other primary failure: a fallback is taken when present;
// otherwise a known model surfaces a neutral error and an unknown one rethrows.
export async function resolveRegistryModel(params: {
  hasFallback: boolean
  isKnownModel: boolean
  downloadPrimary: () => Promise<ResolveResult>
  resolveFallback: () => Promise<ResolveResult>
  buildUnreachableError: (cause: unknown) => Error
}): Promise<ResolveResult> {
  try {
    return await params.downloadPrimary()
  } catch (error) {
    if (error instanceof InferenceCancelledError || error instanceof DownloadCancelledError) {
      throw error
    }
    if (params.hasFallback) {
      return params.resolveFallback()
    }
    const isCorrectnessError =
      error instanceof ChecksumValidationFailedError ||
      error instanceof ModelNotFoundError ||
      error instanceof ModelFileNotFoundError
    if (params.isKnownModel && !isCorrectnessError) {
      throw params.buildUnreachableError(error)
    }
    throw error
  }
}

async function resolveModelPathCore(
  modelSrc: unknown,
  progressCallback: ((progress: ModelProgressUpdate) => void) | undefined,
  seed: boolean | undefined,
  mode: ResolveMode,
  signal: AbortSignal | undefined,
  hooks?: DownloadHooks,
  fallbackSrc?: string
): Promise<ResolveResult> {
  if (signal?.aborted) {
    throw new InferenceCancelledError(hooks?.requestBinding?.requestId ?? 'unknown')
  }
  const srcString = modelInputToSrcSchema.parse(modelSrc)

  // A fallback is validated against the catalog checksum, which exists only for
  // built-in registry models. Other sources have no checksum to validate against.
  if (fallbackSrc !== undefined && !srcString.startsWith('registry://')) {
    throw new ModelLoadFailedError(
      'fallbackSrc is only supported when modelSrc is a built-in registry model.'
    )
  }

  // Empty modelSrc is reserved for plugins that ship bundled weights
  // (e.g. `@qvac/classification-ggml`). The handler skips this resolver
  // for them when `skipPrimaryModelPathValidation` is set, but if it
  // somehow gets called we return an empty path so the plugin's
  // `params.modelPath` falls through to undefined instead of being set
  // to the cache directory itself.
  if (srcString === '') {
    return { path: '', sourceType: 'filesystem' }
  }

  // Parse hyperdrive URLs if present
  let hyperdriveKey: string | undefined
  let actualModelSrc = srcString

  if (srcString.startsWith('pear://')) {
    const { key, path: pathValue } = hyperdriveUrlSchema.parse(srcString)
    hyperdriveKey = key
    actualModelSrc = pathValue
  }

  // Registry source
  if (srcString.startsWith('registry://')) {
    const { registryPath, registrySource } = registryUrlSchema.parse(srcString)
    logger.info(`Loading from registry: ${registryPath}`)

    // Look up model metadata for checksum validation
    const modelMetadata = getModelByPath(registryPath)
    const explicitMetadata = getExplicitRegistryMetadata(modelSrc)
    const expectedChecksum = modelMetadata?.sha256Checksum ?? explicitMetadata?.sha256Checksum

    // An uncatalogued registry path carries no checksum to validate a fallback against.
    if (fallbackSrc !== undefined && !modelMetadata) {
      throw new ModelLoadFailedError(
        'fallbackSrc is only supported when modelSrc is a built-in registry model.'
      )
    }

    // A single-file fallback cannot satisfy a sharded or companion-set model.
    if (
      fallbackSrc !== undefined &&
      (modelMetadata?.shardMetadata || modelMetadata?.companionSet)
    ) {
      throw new ModelLoadFailedError(
        'fallbackSrc is not supported for sharded or multi-file models.'
      )
    }

    return resolveRegistryModel({
      hasFallback: fallbackSrc !== undefined,
      isKnownModel: modelMetadata !== undefined,
      downloadPrimary: async () => {
        const result =
          mode === 'stats'
            ? await downloadModelFromRegistryWithStats(
                registryPath,
                registrySource,
                progressCallback,
                expectedChecksum,
                hooks,
                explicitMetadata
              )
            : await downloadModelFromRegistry(
                registryPath,
                registrySource,
                progressCallback,
                expectedChecksum,
                hooks,
                explicitMetadata
              )
        logger.info(`Loaded Model to ${isDownloadResult(result) ? result.path : result}`)
        return buildResult(result, 'registry')
      },
      resolveFallback: () => {
        logger.info(
          `Registry download failed for ${registryPath}; trying fallbackSrc: ${fallbackSrc}`
        )
        return resolveFallbackModel(
          fallbackSrc!,
          expectedChecksum,
          progressCallback,
          mode,
          signal,
          hooks
        )
      },
      buildUnreachableError: (cause) =>
        new ModelLoadFailedError(
          `Could not download "${modelMetadata?.modelId}" from the registry on this network ` +
            `(${cause instanceof Error ? cause.message : String(cause)}). ` +
            'If the registry is not reliably reachable here, pass a fallbackSrc ' +
            '(an HTTP URL or local file path) to load this model from an alternate source.',
          cause
        )
    })
  }

  // Validate seeding is only used with hyperdrive models
  if (seed && !hyperdriveKey) {
    throw new SeedingNotSupportedError()
  }

  // HTTP source
  if (actualModelSrc.startsWith('http://') || actualModelSrc.startsWith('https://')) {
    logger.info(`Loading from HTTP URL: ${actualModelSrc}`)

    const result =
      mode === 'stats'
        ? await downloadModelFromHttpWithStats(actualModelSrc, progressCallback, hooks)
        : await downloadModelFromHttp(actualModelSrc, progressCallback, hooks)
    logger.info(`Loaded Model to ${isDownloadResult(result) ? result.path : result}`)
    return buildResult(result, 'http')
  }

  // Hyperdrive source
  if (hyperdriveKey) {
    logger.info(`Loading from hyperdrive: ${hyperdriveKey}`)

    const result =
      mode === 'stats'
        ? await downloadModelFromHyperdriveWithStats(
            hyperdriveKey,
            actualModelSrc,
            seed,
            progressCallback,
            hooks
          )
        : await downloadModelFromHyperdrive(
            hyperdriveKey,
            actualModelSrc,
            seed,
            progressCallback,
            hooks
          )
    return buildResult(result, 'hyperdrive')
  }

  // Filesystem source (local files, cached files)
  let resolvedPath: string
  if (actualModelSrc.includes('/') || actualModelSrc.includes('\\')) {
    if (isArchivePath(actualModelSrc)) {
      logger.info(`Extracting local archive: ${actualModelSrc}`)
      const archiveHash = generateShortHash(actualModelSrc)
      const extractDir = getShardedModelCacheDir(archiveHash)
      resolvedPath = await extractAndValidateShardedArchive(actualModelSrc, extractDir)
    } else {
      resolvedPath = actualModelSrc
    }
  } else {
    resolvedPath = await resolveLocalOrCachedFile(actualModelSrc)
  }

  return { path: resolvedPath, sourceType: 'filesystem' }
}

export async function resolveModelPath(
  modelSrc: unknown,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  seed?: boolean,
  signal?: AbortSignal,
  hooks?: DownloadHooks,
  fallbackSrc?: string
): Promise<string> {
  const result = await resolveModelPathCore(
    modelSrc,
    progressCallback,
    seed,
    'base',
    signal,
    hooks,
    fallbackSrc
  )
  return result.path
}

export async function resolveModelPathWithStats(
  modelSrc: unknown,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  seed?: boolean,
  signal?: AbortSignal,
  hooks?: DownloadHooks,
  fallbackSrc?: string
): Promise<ResolveResult> {
  return resolveModelPathCore(modelSrc, progressCallback, seed, 'stats', signal, hooks, fallbackSrc)
}
