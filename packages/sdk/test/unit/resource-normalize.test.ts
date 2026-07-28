import test from 'brittle'
import {
  normalizeBooleanMetric,
  normalizeNonNegativeIntegerMetric,
  normalizeNonNegativeMetric,
  normalizePositiveIntegerMetric,
  normalizePositiveMetric,
  normalizeStringMetric,
  normalizeUtilizationMetric
} from '@/server/bare/resources/normalize'

const systemProvenance = {
  source: 'test-collector',
  scope: 'system' as const
}

test('normalizes valid values as supported metrics', (t) => {
  t.alike(normalizeNonNegativeMetric(0, systemProvenance), {
    status: 'supported',
    value: 0,
    provenance: systemProvenance
  })
  t.alike(normalizePositiveMetric(1, systemProvenance), {
    status: 'supported',
    value: 1,
    provenance: systemProvenance
  })
  t.alike(normalizeUtilizationMetric(1, systemProvenance), {
    status: 'supported',
    value: 1,
    provenance: systemProvenance
  })
  t.alike(normalizeStringMetric('Apple M4 Pro', systemProvenance), {
    status: 'supported',
    value: 'Apple M4 Pro',
    provenance: systemProvenance
  })
  t.alike(normalizeBooleanMetric(false, systemProvenance), {
    status: 'supported',
    value: false,
    provenance: systemProvenance
  })
})

test('normalizes absent values as unavailable', (t) => {
  t.alike(normalizeNonNegativeMetric(undefined, systemProvenance), {
    status: 'unavailable',
    reason: 'Metric is unavailable'
  })
  t.alike(normalizeStringMetric(null, systemProvenance), {
    status: 'unavailable',
    reason: 'Metric is unavailable'
  })
})

test('normalizes malformed and ambiguous values as unverified', (t) => {
  t.is(normalizeNonNegativeMetric(-1, systemProvenance).status, 'unverified')
  t.is(normalizeNonNegativeMetric(Number.NaN, systemProvenance).status, 'unverified')
  t.is(normalizePositiveMetric(0, systemProvenance).status, 'unverified')
  t.is(normalizeNonNegativeIntegerMetric(1.5, systemProvenance).status, 'unverified')
  t.is(normalizePositiveIntegerMetric(0, systemProvenance).status, 'unverified')
  t.is(normalizeUtilizationMetric(1.1, systemProvenance).status, 'unverified')
  t.is(normalizeStringMetric('', systemProvenance).status, 'unverified')
})
