// Caller sessions on one runtime: scoped cancellation, model leases and owner-only shutdown.
// Imperative, like the cancel-* suite: each test drives several sessions at once and asserts
// how their requests and leases interleave, which the step vocabulary cannot say.
import type { TestDefinition } from '@qvac/test-suite'

export const sessionCancelIsScopedToOwnSession: TestDefinition = {
  testId: 'session-cancel-scoped-to-own-session',
  params: {
    prompt: 'Tell me a long story about dragons, in many sentences.',
    cancelAfterTokens: 3
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    dependency: 'llm',
    estimatedDurationMs: 30000
  }
}

export const sessionSharedModelSurvivesUnload: TestDefinition = {
  testId: 'session-shared-model-survives-unload',
  params: {
    prompt: 'Reply with only the word APPLE.',
    expectedAnswerContains: 'APPLE'
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    dependency: 'llm',
    estimatedDurationMs: 30000
  }
}

export const sessionCloseReleasesLeases: TestDefinition = {
  testId: 'session-close-releases-leases',
  params: {
    prompt: 'Reply with only the word PEAR.',
    expectedAnswerContains: 'PEAR'
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    dependency: 'llm',
    estimatedDurationMs: 30000
  }
}

export const sessionCloseCancelsInFlightRequests: TestDefinition = {
  testId: 'session-close-cancels-in-flight',
  params: {
    prompt: 'Tell me a long story about wizards, in many sentences.',
    cancelAfterTokens: 3
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    dependency: 'llm',
    estimatedDurationMs: 30000
  }
}

export const sessionDuplicateRequestIdsAcrossSessions: TestDefinition = {
  testId: 'session-duplicate-request-ids-across-sessions',
  params: {
    text: 'Sessions keep their own request namespaces.'
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    dependency: 'embeddings',
    estimatedDurationMs: 20000
  }
}

export const sessionCalledAfterCloseIsRefused: TestDefinition = {
  testId: 'session-called-after-close-is-refused',
  params: {},
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    estimatedDurationMs: 5000
  }
}

export const sessionModelCancelIsScoped: TestDefinition = {
  testId: 'session-model-cancel-scoped',
  params: {
    prompt: 'Tell me a long story about sailors, in many sentences.',
    cancelAfterTokens: 3
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    dependency: 'llm',
    estimatedDurationMs: 60000
  }
}

export const sessionDiffusionSharedModel: TestDefinition = {
  testId: 'session-diffusion-shared-model',
  params: {
    prompt: 'a solid red square on white background',
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    dependency: 'diffusion',
    estimatedDurationMs: 300000
  }
}

export const sessionConfigHashSeparatesModels: TestDefinition = {
  testId: 'session-config-hash-separates-models',
  params: {
    prompt: 'Reply with only the word PLUM.',
    expectedAnswerContains: 'PLUM',
    smallContextDependency: 'llm-small-ctx'
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    dependency: 'llm',
    estimatedDurationMs: 60000
  }
}

export const sessionReloadRefusedWhileLeased: TestDefinition = {
  testId: 'session-reload-refused-while-leased',
  params: {
    dependency: 'whisper',
    modelType: 'whispercpp-transcription',
    reloadConfig: { language: 'en' }
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    estimatedDurationMs: 30000
  }
}

export const sessionLastLeaseUnloadKeepsRuntime: TestDefinition = {
  testId: 'session-last-lease-unload-keeps-runtime',
  params: {
    dependency: 'embeddings'
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'session',
    estimatedDurationMs: 30000
  }
}

export const sessionTests = [
  sessionCancelIsScopedToOwnSession,
  sessionSharedModelSurvivesUnload,
  sessionCloseReleasesLeases,
  sessionCloseCancelsInFlightRequests,
  sessionDuplicateRequestIdsAcrossSessions,
  sessionCalledAfterCloseIsRefused,
  sessionModelCancelIsScoped,
  sessionDiffusionSharedModel,
  sessionConfigHashSeparatesModels,
  sessionReloadRefusedWhileLeased,
  sessionLastLeaseUnloadKeepsRuntime
]
