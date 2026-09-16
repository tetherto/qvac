import type { TestDefinition } from '@qvac/test-suite'

/**
 * A share count no CI runner — or any realistic host — can match, so the addon
 * can match it against neither the registered GPU count nor the eligible device
 * count whatever the leg is running on. Kept well above the largest plausible
 * multi-GPU host so the test stays host-agnostic.
 */
const IMPOSSIBLE_TENSOR_SPLIT = '1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1'

export const multiGpuConfigSmoke: TestDefinition = {
  testId: 'multi-gpu-config-smoke',
  params: {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }]
  },
  expectation: { validation: 'contains-all', contains: ['4'] },
  suites: ['smoke'],
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
  metadata: {
    category: 'multi-gpu',
    dependency: 'none',
    estimatedDurationMs: 30000
  }
}

/**
 * A `tensor-split` sized to the host must be accepted and still run on the GPU.
 * The executor derives the size at runtime — no literal is valid across a fleet
 * with both single-GPU and multi-GPU runners — using `probeTensorSplit` to ask
 * the addon for its device counts first. Where the two counts differ, both the
 * per-eligible-device and the per-registered-GPU form are exercised.
 */
export const multiGpuTensorSplitAppliedSmoke: TestDefinition = {
  testId: 'multi-gpu-tensor-split-applied-smoke',
  params: {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }],
    probeTensorSplit: IMPOSSIBLE_TENSOR_SPLIT
  },
  expectation: { validation: 'contains-all', contains: ['4'] },
  suites: ['smoke'],
  metadata: {
    category: 'multi-gpu',
    dependency: 'none',
    estimatedDurationMs: 90000
  }
}

/**
 * A `tensor-split` whose share count matches neither the registered GPU count
 * nor the eligible device count must be rejected, not padded or truncated.
 * Padding leaves a participating GPU with no layers and truncating drops a
 * GPU's share, both silently — see packages/llm-llamacpp/docs/multi-gpu.md.
 *
 * This is the assertion whose absence let a hardcoded two-GPU share list sit
 * green on single-GPU runners until the addon started enforcing the count.
 */
export const multiGpuTensorSplitMismatchError: TestDefinition = {
  testId: 'multi-gpu-tensor-split-mismatch-error',
  params: {
    tensorSplit: IMPOSSIBLE_TENSOR_SPLIT
  },
  expectation: { validation: 'throws-error', errorContains: 'matches neither' },
  suites: ['smoke'],
  metadata: {
    category: 'multi-gpu',
    dependency: 'none',
    estimatedDurationMs: 15000
  }
}

export const multiGpuTests = [
  multiGpuConfigSmoke,
  multiGpuTensorConfigSmoke,
  multiGpuEmbedConfigSmoke,
  multiGpuTensorSplitAppliedSmoke,
  multiGpuTensorSplitMismatchError
]
