import { parseServeConfig } from '@/serve/core/config'
import { loadModelConstants } from '@/serve/core/config/constants'
import { assessNamedModels, fitModelType, type ModelFitResponse } from '@/serve/core/fit'
import { settingsFor, type FitSettings } from '@/fit/settings'

type Model = ModelFitResponse['models'][number]

/** A catalog model judged on its own: its verdict, the pools it was judged on, and its rows. */
export interface CatalogVerdict {
  model: string
  verdict: 'fits' | 'does-not-fit'
  pools: ModelFitResponse['pools']
  devices: Model['devices']
  stats: Model['stats']
}

/** A catalog model with no verdict, and why: the SDK's reason, or the error it refused with. */
export interface CatalogMiss {
  model: string
  reason: string
  /** The SDK error code when the SDK refused the model, such as `MODEL_FIT_REJECTED`. */
  code?: string
}

export interface CatalogReport {
  object: 'model_fit_catalog'
  withVerdict: CatalogVerdict[]
  withoutVerdict: CatalogMiss[]
}

/** The SDK model constant names, in name order. */
export function catalogModels(): string[] {
  return [...loadModelConstants().keys()].sort()
}

/**
 * Judges every SDK model constant on its own, one at a time, with its engine
 * defaults and the settings that apply to it or its model type. A model the SDK refuses is listed
 * without a verdict, with the SDK's error. `serve.models` aliases take no part,
 * so an alias named like a constant never stands in for it.
 */
export async function assessCatalog(
  settings: FitSettings,
  onProgress: (done: number, total: number, model: string) => void = () => {},
  assess: typeof assessNamedModels = assessNamedModels
): Promise<CatalogReport> {
  const serveConfig = parseServeConfig({}, {})
  const models = catalogModels()
  const report: CatalogReport = { object: 'model_fit_catalog', withVerdict: [], withoutVerdict: [] }

  for (const [index, model] of models.entries()) {
    onProgress(index, models.length, model)
    try {
      const modelConfig = settingsFor(settings, model, fitModelType(serveConfig, model))
      const result = await assess(serveConfig, [{ model, modelConfig }])
      const [entry] = result.models
      if (result.verdict === 'unknown' || entry === undefined) {
        report.withoutVerdict.push({ model, reason: entry?.reason ?? 'no reason given' })
      } else {
        report.withVerdict.push({
          model,
          verdict: result.verdict,
          pools: result.pools,
          devices: entry.devices,
          stats: entry.stats
        })
      }
    } catch (err) {
      report.withoutVerdict.push({ model, ...describeError(err) })
    }
  }
  onProgress(models.length, models.length, '')
  return report
}

// An SDK error names its code in `name`, such as `MODEL_FIT_REJECTED`.
function describeError(err: unknown): Omit<CatalogMiss, 'model'> {
  if (!(err instanceof Error)) return { reason: String(err) }
  const coded = typeof (err as { code?: unknown }).code === 'number'
  return coded ? { reason: err.message, code: err.name } : { reason: err.message }
}
