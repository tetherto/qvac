import {
  loadModelServerParamsSchema,
  normalizeModelType,
  type LoadModelServerParams,
  type CanonicalModelType
} from '@/schemas/index'
import type { LoadTimingStats } from '@/profiling/types'
import { nowMs } from '@/profiling/clock'
import { forwardBackendDiagnostics } from '@/profiling/backend-diagnostics'
import { isModelLoaded, registerModel, type AnyModel } from '@/runtime/model-registry'
import { startLogBuffering, stopLogBufferingWithTimeout } from '@/runtime/logging-stream-registry'
import {
  detectShardedModel,
  generateShardFilenames,
  validateShardedModelCache
} from '@/utils/index'
import {
  PluginNotFoundError,
  ModelFileNotFoundError,
  ModelFileNotFoundInDirError,
  ModelFileLocateFailedError
} from '@/errors/index'
import { getPlugin } from '@/plugins/index'
import { runAdvisoryFitCheck } from '@/model-fit/advisory-fit'
import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

export interface LoadModelResult {
  timing?: LoadTimingStats
}

export async function loadModel(
  params: LoadModelServerParams,
  options?: { collectTiming?: boolean }
): Promise<LoadModelResult> {
  const {
    modelId,
    modelPath,
    options: modelOptions,
    artifacts,
    modelName
  } = loadModelServerParamsSchema.parse(params)
  const { modelConfig, modelType: rawModelType } = modelOptions

  // Normalize modelType to canonical form (handles aliases and custom types)
  const modelType = normalizeModelType(rawModelType)

  // Check if model is already loaded
  if (isModelLoaded(modelId)) {
    logger.info(`${modelType} model ${modelId} is already loaded`)
    return {}
  }

  // Detect if sharded model
  const modelFileName = path.basename(modelPath)
  const shardInfo = detectShardedModel(modelFileName)
  const isShardedModel = shardInfo.isSharded

  const plugin = getPlugin(modelType)
  if (!plugin) {
    throw new PluginNotFoundError(modelType)
  }
  if (isShardedModel) {
    // For sharded models, validate all shards and tensors.txt exist
    const shardDir = path.dirname(modelPath)
    const isValid = await validateShardedModelCache(shardDir, modelFileName)

    if (!isValid) {
      const numberedShards = generateShardFilenames(modelFileName)
      throw new ModelFileNotFoundError(
        `Missing shards or ${shardInfo.baseFilename}.tensors.txt. Expected ${numberedShards.length} shard files + tensors.txt in ${shardDir}`
      )
    }
  } else if (!plugin.skipPrimaryModelPathValidation) {
    // For non-sharded models, validate single file exists
    try {
      const modelDir = path.dirname(modelPath)
      const modelFile = path.basename(modelPath)

      const files = (await fsPromises.readdir(modelDir)) as string[]

      if (!files.includes(modelFile)) {
        throw new ModelFileNotFoundInDirError(modelFile, modelDir, modelType)
      }
    } catch (error) {
      logger.error(
        `Error reading ${modelType} model directory:`,
        error instanceof Error ? error.message : String(error)
      )
      throw new ModelFileLocateFailedError(modelType, modelPath, error)
    }
  }

  // Advisory: every outcome — including a projected insufficiency — continues
  // to the ordinary load below. Runs after config resolution and path
  // validation so it sees the same state the real load uses, and before
  // `createModel()` so it never competes with the native load for device
  // memory.
  await runAdvisoryFitCheck({
    modelId,
    modelType: modelType as CanonicalModelType,
    modelPath,
    modelConfig,
    artifacts,
    isShardedModel
  })

  logger.info(`${modelType}: Loading model ${modelId}...`)
  startLogBuffering(modelId)

  try {
    const initStart = options?.collectTiming ? nowMs() : 0

    const result = plugin.createModel({
      modelId,
      modelPath,
      modelConfig: modelConfig,
      modelName,
      artifacts
    }) as { model: AnyModel }

    await result.model.load(false)

    const modelInitializationTimeMs = options?.collectTiming ? nowMs() - initStart : undefined

    logger.info(`${modelType} model ${modelId} loaded`)

    registerModel(modelId, {
      model: result.model,
      path: modelPath,
      config: modelConfig,
      modelType: modelType as CanonicalModelType,
      name: modelName
    })

    const loadResult: LoadModelResult =
      modelInitializationTimeMs !== undefined ? { timing: { modelInitializationTimeMs } } : {}
    return forwardBackendDiagnostics(loadResult, result)
  } finally {
    stopLogBufferingWithTimeout(modelId)
  }
}
