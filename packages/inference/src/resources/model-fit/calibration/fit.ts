/**
 * The least-squares core of the calibration harness
 * (`scripts/calibrate-model-fit.ts`), kept in `src` so it is unit-testable —
 * the harness itself needs real model loads, but the arithmetic that turns
 * measurements into coefficients does not.
 *
 * The model is dictated by how llama.cpp actually allocates: everything is
 * built when the model loads — weights, KV cache, engine overhead, and the
 * context-scaled compute buffers — so a load's RSS delta is
 *
 *   persistent = ratio × artifactBytes + kv + fixed + perToken × context
 *
 * The KV term is computed exactly per point and subtracted before fitting, so
 * three unknowns remain: the weight-slack ratio, the fixed overhead, and the
 * per-token slope. Three models at two contexts each give six points for a
 * three-parameter plane; repeats add more.
 */

/** One measured load, with the KV cache the engine allocated for it. */
export interface CalibrationPoint {
  artifactBytes: number
  contextTokens: number
  /** KV-cache bytes for this shape and context, exactly determined. */
  kvBytes: number
  /** RSS delta across the load, after settle. */
  persistentBytes: number
}

/** Coefficients recovered from a set of calibration points. */
export interface ResidentFit {
  /** Marginal resident bytes per artifact byte. */
  weightRatio: number
  fixedBytes: number
  perTokenBytes: number
  /**
   * Largest amount any point sits above the fitted (and clamped) plane. An
   * upper bound that does not cover an observed point is not an upper bound,
   * so this floors the fixed-overhead upper bound.
   */
  worstExcessBytes: number
}

/**
 * Fits `persistent − kv = ratio × artifact + perToken × context + fixed` by
 * ordinary least squares.
 *
 * Negative solutions are clamped to zero — a physical coefficient cannot be
 * negative, and a slightly negative fit is measurement noise — but
 * `worstExcessBytes` is computed against the clamped plane, so the clamp can
 * only widen the eventual upper bound, never thin it.
 *
 * @returns The fit, or `undefined` when the points cannot determine three
 *   parameters (fewer than three points, or a degenerate design — e.g. a
 *   single model or a single context throughout).
 */
export function fitResidentMemory(points: readonly CalibrationPoint[]) {
  if (points.length < 3) return undefined

  // Normal equations for y = a·x1 + b·x2 + c.
  let s11 = 0
  let s12 = 0
  let s1 = 0
  let s22 = 0
  let s2 = 0
  let s1y = 0
  let s2y = 0
  let sy = 0
  const n = points.length

  for (const point of points) {
    const x1 = point.artifactBytes
    const x2 = point.contextTokens
    const y = point.persistentBytes - point.kvBytes
    s11 += x1 * x1
    s12 += x1 * x2
    s1 += x1
    s22 += x2 * x2
    s2 += x2
    s1y += x1 * y
    s2y += x2 * y
    sy += y
  }

  const solution = solve3(
    [
      [s11, s12, s1],
      [s12, s22, s2],
      [s1, s2, n]
    ],
    [s1y, s2y, sy]
  )
  if (!solution) return undefined

  const weightRatio = Math.max(0, solution[0])
  const perTokenBytes = Math.max(0, solution[1])
  const fixedBytes = Math.max(0, solution[2])

  let worstExcessBytes = 0
  for (const point of points) {
    const predicted =
      weightRatio * point.artifactBytes +
      perTokenBytes * point.contextTokens +
      fixedBytes +
      point.kvBytes
    worstExcessBytes = Math.max(worstExcessBytes, point.persistentBytes - predicted)
  }

  const fit: ResidentFit = { weightRatio, fixedBytes, perTokenBytes, worstExcessBytes }
  return fit
}

/** One model's KV growth between its smallest and largest context, computed vs observed. */
export interface KvGrowth {
  artifactBytes: number
  kvDeltaBytes: number
  observedDeltaBytes: number
}

/** Whether the counter behind the measurements sees allocation at all. */
export interface KvObservation {
  models: readonly KvGrowth[]
  /** Observed over computed growth; `1` when no model has two contexts. */
  ratio: number
}

/**
 * Checks the measurements against the one term the file sizes exactly: the KV
 * cache grows by a known amount between contexts, and compute buffers only add
 * to it. Growth below that means the wrong cache type was subtracted, or a
 * counter that misses allocation. Summed across models, repeats as medians so a
 * cold first load does not read as a shortfall.
 */
export function kvObservation(points: readonly CalibrationPoint[]): KvObservation {
  const byModel = new Map<number, CalibrationPoint[]>()
  for (const point of points) {
    const group = byModel.get(point.artifactBytes)
    if (group) group.push(point)
    else byModel.set(point.artifactBytes, [point])
  }

  const models: KvGrowth[] = []
  let kvDeltaTotal = 0
  let observedDeltaTotal = 0
  for (const [artifactBytes, group] of byModel) {
    const contexts = [...new Set(group.map((p) => p.contextTokens))].sort((a, b) => a - b)
    if (contexts.length < 2) continue
    const low = group.filter((p) => p.contextTokens === contexts[0])
    const high = group.filter((p) => p.contextTokens === contexts[contexts.length - 1])
    const kvDeltaBytes = high[0]!.kvBytes - low[0]!.kvBytes
    const observedDeltaBytes =
      median(high.map((p) => p.persistentBytes)) - median(low.map((p) => p.persistentBytes))
    models.push({ artifactBytes, kvDeltaBytes, observedDeltaBytes })
    kvDeltaTotal += kvDeltaBytes
    observedDeltaTotal += observedDeltaBytes
  }

  return { models, ratio: kvDeltaTotal > 0 ? observedDeltaTotal / kvDeltaTotal : 1 }
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Solves a 3×3 linear system by Gaussian elimination with partial pivoting.
 *
 * @returns The solution vector, or `undefined` when the matrix is singular —
 *   which for the normal equations means the measurement design cannot
 *   separate the three coefficients.
 */
function solve3(matrix: number[][], rhs: number[]) {
  const a = matrix.map((row, i) => [...row, rhs[i]!])

  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row
    }
    if (Math.abs(a[pivot]![col]!) < 1e-9) return undefined
    if (pivot !== col) {
      const swap = a[col]!
      a[col] = a[pivot]!
      a[pivot] = swap
    }
    for (let row = col + 1; row < 3; row++) {
      const factor = a[row]![col]! / a[col]![col]!
      for (let k = col; k <= 3; k++) a[row]![k] = a[row]![k]! - factor * a[col]![k]!
    }
  }

  const x = [0, 0, 0]
  for (let row = 2; row >= 0; row--) {
    let sum = a[row]![3]!
    for (let k = row + 1; k < 3; k++) sum -= a[row]![k]! * x[k]!
    x[row] = sum / a[row]![row]!
  }
  return x as [number, number, number]
}
