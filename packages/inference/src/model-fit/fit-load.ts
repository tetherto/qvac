import type { AbortSignal } from 'bare-abort-controller'

import { runFit as runFitDefault } from '@/model-fit/run/run'
import { describePool } from '@/model-fit/describe'
import { sharedPoolOverflow, USABLE_SHARE } from '@/model-fit/sum'
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
 * would run it. Its status is the model's verdict alone: the fitter's, and
 * `does-not-fit` when devices sharing one pool overflow it. An `unknown` answer
 * always carries a reason, the fitter's own when it gives one, and so does a
 * `does-not-fit` from a shared pool, naming the pool.
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
  if (fit.status === 'unknown') return { ...fit, reason: fit.reason ?? ENGINE_UNSIZED }

  const overflow = fit.status === 'fits' ? sharedPoolOverflow(fit) : undefined
  if (overflow === undefined) return fit
  return {
    ...fit,
    status: 'does-not-fit',
    reason: `devices sharing one pool need more than ${USABLE_SHARE * 100}% of its free memory: ${describePool(overflow)}`
  }
}
