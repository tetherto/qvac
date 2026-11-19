import type { AbortSignal } from 'bare-abort-controller'

import { runFit as runFitDefault } from '@/model-fit/run/run'
import { judgeAlone } from '@/model-fit/sum'
import type { ModelFitModelResult } from '@/schemas/assess-model-fit'
import { ModelType } from '@/schemas/index'
import type { FitLoad } from '@/schemas/plugin'

/** Why a fitter that answered `unknown` gave no reason of its own. */
export const ENGINE_UNSIZED = 'the engine fitter could not size this load'

export interface FitLoadOptions {
  signal?: AbortSignal
  runFit?: typeof runFitDefault
}

export function unknownFit(reason: string): ModelFitModelResult {
  return { status: 'unknown', devices: [], stats: {}, reason }
}

/**
 * The fitter's answer for one load, through the plugin of the engine that
 * would run it. Its status is the model's verdict alone, from `judgeAlone`. An
 * `unknown` answer always carries a reason.
 *
 * @throws The fitter's own error when it rejects the load, such as a model it
 *   cannot read or a request it refuses.
 */
export async function fitLoad(
  modelType: string,
  load: FitLoad,
  options: FitLoadOptions = {}
): Promise<ModelFitModelResult> {
  const { getPlugin } = await import('@/plugins/registry')
  const plugin = getPlugin(modelType)
  if (plugin?.fitRequest === undefined || plugin.assessFit === undefined) {
    return unknownFit(`no fitter for model type ${modelType}`)
  }
  if (load.transcriptionWorkload !== undefined && plugin.modelType !== ModelType.mossTranscribe) {
    return unknownFit('a transcriptionWorkload sizes MOSS transcription only')
  }

  const plan = plugin.fitRequest(load)
  if ('unknown' in plan) return unknownFit(plan.unknown)

  const outcome = await (options.runFit ?? runFitDefault)(
    { addonPackage: plugin.addonPackage, request: plan.request },
    options.signal !== undefined ? { signal: options.signal } : {}
  )
  if (outcome.status === 'unknown') return unknownFit(`${outcome.reason}: ${outcome.message}`)

  const { fit } = outcome
  return fit.status === 'unknown'
    ? { ...fit, reason: ENGINE_UNSIZED }
    : { ...fit, status: judgeAlone(fit) }
}
