import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * A call that must reject, with its message checked against the expectation.
 *
 * Almost every test in this category is this shape. Writing it once is the
 * point of the vocabulary: the migrated definitions differ only in which call
 * they expect to fail, which is the only thing they ever differed in.
 */
const rejects = (
  method: string,
  params: Record<string, unknown>,
  options: { collect?: 'text' | 'events'; before?: Step[] } = {}
): Step[] => [
  ...(options.before ?? []),
  {
    callError: {
      method,
      params,
      ...(options.collect ? { collect: options.collect } : {}),
      as: 'err'
    }
  },
  { project: { from: '$err', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } }
]

/**
 * Out-of-range generation parameters are accepted, and that is the claim.
 *
 * The four definitions at the end of this file were written as `throws-error`
 * with `errorContains: ''`, and the executor validated the completion's *text*
 * against that expectation when the call succeeded. Every string contains the
 * empty string, so all four passed whether the SDK rejected the parameter or
 * happily generated from it -- they could not fail.
 *
 * Migrating them settled the question. The contract does not constrain these
 * values at all: `temp`, `top_p` and `predict` are plain numbers, and `predict`
 * documents `-1` and `-2` as meaningful sentinels, so a negative value is not
 * out of range by definition. Neither client rejects, and both forward the
 * parameter to the worker.
 *
 * So they assert what actually happens, under names that say it: the call is
 * accepted and produces a completion. A client that started refusing one of
 * these would fail here, which is the regression worth catching -- the old
 * shape caught nothing.
 */
const completesWith = (generationParams: Record<string, unknown>): Step[] => [
  { useModel: { deps: ['llm'], as: 'model' } },
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: '$params.history',
        stream: false,
        generationParams
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  { assert: { on: '$text', use: 'expectation' } }
]

const HISTORY = [{ role: 'user', content: 'Test' }]

export const errorInvalidModelId: TestDefinition = {
  testId: 'error-invalid-model-id',
  params: { modelId: 'nonexistent-model-id-12345', operation: 'embed', text: 'test text' },
  expectation: { validation: 'throws-error', errorContains: '' },
  suites: ['smoke'],
  steps: rejects('embed', { modelId: '$params.modelId', text: '$params.text' }),
  metadata: { category: 'error', dependency: 'embeddings', estimatedDurationMs: 5000 }
}

/**
 * Reads the SDK's exported error-code tables rather than calling anything.
 *
 * Left on the executor deliberately: there is no call to make, and the tables
 * are a property of one client's module surface, not of the shared contract.
 * A step vocabulary that could express "read this module constant" would be
 * expressing the JS package, which is the opposite of what it is for.
 */
export const errorInvalidResponseType: TestDefinition = {
  testId: 'error-invalid-response-type',
  params: { verifyErrorCodes: true },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'error', dependency: 'none', estimatedDurationMs: 2000 }
}

export const errorModelLoadFailed: TestDefinition = {
  testId: 'error-model-load-failed',
  params: { modelPath: '/invalid/path/to/model.gguf', modelType: 'llamacpp-completion' },
  expectation: { validation: 'throws-error', errorContains: '' },
  steps: rejects('loadModel', {
    modelSrc: '$params.modelPath',
    modelType: '$params.modelType'
  }),
  metadata: { category: 'error', dependency: 'none', estimatedDurationMs: 5000 }
}

export const errorDeleteCacheInvalidParams: TestDefinition = {
  testId: 'error-delete-cache-invalid-params',
  params: { invalidParams: true },
  expectation: { validation: 'throws-error', errorContains: '' },
  steps: rejects('deleteCache', {}),
  metadata: { category: 'error', dependency: 'none', estimatedDurationMs: 5000 }
}

/** See `errorInvalidResponseType`: a module-surface test, not a contract test. */
export const errorStructuredErrorCode: TestDefinition = {
  testId: 'error-structured-error-code',
  params: { verifyErrorCodes: true },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'error', dependency: 'none', estimatedDurationMs: 2000 }
}

export const errorChainingCause: TestDefinition = {
  testId: 'error-chaining-cause',
  params: {
    triggerChainedError: true,
    modelPath: '/invalid/nonexistent/path/model.gguf',
    modelType: 'llamacpp-completion'
  },
  expectation: { validation: 'throws-error', errorContains: '' },
  // The question is whether the rejection carries structure, so the named
  // assertion reads the binding rather than the message.
  steps: [
    {
      callError: {
        method: 'loadModel',
        params: { modelSrc: '$params.modelPath', modelType: '$params.modelType' },
        as: 'err'
      }
    },
    { assert: { on: '$err', named: 'errorIsStructured' } }
  ],
  metadata: { category: 'error', dependency: 'none', estimatedDurationMs: 5000 }
}

export const errorRagOperationFailed: TestDefinition = {
  testId: 'error-rag-operation-failed',
  params: {
    modelId: 'nonexistent-model',
    query: 'test query',
    documents: 'test content',
    workspace: 'test'
  },
  expectation: { validation: 'throws-error', errorContains: '' },
  suites: ['smoke'],
  steps: rejects('ragIngest', {
    modelId: '$params.modelId',
    documents: '$params.documents',
    workspace: '$params.workspace'
  }),
  metadata: { category: 'error', dependency: 'embeddings', estimatedDurationMs: 5000 }
}

export const errorTranscriptionFailed: TestDefinition = {
  testId: 'error-transcription-failed',
  params: { audioPath: '/nonexistent/audio/file.wav' },
  expectation: { validation: 'throws-error', errorContains: '' },
  steps: rejects(
    'transcribe',
    { modelId: '$model', audioChunk: '$params.audioPath' },
    { before: [{ useModel: { deps: ['whisper'], as: 'model' } }] }
  ),
  metadata: { category: 'error', dependency: 'whisper', estimatedDurationMs: 5000 }
}

export const completionNegativeTemperatureAccepted: TestDefinition = {
  testId: 'completion-negative-temperature-accepted',
  params: { history: HISTORY },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: completesWith({ temp: -0.5 }),
  metadata: { category: 'error', dependency: 'llm', estimatedDurationMs: 3000 }
}

export const completionExcessiveTemperatureAccepted: TestDefinition = {
  testId: 'completion-excessive-temperature-accepted',
  params: { history: HISTORY },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: completesWith({ temp: 3.0 }),
  metadata: { category: 'error', dependency: 'llm', estimatedDurationMs: 3000 }
}

export const completionInvalidTopPAccepted: TestDefinition = {
  testId: 'completion-invalid-topp-accepted',
  params: { history: HISTORY },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: completesWith({ top_p: 1.5 }),
  metadata: { category: 'error', dependency: 'llm', estimatedDurationMs: 3000 }
}

export const completionNegativeMaxTokensAccepted: TestDefinition = {
  testId: 'completion-negative-maxtokens-accepted',
  params: { history: HISTORY },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: completesWith({ predict: -10 }),
  metadata: { category: 'error', dependency: 'llm', estimatedDurationMs: 3000 }
}


export const errorEmbeddingEmptyInput: TestDefinition = {
  testId: 'error-embedding-empty-input',
  params: { text: ' ' },
  expectation: { validation: 'type', expectedType: 'array' },
  // The executor passed whether the SDK embedded whitespace or rejected it,
  // so it could not fail. The observed behaviour is that it embeds -- the same
  // thing `embed-empty-text` asserts -- so the migrated body asserts that, and
  // a change of behaviour now shows up instead of passing silently.
  steps: [
    { useModel: { deps: ['embeddings'], as: 'model' } },
    {
      call: { method: 'embed', params: { modelId: '$model', text: '$params.text' }, as: 'response' }
    },
    { project: { from: '$response', path: 'embedding', as: 'embedding' } },
    { assert: { on: '$embedding', use: 'expectation' } }
  ],
  metadata: { category: 'error', dependency: 'embeddings', estimatedDurationMs: 3000 }
}

export const errorUseUnloadedModel: TestDefinition = {
  testId: 'error-use-unloaded-model',
  params: {
    modelIdOverride: 'unloaded-model-id-12345',
    history: [{ role: 'user', content: 'Test' }],
    stream: false
  },
  expectation: { validation: 'throws-error', errorContains: '' },
  steps: rejects(
    'completion',
    {
      modelId: '$params.modelIdOverride',
      history: '$params.history',
      stream: '$params.stream'
    },
    { collect: 'text' }
  ),
  suites: ['smoke'],
  metadata: { category: 'error', dependency: 'llm', estimatedDurationMs: 3000 }
}

export const errorRagUnloadedModel: TestDefinition = {
  testId: 'error-rag-unloaded-model',
  params: {
    modelIdOverride: 'unloaded-embedding-model-xyz',
    documentFile: 'ocean_waves_poem.txt',
    chunkSize: 200,
    chunkOverlap: 50,
    documents: 'test',
    workspace: 'test'
  },
  expectation: { validation: 'throws-error', errorContains: '' },
  steps: rejects('ragIngest', {
    modelId: '$params.modelIdOverride',
    documents: '$params.documents',
    workspace: '$params.workspace'
  }),
  metadata: { category: 'error', dependency: 'embeddings', estimatedDurationMs: 3000 }
}

export const errorTests = [
  errorInvalidModelId,
  errorInvalidResponseType,
  errorModelLoadFailed,
  errorDeleteCacheInvalidParams,
  errorStructuredErrorCode,
  errorChainingCause,
  errorRagOperationFailed,
  errorTranscriptionFailed,
  completionNegativeTemperatureAccepted,
  completionExcessiveTemperatureAccepted,
  completionInvalidTopPAccepted,
  completionNegativeMaxTokensAccepted,
  errorEmbeddingEmptyInput,
  errorUseUnloadedModel,
  errorRagUnloadedModel
]
