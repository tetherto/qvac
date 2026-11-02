import type { Step, TestDefinition } from '@qvac/test-suite'

/** A call that must reject, with its message checked against the expectation. */
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
  { assert: { on: '$message', named: 'nonEmptyText' } }
]

/**
 * Out-of-range generation parameters are accepted, and that is the claim.
 *
 * Keep the `error-` prefix and the parameter in `params`: that is how a
 * consumer without step bindings routes a definition to an executor.
 */
const completesWithGenerationParams: Step[] = [
  { useModel: { deps: ['llm'], as: 'model' } },
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: '$params.history',
        stream: false,
        generationParams: '$params.generationParams'
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

/** Reads the SDK's exported error-code tables rather than calling anything. */
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
  // The question is whether the rejection carries structure, so the named assertion reads the
  // binding rather than the message.
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
  testId: 'error-completion-negative-temperature-accepted',
  params: { history: HISTORY, generationParams: { temp: -0.5 } },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: completesWithGenerationParams,
  metadata: { category: 'error', dependency: 'llm', estimatedDurationMs: 3000 }
}

export const completionExcessiveTemperatureAccepted: TestDefinition = {
  testId: 'error-completion-excessive-temperature-accepted',
  params: { history: HISTORY, generationParams: { temp: 3.0 } },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: completesWithGenerationParams,
  metadata: { category: 'error', dependency: 'llm', estimatedDurationMs: 3000 }
}

export const completionInvalidTopPAccepted: TestDefinition = {
  testId: 'error-completion-invalid-topp-accepted',
  params: { history: HISTORY, generationParams: { top_p: 1.5 } },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: completesWithGenerationParams,
  metadata: { category: 'error', dependency: 'llm', estimatedDurationMs: 3000 }
}

export const completionNegativeMaxTokensAccepted: TestDefinition = {
  testId: 'error-completion-negative-maxtokens-accepted',
  params: { history: HISTORY, generationParams: { predict: -10 } },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: completesWithGenerationParams,
  metadata: { category: 'error', dependency: 'llm', estimatedDurationMs: 3000 }
}

export const errorEmbeddingEmptyInput: TestDefinition = {
  testId: 'error-embedding-empty-input',
  params: { text: ' ' },
  expectation: { validation: 'type', expectedType: 'array' },
  // The executor passed whether the SDK embedded whitespace or rejected it, so it could not fail.
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
