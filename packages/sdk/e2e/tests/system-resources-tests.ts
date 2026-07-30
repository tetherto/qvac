import type { TestDefinition } from '@tetherto/qvac-test-suite'

export const systemResourcesCapabilities = {
  testId: 'system-resources-capabilities',
  params: { sample: false },
  expectation: {
    validation: 'contains-all',
    contains: ['capabilities valid', 'sample omitted']
  },
  metadata: {
    category: 'system-resources',
    dependency: 'none',
    estimatedDurationMs: 5_000
  }
} as const satisfies TestDefinition

export const systemResourcesSample = {
  testId: 'system-resources-sample',
  params: { sample: true },
  expectation: {
    validation: 'contains-all',
    contains: ['capabilities valid', 'sample valid']
  },
  metadata: {
    category: 'system-resources',
    dependency: 'none',
    estimatedDurationMs: 5_000
  }
} as const satisfies TestDefinition

export const systemResourcesInvalidInput = {
  testId: 'system-resources-invalid-input',
  params: { sample: 'invalid' },
  expectation: {
    validation: 'throws-error',
    errorContains: 'sample'
  },
  metadata: {
    category: 'system-resources',
    dependency: 'none',
    estimatedDurationMs: 5_000
  }
} as const satisfies TestDefinition

export const systemResourcesTests = [
  systemResourcesCapabilities,
  systemResourcesSample,
  systemResourcesInvalidInput
] as const
