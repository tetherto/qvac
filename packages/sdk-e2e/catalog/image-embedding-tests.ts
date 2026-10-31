import type { TestDefinition } from '@qvac/test-suite'

export const imageEmbeddingTests: TestDefinition[] = [
  { testId: 'image-embedding-input-empty', params: { bytes: [], field: 'image' } },
  {
    testId: 'image-embedding-input-partial-rgb',
    params: { bytes: [1, 2, 3], width: 1, field: 'width' }
  },
  {
    testId: 'image-embedding-input-short-rgb',
    params: { bytes: [1, 2], width: 1, height: 1, channels: 3, field: 'image' }
  }
].map((test) => ({
  ...test,
  expectation: { validation: 'throws-error', errorContains: test.params.field },
  metadata: { category: 'image-embedding', dependency: 'none', estimatedDurationMs: 1000 }
}))
