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

interface PoolSum extends ModelFitPool {
  /** How many rows the pool holds. */
  rows: number
}

interface PoolTally {
  usedBytes: number
  rows: number
  free: number[]
  total: number[]
}

function lowest(figures: readonly number[]): number | undefined {
  return figures.length > 0 ? Math.min(...figures) : undefined
}

function isOver(pool: ModelFitPool): boolean {
  return pool.freeBytes !== undefined && pool.usedBytes > pool.freeBytes * USABLE_SHARE
}

/**
 * Sums rows into memory pools. A device joins the pool of its `id`, or the host
 * pool when `unified`. A pool's free and total memory are the lowest figures
 * reported for it.
 */
function sumPools(devices: readonly AddonFitDevice[]): PoolSum[] {
  const totals = new Map<string, PoolTally>()
  for (const device of devices) {
    const key = device.unified ? HOST_POOL : device.id
    const pool = totals.get(key) ?? { usedBytes: 0, rows: 0, free: [], total: [] }
    pool.usedBytes += device.usedBytes
    pool.rows += 1
    if (device.freeBytes !== undefined) pool.free.push(device.freeBytes)
    if (device.totalBytes !== undefined) pool.total.push(device.totalBytes)
    totals.set(key, pool)
  }

  return [...totals].map(([id, { usedBytes, rows, free, total }]) => {
    const freeBytes = lowest(free)
    const totalBytes = lowest(total)
    return {
      id,
      unified: id === HOST_POOL,
      usedBytes,
      rows,
      ...(freeBytes !== undefined && { freeBytes }),
      ...(totalBytes !== undefined && { totalBytes })
    }
  })
}

/**
 * One model's verdict alone. An addon judges each device apart with its
 * engine's margin, so a model whose rows share one pool, such as a Metal GPU
 * and the CPU drawing on the host's memory, can fit each device and still
 * overflow the pool. Such a model does not fit when the shared pool takes more
 * than `USABLE_SHARE` of its free memory. A row alone in its pool keeps the
 * addon's answer.
 */
export function judgeAlone(model: ModelAnswer): ModelFitVerdict {
  if (model.status !== 'fits') return model.status
  const shared = sumPools(model.devices).filter((pool) => pool.rows > 1)
  return shared.some(isOver) ? 'does-not-fit' : 'fits'
}

/**
 * Sums what a set of models takes on each memory pool and judges the set
 * against what is free. Each model's `status` is its verdict alone, from
 * `judgeAlone`.
 *
 * One model's verdict is its `status`. A set does not fit when any pool takes
 * more than `USABLE_SHARE` of its free memory or any model does not fit alone.
 * Usage known so far is a lower bound, so either holds whatever the unknown
 * models add. Otherwise the set is `unknown` when any model is unknown or any
 * pool has no free figure.
 */
export function combineFits(models: readonly ModelAnswer[]): CombinedFit {
  const pools: ModelFitPool[] = sumPools(models.flatMap((model) => model.devices)).map(
    ({ rows: _rows, ...pool }) => pool
  )

  const [only] = models
  if (models.length === 1 && only !== undefined) return { verdict: only.status, pools }

  if (pools.some(isOver) || models.some((model) => model.status === 'does-not-fit')) {
    return { verdict: 'does-not-fit', pools }
  }

  const unmeasured =
    models.some((model) => model.status === 'unknown') ||
    pools.some((pool) => pool.freeBytes === undefined)
  return { verdict: unmeasured ? 'unknown' : 'fits', pools }
}
