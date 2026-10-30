import type { TestDefinition } from '@qvac/test-suite'

// Compared on the same device; no checkpoint-specific vector values are assumed.
export const embeddingGemma2Tests: TestDefinition[] = [
  'image-retrieval',
  'audio-deterministic',
  'text-parity',
  'reject-corrupt-media',
  'concurrent',
  'cancel'
].map((name) => ({
  testId: `embeddinggemma2-${name}`,
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'embedding', dependency: 'embeddinggemma2', estimatedDurationMs: 60000 }
}))
