import type { TestDefinition } from '@qvac/test-suite'

export const modelInfoGet: TestDefinition = {
  testId: 'model-info-get',
  params: { modelConstant: 'LLAMA_3_2_1B_INST_Q4_0' },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'model-info', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const modelInfoVerifyFiles: TestDefinition = {
  testId: 'model-info-verify-files',
  params: { modelConstant: 'LLAMA_3_2_1B_INST_Q4_0' },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'model-info', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const modelInfoMultipleModels: TestDefinition = {
  testId: 'model-info-multiple-models',
  params: { models: ['LLAMA_3_2_1B_INST_Q4_0', 'GTE_LARGE_FP16'] },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'model-info', dependency: 'llm+embeddings', estimatedDurationMs: 10000 }
}

export const modelInfoPersistsAfterUnload: TestDefinition = {
  testId: 'model-info-persists-after-unload',
  params: { modelConstant: 'LLAMA_3_2_1B_INST_Q4_0' },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'model-info', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const modelInfoLoadedGet: TestDefinition = {
  testId: 'model-info-loaded-get',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'model-info', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const modelInfoLoadedNotFound: TestDefinition = {
  testId: 'model-info-loaded-not-found',
  params: { modelId: 'nonexistent-model-id-deadbeef' },
  expectation: { validation: 'throws-error', errorContains: 'not found' },
  suites: ['smoke'],
  metadata: { category: 'model-info', dependency: 'none', estimatedDurationMs: 2000 }
}

/**
 * Asserts that the advisory fit probe produced a verdict and the load completed
 * regardless of which verdict it was.
 *
 * Deliberately verdict-agnostic: `fit` vs `does-not-fit` is a property of the
 * runner's memory, not of the SDK — the same config measures `does-not-fit` on a
 * 24 GiB M4 Pro and `fit` on a 48 GiB one — so asserting a specific verdict
 * would be flaky by construction. What is machine-independent, and what the
 * fail-open contract actually claims, is that a verdict is recorded and the load
 * still succeeds.
 */
export const modelInfoFitProbe: TestDefinition = {
  testId: 'model-info-fit-probe',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'model-info', dependency: 'llm', estimatedDurationMs: 8000 }
}

export const modelInfoTests = [
  modelInfoGet,
  modelInfoVerifyFiles,
  modelInfoMultipleModels,
  modelInfoPersistsAfterUnload,
  modelInfoLoadedGet,
  modelInfoLoadedNotFound,
  modelInfoFitProbe
]
