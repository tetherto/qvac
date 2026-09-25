import type { Step, TestDefinition } from '@qvac/test-suite'

// ---- embedding plugin ----

/**
 * Loading a sharded model IS the test for most of this category: the shards
 * are assembled on the load path, so a model id coming back means assembly,
 * hash validation and detection all worked.
 */
const loadShardedSteps = (dependency: string): Step[] => [
  { useModel: { deps: [dependency], as: 'modelId' } },
  { assert: { on: '$modelId', use: 'expectation' } }
]

/**
 * Bodies that do more than load: inference over an assembled model, a batch,
 * a reload, the backward-compatibility path that loads an unsharded model, and
 * the missing-shard rejection.
 */
const SHARDED_MULTI_STEP = new Set([
  'sharded-model-backward-compatibility',
  'sharded-model-batch-inference',
  'sharded-model-inference',
  'sharded-model-long-text-inference',
  'sharded-model-llm-completion',
  'sharded-model-llm-reload',
  'sharded-model-llm-missing-shards'
])

/** One embedding over the assembled sharded model. */
const shardedEmbedSteps: Step[] = [
  { useModel: { deps: ['sharded-embeddings'], as: 'model' } },
  { call: { method: 'embed', params: { modelId: '$model', text: '$params.text' }, as: 'run' } },
  { project: { from: '$run', path: 'embedding', as: 'embedding' } },
  { assert: { on: '$embedding', use: 'expectation' } }
]

/** One completion over the assembled sharded LLM. */
const shardedCompletionSteps = (as: string): Step[] => [
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: '$params.history',
        generationParams: '$params.generationParams?',
        stream: false
      },
      as: `${as}Run`
    }
  },
  { project: { from: `$${as}Run`, path: 'text', as } },
  { assert: { on: `$${as}`, use: 'expectation' } }
]

export const shardedModelLoad: TestDefinition = {
  testId: 'sharded-model-load',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'sharded-model', dependency: 'none', estimatedDurationMs: 120000 }
}

export const shardedModelDetection: TestDefinition = {
  testId: 'sharded-model-detection',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-embeddings',
    estimatedDurationMs: 120000
  }
}

export const shardedModelHashValidation: TestDefinition = {
  testId: 'sharded-model-hash-validation',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-embeddings',
    estimatedDurationMs: 120000
  }
}

/**
 * The unsharded model still loads.
 *
 * The point is the load path's detection: an assembler that treated every
 * model as sharded would fail here and nowhere else, so what is asserted is
 * simply that a plain single-file model still comes back with an id.
 */
export const shardedModelBackwardCompatibility: TestDefinition = {
  testId: 'sharded-model-backward-compatibility',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { modelSource: { dep: 'embeddings', as: 'src' } },
    {
      call: {
        method: 'loadModel',
        params: { modelSrc: '$src.modelSrc', modelType: '$src.modelType' },
        as: 'loaded'
      }
    },
    { project: { from: '$loaded', path: 'modelId', as: 'modelId' } },
    { assert: { on: '$modelId', use: 'expectation' } }
  ],
  metadata: { category: 'sharded-model', dependency: 'none', estimatedDurationMs: 60000 }
}

export const shardedModelProgress: TestDefinition = {
  testId: 'sharded-model-progress',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-embeddings',
    estimatedDurationMs: 120000
  }
}

export const shardedModelResume: TestDefinition = {
  testId: 'sharded-model-resume',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-embeddings',
    estimatedDurationMs: 180000
  }
}

export const shardedModelCancellation: TestDefinition = {
  testId: 'sharded-model-cancellation',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-embeddings',
    estimatedDurationMs: 60000
  }
}

export const shardedModelInference: TestDefinition = {
  testId: 'sharded-model-inference',
  params: { text: 'This is a test sentence for embedding generation using a sharded model.' },
  expectation: { validation: 'type', expectedType: 'array' },
  suites: ['smoke'],
  steps: shardedEmbedSteps,
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-embeddings',
    estimatedDurationMs: 45000
  }
}

export const shardedModelBatchInference: TestDefinition = {
  testId: 'sharded-model-batch-inference',
  params: {
    texts: [
      'First test sentence for batch embedding.',
      'Second test sentence for batch embedding.',
      'Third test sentence for batch embedding.'
    ]
  },
  expectation: { validation: 'type', expectedType: 'array' },
  // One call per text, collected: the executor looped and pushed, which is a
  // `repeat` with the loop variable named.
  steps: [
    { useModel: { deps: ['sharded-embeddings'], as: 'model' } },
    {
      repeat: {
        over: '$params.texts',
        as: 'text',
        collectInto: 'embeddings',
        steps: [
          { call: { method: 'embed', params: { modelId: '$model', text: '$text' }, as: 'run' } },
          { project: { from: '$run', path: 'embedding', as: 'embedding' } }
        ]
      }
    },
    { assert: { on: '$embeddings', named: 'lengthIs', with: { length: 3 } } },
    { project: { from: '$embeddings', path: '[0]', as: 'first' } },
    { assert: { on: '$first', use: 'expectation' } }
  ],
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-embeddings',
    estimatedDurationMs: 60000
  }
}

export const shardedModelLongTextInference: TestDefinition = {
  testId: 'sharded-model-long-text-inference',
  params: { text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20) },
  expectation: { validation: 'type', expectedType: 'array' },
  steps: shardedEmbedSteps,
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-embeddings',
    estimatedDurationMs: 50000
  }
}

// ---- LLM plugin ----

export const shardedModelLlmLoad: TestDefinition = {
  testId: 'sharded-model-llm-load',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-llm',
    estimatedDurationMs: 180000
  }
}

export const shardedModelLlmCompletion: TestDefinition = {
  testId: 'sharded-model-llm-completion',
  params: {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }],
    generationParams: { temp: 0, seed: 42 }
  },
  expectation: { validation: 'contains-all', contains: ['4'] },
  steps: [
    { useModel: { deps: ['sharded-llm'], as: 'model' } },
    ...shardedCompletionSteps('answer')
  ],
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-llm',
    estimatedDurationMs: 60000
  }
}

export const shardedModelLlmReload: TestDefinition = {
  testId: 'sharded-model-llm-reload',
  params: {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }],
    generationParams: { temp: 0, seed: 42 }
  },
  expectation: { validation: 'contains-all', contains: ['4'] },
  // Answer, drop the model, answer again. The eviction goes through the
  // resource manager rather than `unloadModel`, so the second `useModel`
  // reassembles the shards instead of handing back an id the worker has
  // forgotten -- which is the whole thing being tested.
  steps: [
    { useModel: { deps: ['sharded-llm'], as: 'model' } },
    ...shardedCompletionSteps('before'),
    { call: { method: 'evictResource', params: { dep: 'sharded-llm' } } },
    { useModel: { deps: ['sharded-llm'], as: 'model' } },
    ...shardedCompletionSteps('after')
  ],
  metadata: {
    category: 'sharded-model',
    dependency: 'sharded-llm',
    estimatedDurationMs: 120000
  }
}

export const shardedModelLlmMissingShards: TestDefinition = {
  testId: 'sharded-model-llm-missing-shards',
  params: { modelPath: '/invalid/path/sharded-model-00001-of-00005.gguf' },
  expectation: { validation: 'throws-error', errorContains: 'Missing shards or' },
  steps: [
    {
      callError: {
        method: 'loadModel',
        params: { modelSrc: '$params.modelPath', modelType: 'llamacpp-completion' },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  metadata: {
    category: 'sharded-model',
    dependency: 'none',
    estimatedDurationMs: 5000
  }
}

export const shardedModelTests = [
  shardedModelLoad,
  shardedModelDetection,
  shardedModelHashValidation,
  shardedModelBackwardCompatibility,
  shardedModelProgress,
  shardedModelResume,
  shardedModelCancellation,
  shardedModelInference,
  shardedModelBatchInference,
  shardedModelLongTextInference,
  shardedModelLlmLoad,
  shardedModelLlmCompletion,
  shardedModelLlmReload,
  shardedModelLlmMissingShards
]

/**
 * Attach the load body to every definition that is only a load. The resource
 * key is what says which model -- the embedding shards or the LLM ones -- so
 * the body does not have to.
 */
for (const test of shardedModelTests) {
  if (test.steps || SHARDED_MULTI_STEP.has(test.testId)) continue
  const dependency = String(test.metadata?.dependency ?? 'sharded-embeddings')
  test.steps = loadShardedSteps(dependency === 'none' ? 'sharded-embeddings' : dependency)
}
