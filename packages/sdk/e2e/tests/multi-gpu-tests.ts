import type { TestDefinition } from '@qvac/test-suite'

const multiGpuSkip =
  process.env.QVAC_HAS_MULTI_GPU === '1'
    ? undefined
    : {
        reason: 'Requires a runner with at least two eligible GPUs',
        issue: 'QVAC-24821'
      }

export const multiGpuConfigSmoke: TestDefinition = {
  testId: 'multi-gpu-config-smoke',
  params: {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }]
  },
  expectation: { validation: 'contains-all', contains: ['4'] },
  suites: ['smoke'],
  skip: multiGpuSkip,
  metadata: {
    category: 'multi-gpu',
    dependency: 'none',
    estimatedDurationMs: 30000
  }
}

export const multiGpuTensorConfigSmoke: TestDefinition = {
  testId: 'multi-gpu-tensor-config-smoke',
  params: {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }]
  },
  expectation: { validation: 'contains-all', contains: ['4'] },
  suites: ['smoke'],
  skip: multiGpuSkip,
  metadata: {
    category: 'multi-gpu',
    dependency: 'none',
    estimatedDurationMs: 30000
  }
}

export const multiGpuEmbedConfigSmoke: TestDefinition = {
  testId: 'multi-gpu-embed-config-smoke',
  params: {
    text: 'Multi-GPU embedding splits layers across all available GPUs.'
  },
  expectation: { validation: 'type', expectedType: 'array' },
  suites: ['smoke'],
  skip: multiGpuSkip,
  metadata: {
    category: 'multi-gpu',
    dependency: 'none',
    estimatedDurationMs: 30000
  }
}

export const multiGpuTests = [
  multiGpuConfigSmoke,
  multiGpuTensorConfigSmoke,
  multiGpuEmbedConfigSmoke
]
