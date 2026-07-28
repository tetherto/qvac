import type { ResourceMetric, ResourceProvenance } from '@/server/bare/resources/types'

const UNAVAILABLE_REASON = 'Metric is unavailable'
const UNVERIFIED_REASON = 'Metric value could not be verified'

export function unavailableMetric<T>(reason = UNAVAILABLE_REASON): ResourceMetric<T> {
  return { status: 'unavailable', reason }
}

export function unverifiedMetric<T>(reason = UNVERIFIED_REASON): ResourceMetric<T> {
  return { status: 'unverified', reason }
}

export function failedMetric<T>(reason: string): ResourceMetric<T> {
  return { status: 'failed', reason }
}

export function normalizeNonNegativeMetric(
  value: unknown,
  provenance: ResourceProvenance
): ResourceMetric<number> {
  if (value === undefined || value === null) return unavailableMetric()
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return unverifiedMetric()
  }

  return { status: 'supported', value, provenance }
}

export function normalizePositiveMetric(
  value: unknown,
  provenance: ResourceProvenance
): ResourceMetric<number> {
  const metric = normalizeNonNegativeMetric(value, provenance)
  if (metric.status !== 'supported') return metric
  if (metric.value === 0) return unverifiedMetric()

  return metric
}

export function normalizeNonNegativeIntegerMetric(
  value: unknown,
  provenance: ResourceProvenance
): ResourceMetric<number> {
  const metric = normalizeNonNegativeMetric(value, provenance)
  if (metric.status !== 'supported') return metric
  if (!Number.isInteger(metric.value)) return unverifiedMetric()

  return metric
}

export function normalizePositiveIntegerMetric(
  value: unknown,
  provenance: ResourceProvenance
): ResourceMetric<number> {
  const metric = normalizePositiveMetric(value, provenance)
  if (metric.status !== 'supported') return metric
  if (!Number.isInteger(metric.value)) return unverifiedMetric()

  return metric
}

export function normalizeUtilizationMetric(
  value: unknown,
  provenance: ResourceProvenance
): ResourceMetric<number> {
  const metric = normalizeNonNegativeMetric(value, provenance)
  if (metric.status !== 'supported') return metric
  if (metric.value > 1) return unverifiedMetric()

  return metric
}

export function normalizeEnumMetric(
  value: unknown,
  allowedValues: readonly number[],
  provenance: ResourceProvenance
): ResourceMetric<number> {
  if (value === undefined || value === null) return unavailableMetric()
  if (typeof value !== 'number' || !Number.isInteger(value) || !allowedValues.includes(value)) {
    return unverifiedMetric()
  }

  return { status: 'supported', value, provenance }
}

export function normalizeStringMetric(
  value: unknown,
  provenance: ResourceProvenance
): ResourceMetric<string> {
  if (value === undefined || value === null) return unavailableMetric()
  if (typeof value !== 'string' || value.length === 0) return unverifiedMetric()

  return { status: 'supported', value, provenance }
}

export function normalizeBooleanMetric(
  value: unknown,
  provenance: ResourceProvenance
): ResourceMetric<boolean> {
  if (value === undefined || value === null) return unavailableMetric()
  if (typeof value !== 'boolean') return unverifiedMetric()

  return { status: 'supported', value, provenance }
}
