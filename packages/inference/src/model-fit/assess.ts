import path from 'bare-path'

import { ModelTypeRequiredError, PluginNotFoundError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import { describeAccounting } from '@/model-fit/describe'
import type { FitStubUnavailableReason } from '@/model-fit/description/fetch'
import { resolveLoadFromStubs } from '@/model-fit/description/resolve-load'
import { fitLoad, unknownFit, type LoadFit } from '@/model-fit/fit-load'
import { combineFits } from '@/model-fit/sum'
import { getConfig } from '@/runtime/state'
import type { AssessModelFitResult, ModelFitCandidate } from '@/schemas/assess-model-fit'
import { isCanonicalModelType, normalizeModelType } from '@/schemas/index'
import { inferModelTypeFromModelSrc, type ModelSrcInput } from '@/schemas/model-src-utils'
import { detectShardedModel } from '@/utils/shard-utils'

/**
 * The engine that would run this load, named outright or read off the source,
 * as `loadModel` resolves it.
 *
 * @throws {ModelTypeRequiredError} When neither names one.
 */
function modelTypeOf(candidate: ModelFitCandidate): string {
  if (candidate.modelType !== undefined) return normalizeModelType(candidate.modelType)

  const inferred = inferModelTypeFromModelSrc(candidate.modelSrc)
  if (inferred === undefined) throw new ModelTypeRequiredError()

  return normalizeModelType(inferred)
}

/**
 * Whether the source names one shard of a split model, read from its file name
 * as `loadModel` reads it. A catalog constant names its file by registry path.
 */
function isSplitSource(modelSrc: ModelSrcInput | undefined): boolean {
  if (modelSrc === undefined) return false
  const location = typeof modelSrc === 'string' ? modelSrc : (modelSrc.registryPath ?? modelSrc.src)
  return detectShardedModel(path.basename(location)).isSharded
}

/** Why a load with no description staged for it has no fitter verdict. */
export function noStubDetail(reason: FitStubUnavailableReason, message?: string): string {
  if (reason === 'files-only-engine') {
    return 'the engine measures downloaded files only, and this model is not downloaded'
  }
  return message === undefined
    ? `no registry description (${reason})`
    : `no registry description (${reason}): ${message}`
}

/**
 * The fitter's answer for one candidate, run against the model on disk or the
 * registry's weightless description of it.
 */
async function fitCandidate(candidate: ModelFitCandidate): Promise<LoadFit> {
  const modelType = modelTypeOf(candidate)
  if (!isCanonicalModelType(modelType)) throw new PluginNotFoundError(modelType)

  const budgetMs = getConfig().fitStubBudgetMs
  const resolved = await resolveLoadFromStubs(
    {
      modelType,
      ...(candidate.modelSrc !== undefined && { modelSrc: candidate.modelSrc }),
      ...(candidate.modelConfig !== undefined && { modelConfig: candidate.modelConfig }),
      ...(candidate.transcriptionWorkload !== undefined && {
        transcriptionWorkload: candidate.transcriptionWorkload
      }),
      ...(candidate.ttsWorkload !== undefined && { ttsWorkload: candidate.ttsWorkload })
    },
    budgetMs !== undefined ? { budgetMs } : {}
  )
  if (resolved.status === 'no-stub') {
    return unknownFit(noStubDetail(resolved.reason, resolved.message))
  }

  try {
    return await fitLoad(modelType, {
      modelPath: resolved.modelPath,
      modelConfig: resolved.modelConfig,
      artifacts: resolved.artifacts,
      isShardedModel: isSplitSource(candidate.modelSrc),
      transcriptionWorkload: candidate.transcriptionWorkload,
      ttsWorkload: candidate.ttsWorkload
    })
  } finally {
    await resolved.release()
  }
}

/**
 * Whether a set of models fits when loaded together.
 *
 * Each model's fitter runs in turn, so a set never holds several fitters open
 * at once, and the answers are combined per memory pool against what is free.
 *
 * A load that `loadModel` would refuse throws the error that load would throw:
 * no plugin for the model type, a config its schema or plugin refuses, or the
 * fitter rejecting the load. A load that would start but cannot be sized is
 * `unknown`.
 *
 * @throws {ModelTypeRequiredError} When neither the model type nor the source
 *   names an engine.
 * @throws {PluginNotFoundError} When no plugin handles the model type.
 * @throws {PluginLoadConfigValidationFailedError} When the plugin's schema
 *   refuses the config.
 * @throws The plugin's or the fitter's own error when either refuses the load.
 */
export async function assessModelFit(
  candidates: readonly ModelFitCandidate[]
): Promise<AssessModelFitResult> {
  const fits: LoadFit[] = []
  for (const candidate of candidates) fits.push(await fitCandidate(candidate))

  const models = fits.map((fit) => fit.result)
  const { verdict, pools } = combineFits(models)
  const rows = fits.map((fit, index) => {
    const why = fit.reason === undefined ? '' : ` (${fit.reason})`
    return { label: `model ${index + 1} ${fit.result.status}${why}`, devices: fit.result.devices }
  })
  getEngineLogger().info(`[model-fit] ${verdict} — ${describeAccounting(pools, rows)}`)
  return { verdict, pools, models }
}
