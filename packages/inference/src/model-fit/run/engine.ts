import type { ModelFitDevice, ModelFitModelResult } from '@/schemas/assess-model-fit'
import type { QvacPlugin } from '@/schemas/plugin'

/** One device a load uses, as every addon's `assessFit` reports it. */
export type AddonFitDevice = ModelFitDevice

/** The result every addon's `assessFit` returns. */
export type AddonFit = ModelFitModelResult

/** A request for the fitter of the plugin that owns `addonPackage`. */
export interface FitProbeRequest {
  addonPackage: string
  request: unknown
}

/**
 * Calls the request's addon fitter. Several plugins can share one addon, and
 * only those that expose its `assessFit` carry it.
 */
export async function callEngineFit(probe: FitProbeRequest): Promise<AddonFit> {
  const { getAllPlugins } = await import('@/plugins/registry')
  const plugin: QvacPlugin | undefined = getAllPlugins().find(
    (candidate) =>
      candidate.addonPackage === probe.addonPackage && candidate.assessFit !== undefined
  )

  if (plugin?.assessFit === undefined) {
    throw new TypeError(`no registered plugin exposes assessFit for ${probe.addonPackage}`)
  }

  return plugin.assessFit(probe.request as never)
}
