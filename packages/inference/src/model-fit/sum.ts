import type { AddonFitDevice } from '@/model-fit/run/engine'
import type { ModelFitPool, ModelFitVerdict } from '@/schemas/assess-model-fit'

/**
 * The share of a pool's free memory a set of models may take. The rest absorbs
 * what the machine allocates between the check and the loads.
 */
export const USABLE_SHARE = 0.9

/** The pool of host memory: the host CPU's row and every GPU that shares it. */
export const HOST_POOL = 'host'

export interface ModelAnswer {
  status: ModelFitVerdict
  devices: readonly AddonFitDevice[]
}

export interface CombinedFit {
  verdict: ModelFitVerdict
  pools: ModelFitPool[]
}

function lowest(figures: readonly number[]): number | undefined {
  return figures.length > 0 ? Math.min(...figures) : undefined
}

/**
 * Sums what a set of models takes on each memory pool and judges the set
 * against what is free.
 *
 * A device joins the pool of its `id`, or the host pool when `unified`. A
 * pool's free and total memory are the lowest figures reported for it.
 *
 * A single model's verdict is its addon's own, which applies the engine's
 * margin. A set does not fit when any pool takes more than
 * `USABLE_SHARE` of its free memory or any model does not fit alone. Usage
 * known so far is a lower bound, so either holds whatever the unknown models
 * add. Otherwise the set is `unknown` when any model is unknown or any pool has
 * no free figure.
 */
export function combineFits(models: readonly ModelAnswer[]): CombinedFit {
  const totals = new Map<string, { usedBytes: number; free: number[]; total: number[] }>()

  for (const model of models) {
    for (const device of model.devices) {
      const key = device.unified ? HOST_POOL : device.id
      const pool = totals.get(key) ?? { usedBytes: 0, free: [], total: [] }
      pool.usedBytes += device.usedBytes
      if (device.freeBytes !== undefined) pool.free.push(device.freeBytes)
      if (device.totalBytes !== undefined) pool.total.push(device.totalBytes)
      totals.set(key, pool)
    }
  }

  const pools: ModelFitPool[] = [...totals].map(([id, { usedBytes, free, total }]) => {
    const freeBytes = lowest(free)
    const totalBytes = lowest(total)
    return {
      id,
      unified: id === HOST_POOL,
      usedBytes,
      ...(freeBytes !== undefined && { freeBytes }),
      ...(totalBytes !== undefined && { totalBytes })
    }
  })

  const [only] = models
  if (models.length === 1 && only !== undefined) return { verdict: only.status, pools }

  const over = pools.some(
    (pool) => pool.freeBytes !== undefined && pool.usedBytes > pool.freeBytes * USABLE_SHARE
  )
  if (over || models.some((model) => model.status === 'does-not-fit')) {
    return { verdict: 'does-not-fit', pools }
  }

  const unmeasured =
    models.some((model) => model.status === 'unknown') ||
    pools.some((pool) => pool.freeBytes === undefined)
  return { verdict: unmeasured ? 'unknown' : 'fits', pools }
}
