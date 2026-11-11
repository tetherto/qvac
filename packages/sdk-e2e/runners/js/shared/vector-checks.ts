function vector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(Number.isFinite)
}

function cosine(left: unknown, right: unknown): number | undefined {
  if (!vector(left) || !vector(right) || left.length !== right.length) return undefined
  const normA = Math.hypot(...left)
  const normB = Math.hypot(...right)
  if (!Number.isFinite(normA) || !Number.isFinite(normB) || normA === 0 || normB === 0)
    return undefined
  const similarity = left.reduce((dot, x, i) => dot + (x / normA) * (right[i]! / normB), 0)
  return Number.isFinite(similarity) ? similarity : undefined
}

/**
 * Every vector has `dimensions` finite entries and a squared norm within `tolerance` of 1. A bare
 * vector counts as a list of one.
 */
export function unitVectors(value: unknown, args: Record<string, unknown>) {
  const { dimensions, tolerance } = args
  if (
    !Number.isInteger(dimensions) ||
    Number(dimensions) <= 0 ||
    typeof tolerance !== 'number' ||
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    tolerance >= 1
  )
    return { passed: false, output: 'expected positive dimensions and a tolerance between 0 and 1' }
  const vectors = vector(value) ? [value] : value
  if (!Array.isArray(vectors) || vectors.length === 0)
    return { passed: false, output: 'expected a vector or a non-empty array of vectors' }
  for (const [index, item] of vectors.entries()) {
    if (!vector(item) || item.length !== dimensions)
      return { passed: false, output: `vector ${index}: expected ${dimensions} finite numbers` }
    const squaredNorm = item.reduce((sum, x) => sum + x * x, 0)
    if (!Number.isFinite(squaredNorm) || Math.abs(squaredNorm - 1) >= tolerance)
      return { passed: false, output: `vector ${index}: squared norm ${squaredNorm}` }
  }
  return { passed: true, output: `${vectors.length} unit vectors, ${dimensions} dimensions` }
}

/** The cosine similarity of the two vectors is at least `min`. */
export function cosineAtLeast(left: unknown, right: unknown, args: Record<string, unknown>) {
  const min = args.min
  if (typeof min !== 'number' || !Number.isFinite(min) || min < -1 || min > 1)
    return { passed: false, output: 'expected a cosine minimum between -1 and 1' }
  const similarity = cosine(left, right)
  if (similarity === undefined)
    return { passed: false, output: 'expected finite, nonzero vectors of the same length' }
  return { passed: similarity >= min, output: `cosine ${similarity}, minimum ${min}` }
}

/** The left vector is strictly closer by cosine to the right one than to `than`. */
export function moreSimilarThan(left: unknown, right: unknown, args: Record<string, unknown>) {
  const near = cosine(left, right)
  const far = cosine(left, args.than)
  if (near === undefined || far === undefined)
    return { passed: false, output: 'expected finite, nonzero vectors of the same length' }
  return { passed: near > far, output: `cosine to match ${near}, to other ${far}` }
}
