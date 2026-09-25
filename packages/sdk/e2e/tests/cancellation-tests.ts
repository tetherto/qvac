// Cancellation, and why this whole file stays on its executors.
//
// Every test here issues the cancel in a retry loop bounded by whether the
// operation has settled: a cancel that beats the request's registration
// matches nothing, so one well-timed attempt is a coin flip and the executors
// re-issue until the op settles or a deadline passes. Two things make that
// inexpressible as steps -- a loop whose condition is "has this promise
// settled yet", and the request id of a call that is still in flight, which
// `start` binds as an opaque handle rather than as data a step can name.
//
// `world-cancel-then-reload` is migrated and looks similar, but it is not: one
// broad cancel against a warm session is enough there, so it needs no loop and
// no id.
//
// These carry the `imperative` suite tag, like the `no-lingering-bare-*`
// tests: each client writes its own body, and the catalog says which tests
// those are.
import type { TestDefinition } from '@qvac/test-suite'

export const cancelMidStreamCompletion: TestDefinition = {
  testId: 'cancel-mid-stream-completion',
  params: {
    prompt: 'Tell me a long story about dragons, in many sentences.',
    cancelAfterTokens: 3
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'completion',
    dependency: 'llm',
    estimatedDurationMs: 20000
  }
}

export const cancelBeforeBeginCompletion: TestDefinition = {
  testId: 'cancel-before-begin-completion',
  params: {
    prompt: 'Write a paragraph about the history of cryptography.'
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'completion',
    dependency: 'llm',
    estimatedDurationMs: 20000
  }
}

export const cancelThenResumeKvCache: TestDefinition = {
  testId: 'cancel-then-resume-kv-cache',
  params: {
    cacheKey: 'cancel-then-resume-kvcache',
    firstUserMessage: 'Tell me a long story about wizards.',
    secondUserMessage: 'Repeat this word: banana',
    expectedAnswerContains: 'banana',
    cancelAfterTokens: 3
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'completion',
    dependency: 'llm',
    estimatedDurationMs: 30000
  }
}

export const cancelBroadEmbeddings: TestDefinition = {
  testId: 'cancel-broad-embeddings',
  params: {
    passageCount: 64,
    passageFiller:
      'machine learning natural language processing transformer architecture attention mechanism gradient descent ',
    passageFillerRepeats: 16,
    registryBeginGraceMs: 50,
    cancelRetryMs: 250,
    cancelDeadlineMs: 30000,
    settleTimeoutMs: 45000
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'cancellation',
    dependency: 'embeddings',
    estimatedDurationMs: 30000
  }
}

export const cancelBroadTranslateLlm: TestDefinition = {
  testId: 'cancel-broad-translate-llm',
  params: {
    text:
      'Write a long, detailed, multi-paragraph essay about the history of artificial intelligence. ' +
      'Include the early symbolic era, the AI winters, the deep-learning revival, and the rise of ' +
      'large language models in the 2020s. Be thorough and use complete paragraphs.',
    from: 'en',
    to: 'es',
    maxTokensAfterCancel: 30
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'cancellation',
    dependency: 'llm',
    estimatedDurationMs: 30000
  }
}

export const serializeConcurrentCompletion: TestDefinition = {
  testId: 'serialize-concurrent-completion',
  params: {
    prompt: 'Reply with one short sentence naming your favourite colour.'
  },
  expectation: { validation: 'function', fn: () => true },
  // Imperative for the same reason as its cancel-* neighbours: it issues
  // several completions at once and asserts how they are ordered, which is
  // where language runtimes differ and which the step vocabulary cannot say.
  suites: ['smoke', 'imperative'],
  metadata: {
    category: 'cancellation',
    dependency: 'llm',
    estimatedDurationMs: 30000
  }
}

export const cancelIsolatesConcurrentBatches: TestDefinition = {
  testId: 'cancel-isolates-concurrent-batches',
  params: {
    doomedPredict: 256,
    // Long survivor: it must still be decoding when the doomed cancel lands, so a
    // whole-model cancel can't pass this by killing only the still-live doomed
    // batch while an already-finished survivor stays successful.
    survivorPredict: 256
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'cancellation',
    dependency: 'llm-batch',
    estimatedDurationMs: 80000
  }
}

export const cancelQueuedNativeBatch: TestDefinition = {
  testId: 'cancel-queued-native-batch',
  params: {
    promptCount: 8,
    parallel: 4,
    predict: 256
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'cancellation',
    dependency: 'llm-batch',
    estimatedDurationMs: 30000
  }
}

export const cancelByRequestIdEmbed: TestDefinition = {
  testId: 'cancel-by-requestid-embed',
  params: {
    passageCount: 64,
    passageFiller:
      'machine learning natural language processing transformer architecture attention mechanism gradient descent ',
    passageFillerRepeats: 16,
    registryBeginGraceMs: 50,
    cancelRetryMs: 250,
    cancelDeadlineMs: 30000,
    settleTimeoutMs: 45000
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'cancellation',
    dependency: 'embeddings',
    estimatedDurationMs: 30000
  }
}

export const cancelByRequestIdTranscribe: TestDefinition = {
  testId: 'cancel-by-requestid-transcribe',
  params: {
    audioFileName: 'transcription-short-wav.wav'
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'cancellation',
    dependency: 'whisper',
    estimatedDurationMs: 30000
  }
}

export const cancelByRequestIdRagIngest: TestDefinition = {
  testId: 'cancel-by-requestid-rag-ingest',
  params: {
    workspaceBase: 'cancel-by-requestid',
    documentFiller:
      'The quick brown fox jumps over the lazy dog. Machine learning is a subset of artificial intelligence that enables computers to learn from data. Natural language processing combines linguistics and computer science to enable computers to understand human language. ',
    documentFillerRepeats: 100,
    chunkSize: 256,
    chunkOverlap: 32,
    registryBeginGraceMs: 200
  },
  expectation: { validation: 'function', fn: () => true },
  suites: ['imperative'],
  metadata: {
    category: 'cancellation',
    dependency: 'embeddings',
    estimatedDurationMs: 30000
  }
}

export const cancellationTests = [
  cancelMidStreamCompletion,
  cancelBeforeBeginCompletion,
  cancelThenResumeKvCache,
  cancelBroadEmbeddings,
  cancelBroadTranslateLlm,
  serializeConcurrentCompletion,
  cancelIsolatesConcurrentBatches,
  cancelQueuedNativeBatch,
  cancelByRequestIdEmbed,
  cancelByRequestIdTranscribe,
  cancelByRequestIdRagIngest
]

/**
 * Not runnable on the Python client yet.
 *
 * A skip rather than an `incomplete`, decided deliberately: these are the
 * definitions the step vocabulary cannot express, so they would otherwise sit
 * in the Python column as debt with no owner and no date. The reason travels
 * with the rule, which is what keeps the skip auditable -- and they become
 * runnable the moment the per-client imperative bodies are written.
 *
 * Only definitions with no declarative body are skipped; anything already
 * migrated runs on Python like everywhere else.
 */
for (const test of cancellationTests) {
  if (test.steps || test.skip) continue
  test.skip = {
    reason:
      'the Python client has no body for this: it cancels a generation mid-flight, and the vocabulary has no way to start a call without awaiting it, so the Python client needs a hand-written body before this can run there',
    platforms: ['desktop-python']
  }
}
