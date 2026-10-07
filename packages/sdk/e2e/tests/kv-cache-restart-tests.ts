import type { TestDefinition } from '@qvac/test-suite'

// Its own id prefix: the executor is node-only because it inspects the worker
// process, so neither the shared kv-cache executor nor the lifecycle one can
// claim it.
export const kvCacheWorkerRestart: TestDefinition = {
  testId: 'worker-restart-kv-cache-boundary',
  params: {
    cacheKey: 'worker-restart-session',
    messages: [
      'List ten animals, one per line.',
      'What is the capital of France? Answer with just the city name.'
    ],
    expectedAnswerContains: 'Paris',
    generationParams: { temp: 0, top_k: 1, seed: 42, predict: 256 }
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: { category: 'lifecycle', dependency: 'llm', estimatedDurationMs: 90000 },
  skip: {
    reason: 'Bare worker process lifecycle is desktop-only (mobile uses an in-process Worklet)',
    platforms: ['mobile-ios', 'mobile-android']
  }
}

export const kvCacheRestartTests = [kvCacheWorkerRestart]
