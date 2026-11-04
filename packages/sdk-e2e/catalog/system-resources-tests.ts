import type { TestDefinition } from '@qvac/test-suite'

export const systemResourcesCapabilities = {
  testId: 'system-resources-capabilities',
  params: { sample: false },
  expectation: {
    validation: 'contains-all',
    contains: ['capabilities valid', 'sample omitted']
  },
  steps: [
    { call: { method: 'getSystemResources', params: { sample: '$params.sample' }, as: 'res' } },
    { assert: { on: '$res', named: 'systemResourcesShape', with: { sample: false } } }
  ],
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
  steps: [
    { call: { method: 'getSystemResources', params: { sample: '$params.sample' }, as: 'res' } },
    { assert: { on: '$res', named: 'systemResourcesShape', with: { sample: true } } }
  ],
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
  steps: [
    {
      callError: {
        method: 'getSystemResources',
        params: { sample: '$params.sample' },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
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
