import type { TestDefinition } from '@qvac/test-suite'

export const imageEmbeddingTests: TestDefinition[] = [
  {
    testId: 'image-embedding-megaloc-mixed',
    params: {},
    // Original PyTorch cosine for the addon's deterministic 64x48 and 640x480 RGB fixtures
    // is 0.728993. Allow for mixed quantization and backend rounding.
    expectation: { validation: 'numeric-range', min: 0.719, max: 0.739 },
    metadata: {
      category: 'image-embedding',
      dependency: 'image-embedding',
      estimatedDurationMs: 15000
    }
  }
]
