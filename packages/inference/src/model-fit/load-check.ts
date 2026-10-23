import type { AbortSignal } from 'bare-abort-controller'

import { getEngineLogger } from '@/logging/index'
import type { Logger } from '@/logging/types'
import { fitLoad, unknownFit, type FitLoadOptions, type LoadFit } from '@/model-fit/fit-load'
import { describeAccounting, describePool } from '@/model-fit/describe'
import { combineFits, type CombinedFit } from '@/model-fit/sum'
import type { CanonicalModelType, ModelFitProbe } from '@/schemas/index'

export interface LoadCheckInput {
  modelId: string
  modelType: CanonicalModelType
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
  isShardedModel: boolean
}

/**
 * Injection seams. Every field defaults to the real runtime dependency; tests
 * substitute them rather than mocking modules.
 */
export interface LoadCheckOptions {
  signal?: AbortSignal
  logger?: Logger
  runFit?: FitLoadOptions['runFit']
}

export interface LoadCheck {
  probe: ModelFitProbe
  /** Why the load does not fit, for the refusal. Present on `does-not-fit`. */
  detail?: string
}

/** The pools the load overflows, or the fitter's own refusal when none does. */
function refusalDetail(combined: CombinedFit): string {
  const over = combined.pools.filter(
    (pool) => pool.freeBytes !== undefined && pool.usedBytes > pool.freeBytes
  )
  if (over.length === 0) return 'the engine fitter projects it will not fit its devices'
  return `needs ${over.map(describePool).join(', ')}`
}

function report(
  logger: Logger,
  input: LoadCheckInput,
  fit: LoadFit,
  combined: CombinedFit,
  detail: string | undefined
): void {
  const prefix = `[advisory-fit:${input.modelType}:${input.modelId}]`
  const accounting = describeAccounting(combined.pools, [
    { label: input.modelType, devices: fit.result.devices }
  ])

  if (combined.verdict === 'fits') {
    logger.info(`${prefix} projected to fit — ${accounting}`)
    return
  }
  if (combined.verdict === 'does-not-fit') {
    logger.warn(`${prefix} projected not to fit: ${detail} — ${accounting}`)
    return
  }

  const line = `${prefix} no fit verdict: ${fit.reason ?? 'a device reported no free memory'}`
  // A model type with no fitter answers this on every load, so it stays at
  // `debug`; anywhere a fitter should have answered, `info` says why it did not.
  if (fit.result.devices.length === 0 && fit.reason?.startsWith('no fitter') === true) {
    logger.debug(line)
    return
  }
  logger.info(`${line} — ${accounting}`)
}

/**
 * Checks a load that is about to start against what is free, with the fitter
 * of the engine that will run it.
 *
 * A fitter that rejects the load is logged and answers `unknown`, so the
 * check never fails a load of its own accord. This function never throws.
 */
export async function runLoadFitCheck(
  input: LoadCheckInput,
  options: LoadCheckOptions = {}
): Promise<LoadCheck> {
  const logger = options.logger ?? getEngineLogger()

  let fit: LoadFit
  try {
    fit = await fitLoad(
      input.modelType,
      {
        modelPath: input.modelPath,
        modelConfig: input.modelConfig,
        artifacts: input.artifacts,
        isShardedModel: input.isShardedModel
      },
      {
        ...(options.signal !== undefined && { signal: options.signal }),
        ...(options.runFit !== undefined && { runFit: options.runFit })
      }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      logger.warn(`[advisory-fit:${input.modelType}:${input.modelId}] fit failed: ${message}`)
    } catch {
      // A failing logger must not turn the check into a load failure.
    }
    return { probe: { verdict: 'unknown', pools: [], models: [unknownFit(message).result] } }
  }

  const combined = combineFits([fit.result])
  const detail = combined.verdict === 'does-not-fit' ? refusalDetail(combined) : undefined

  try {
    report(logger, input, fit, combined, detail)
  } catch {
    // A failing logger must not turn the check into a load failure.
  }

  return {
    probe: { verdict: combined.verdict, pools: combined.pools, models: [fit.result] },
    ...(detail !== undefined && { detail })
  }
}
