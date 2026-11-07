import type { AbortSignal } from 'bare-abort-controller'

import {
  loadModelServerParamsSchema,
  normalizeModelType,
  type LoadModelServerParams,
  type CanonicalModelType
} from '@/schemas/index'
import type { LoadTimingStats } from '@/profiling/types'
import { nowMs } from '@/profiling/clock'
import { forwardBackendDiagnostics } from '@/profiling/backend-diagnostics'
import {
  addModelLease,
  isModelLoaded,
  registerModel,
  type AnyModel
} from '@/runtime/model-registry'
import { OWNER_SESSION_ID } from '@/runtime/session-id'
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
  ModelFileLocateFailedError,
  ModelFitRefusedError,
  InferenceCancelledError
} from '@/errors/index'
import { ensureAddonLoggerReady, getPlugin } from '@/plugins/index'
import { runLoadFitCheck } from '@/model-fit/load-check'
import { refusesLoad, resolveModelFitPolicy, runsProbe } from '@/schemas/model-fit-policy'
import { getConfig } from '@/runtime/state'
import { resolveToolDialect } from '@/utils/tools/dialect'
import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

export interface LoadModelResult {
  timing?: LoadTimingStats
}

export interface LoadModelOptions {
  collectTiming?: boolean
  request?: { signal: AbortSignal; requestId: string }
  /** Session that takes a lease on the model. Defaults to the owner session. */
  sessionId?: string
}

// A load or reload in progress per model id. Two sessions loading the same
// configuration at once would both pass the loaded check and both load
// natively; the second native model could never be registered or unloaded.
// The id is a hash of the configuration, so one native load per id is the
// rule, and a lease is taken only once the model is registered or reconfigured.
const modelWorkInFlight = new Map<string, Promise<unknown>>()

/**
 * Runs `task` as the only load or reload of `modelId`. A caller that arrives
 * while one is running waits for it to settle before running its own task,
 * so it sees the model registered (and takes a lease) or finds it absent
 * (and loads it itself after a failed load). A caller whose request is
 * cancelled while it waits leaves the queue at once with
 * `InferenceCancelledError`; the load it waited for is not touched.
 */
export async function withModelWorkLock<T>(
  modelId: string,
  task: () => Promise<T>,
  request?: { signal: AbortSignal; requestId: string }
): Promise<T> {
  let pending = modelWorkInFlight.get(modelId)
  while (pending !== undefined) {
    await (request ? untilSettledOrAborted(pending, request.signal) : pending)
    if (request?.signal.aborted === true) throw new InferenceCancelledError(request.requestId)
    pending = modelWorkInFlight.get(modelId)
  }
  const run = task()
  modelWorkInFlight.set(
    modelId,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  try {
    return await run
  } finally {
    modelWorkInFlight.delete(modelId)
  }
}

function untilSettledOrAborted(pending: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
    )
  })
}

export async function loadModel(
  params: LoadModelServerParams,
  options?: LoadModelOptions
): Promise<LoadModelResult> {
  const parsed = loadModelServerParamsSchema.parse(params)
  return withModelWorkLock(parsed.modelId, () => loadModelLocked(parsed, options), options?.request)
}

async function loadModelLocked(
  params: LoadModelServerParams,
  options?: LoadModelOptions
): Promise<LoadModelResult> {
  const { modelId, modelPath, options: modelOptions, artifacts, modelName } = params
  const { modelConfig, modelType: rawModelType, modelFitPolicy } = modelOptions

  // Normalize modelType to canonical form (handles aliases and custom types)
  const modelType = normalizeModelType(rawModelType)

  const sessionId = options?.sessionId ?? OWNER_SESSION_ID

  // A cancel that landed while this load waited for another load of the same
  // model must not take a lease the caller no longer wants.
  if (options?.request?.signal.aborted === true) {
    throw new InferenceCancelledError(options.request.requestId)
  }

  // An already loaded model is shared: the caller takes a lease on it.
  if (isModelLoaded(modelId)) {
    addModelLease(modelId, sessionId)
    logger.info(`${modelType} model ${modelId} is already loaded; lease added for ${sessionId}`)
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

  // Runs after config resolution and path validation so it sees the same state
  // the real load uses, and before `createModel()` so it never competes with
  // the native load for device memory.
  const fitPolicy = resolveModelFitPolicy(modelFitPolicy, getConfig().modelFitPolicy)
  const request = options?.request
  const fitCheck = runsProbe(fitPolicy)
    ? await runLoadFitCheck(
        {
          modelId,
          modelType: modelType as CanonicalModelType,
          modelPath,
          modelConfig,
          artifacts,
          isShardedModel
        },
        request !== undefined ? { signal: request.signal } : {}
      )
    : undefined
  const fitProbe = fitCheck?.probe

  if (request?.signal.aborted === true) {
    throw new InferenceCancelledError(request.requestId)
  }

  if (refusesLoad(fitPolicy, fitProbe?.verdict)) {
    throw new ModelFitRefusedError(modelType, 'does-not-fit', fitCheck?.detail)
  }

  // Load the addon's logger before the addon itself runs. Plugins that defer
  // their logging module do so to keep registration free of native loads, so
  // this is the first point their addon is genuinely required.
  await ensureAddonLoggerReady(plugin)

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

    const toolDialect =
      'completionStream' in plugin.handlers
        ? await resolveToolDialect(modelName, modelPath)
        : undefined

    registerModel(
      modelId,
      {
        model: result.model,
        path: modelPath,
        config: modelConfig,
        modelType: modelType as CanonicalModelType,
        name: modelName,
        fitProbe,
        toolDialect
      },
      sessionId
    )

    const loadResult: LoadModelResult =
      modelInitializationTimeMs !== undefined ? { timing: { modelInitializationTimeMs } } : {}
    return forwardBackendDiagnostics(loadResult, result)
  } finally {
    stopLogBufferingWithTimeout(modelId)
  }
}
