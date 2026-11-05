import type { TestDefinition } from '@qvac/test-suite'

const reportsCpu = (
  suffix: string,
  operation: 'completion' | 'embed' | 'batch',
  resourceKey: string,
  stream = false
): TestDefinition => ({
  testId: `backend-name-${suffix}`,
  params: { operation, resourceKey, stream },
  expectation: { validation: 'regex', pattern: '^cpu$' },
  metadata: {
    category: 'backend-name',
    dependency: resourceKey,
    estimatedDurationMs: 30000
  }
})

export const backendNameTests: TestDefinition[] = [
  {
    testId: 'backend-name-completion-auto',
    params: { operation: 'completion', resourceKey: 'llm', stream: true },
    expectation: {
      validation: 'regex',
      pattern: '^(cpu|cuda|metal|vulkan|opencl|rpc)(,(cuda|metal|vulkan|opencl|rpc))*$'
    },
    metadata: { category: 'backend-name', dependency: 'llm', estimatedDurationMs: 30000 }
  },
  reportsCpu('completion-cpu', 'completion', 'backend-name-llm-cpu'),
  reportsCpu('completion-stream-cpu', 'completion', 'backend-name-llm-cpu', true),
  reportsCpu('completion-zero-offload', 'completion', 'backend-name-llm-zero-offload'),
  reportsCpu('batch-stream-cpu', 'batch', 'backend-name-llm-cpu', true),
  reportsCpu('embed-cpu', 'embed', 'backend-name-embed-cpu'),
  reportsCpu('embed-zero-offload', 'embed', 'backend-name-embed-zero-offload'),
  {
    testId: 'backend-name-invalid-priority',
    params: { operation: 'invalid' },
    expectation: { validation: 'throws-error', errorContains: '50010' },
    metadata: {
      category: 'backend-name',
      dependency: 'none',
      dependencies: ['llm'],
      estimatedDurationMs: 5000
    }
  }
]
