import type { TestDefinition } from '@tetherto/qvac-test-suite'

export const snapStorageTests: TestDefinition[] = [
  {
    testId: 'snap-storage-common-root',
    params: {},
    expectation: { validation: 'type', expectedType: 'string' },
    suites: ['snap'],
    metadata: {
      category: 'snap',
      dependency: 'none',
      estimatedDurationMs: 30_000
    }
  }
]
