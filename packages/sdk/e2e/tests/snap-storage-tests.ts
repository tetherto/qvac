import type { TestDefinition } from '@qvac/test-suite'

export const snapStorageTests: TestDefinition[] = [
  {
    testId: 'snap-storage-common-root',
    params: {},
    expectation: { validation: 'type', expectedType: 'string' },
    // Strict-confined Snap storage paths: a property of how the JS SDK is
    // distributed. No generated client has such a distribution.
    suites: ['snap', 'packaging'],
    metadata: {
      category: 'snap',
      dependency: 'none',
      estimatedDurationMs: 30_000
    }
  }
]
