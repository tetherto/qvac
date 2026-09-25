import type { TestDefinition } from '@qvac/test-suite'

// Its own id prefix: the executor is node-only because it inspects the worker
// process, so neither the shared kv-cache executor nor the lifecycle one can
// claim it.
//
// Not migrated, and it cannot be. The claim is that the named cache's
// saved-message boundary outlives the worker *process*: the body reads the
// process table before, during and after a restart and asserts the child count
// each time, rather than assuming the restart happened. A step vocabulary that
// could express "count this client's child processes" would be describing one
// runtime's process model, which is the opposite of what the catalog is for --
// the same reason the `no-lingering-bare-*` tests carry the `imperative` suite
// tag and each client writes its own.
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
