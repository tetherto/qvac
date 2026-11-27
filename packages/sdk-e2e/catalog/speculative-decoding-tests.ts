import type { Step, TestDefinition } from '@qvac/test-suite'

const PLANETS_PROMPT =
  'List the planets of the solar system in order from the Sun, comma separated.'

/** Loads `dep` with the given speculative config, then runs one greedy completion. */
const completesWith = (
  modelConfig: Record<string, unknown>,
  dep = 'llm-mtp',
  sources: Step[] = []
): Step[] => [
  { modelSource: { dep, as: 'src' } },
  ...sources,
  {
    call: {
      method: 'loadModel',
      params: { modelSrc: '$src.modelSrc', modelType: '$src.modelType', modelConfig },
      as: 'loaded'
    }
  },
  { project: { from: '$loaded', path: 'modelId', as: 'model' } },
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: [{ role: 'user', content: '$params.prompt' }],
        stream: false,
        generationParams: { temperature: 0, seed: 42, predict: 96, reasoningBudget: 0 }
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  { assert: { on: '$text', use: 'expectation' } },
  { project: { from: '$run', path: 'stats', as: 'stats' } }
]

const unloads: Step[] = [{ call: { method: 'unloadModel', params: { modelId: '$model?' } } }]

export const speculativeDecodingMtp: TestDefinition = {
  testId: 'speculative-decoding-mtp',
  params: { prompt: PLANETS_PROMPT },
  expectation: { validation: 'contains-all', contains: ['Mercury', 'Venus', 'Earth'] },
  suites: ['smoke'],
  steps: [
    ...completesWith({ ctxSize: 2048, specType: 'draft-mtp' }),
    { project: { from: '$stats', path: 'draftTokens', as: 'draftTokens' } },
    { assert: { on: '$draftTokens', named: 'atLeast', with: { value: 1 } } },
    {
      assert: {
        on: '$stats',
        named: 'atLeastField',
        with: { field: 'draftTokens', atLeast: 'draftAcceptedTokens' }
      }
    }
  ],
  finally: unloads,
  metadata: {
    category: 'speculative-decoding',
    dependency: 'none',
    dependencies: ['llm-mtp'],
    estimatedDurationMs: 300000
  }
}

export const speculativeDecodingMtpExternalHead: TestDefinition = {
  testId: 'speculative-decoding-mtp-external-head',
  params: { prompt: PLANETS_PROMPT },
  expectation: { validation: 'contains-all', contains: ['Mercury', 'Venus', 'Earth'] },
  steps: [
    // The base model has no MTP layers; the MTP model's head drafts for it.
    ...completesWith(
      { ctxSize: 2048, specType: 'draft-mtp', draftModelSrc: '$head.modelSrc' },
      'llm-no-mtp',
      [{ modelSource: { dep: 'llm-mtp', as: 'head' } }]
    ),
    { project: { from: '$stats', path: 'draftTokens', as: 'draftTokens' } },
    { assert: { on: '$draftTokens', named: 'atLeast', with: { value: 1 } } },
    {
      assert: {
        on: '$stats',
        named: 'atLeastField',
        with: { field: 'draftTokens', atLeast: 'draftAcceptedTokens' }
      }
    }
  ],
  finally: unloads,
  metadata: {
    category: 'speculative-decoding',
    dependency: 'none',
    dependencies: ['llm-no-mtp', 'llm-mtp'],
    estimatedDurationMs: 300000
  }
}

export const speculativeDecodingNone: TestDefinition = {
  testId: 'speculative-decoding-none',
  params: { prompt: PLANETS_PROMPT },
  expectation: { validation: 'contains-all', contains: ['Mercury', 'Venus', 'Earth'] },
  steps: [
    ...completesWith({ ctxSize: 2048, specType: 'none' }),
    {
      assert: {
        on: '$stats',
        named: 'fieldsAbsent',
        with: { fields: ['draftTokens', 'draftAcceptedTokens'] }
      }
    }
  ],
  finally: unloads,
  metadata: {
    category: 'speculative-decoding',
    dependency: 'none',
    dependencies: ['llm-mtp'],
    estimatedDurationMs: 300000
  }
}

export const speculativeDecodingDraftNMaxOutOfRangeRejected: TestDefinition = {
  testId: 'speculative-decoding-draft-n-max-out-of-range-rejected',
  params: { draftNMax: 65 },
  expectation: { validation: 'throws-error', errorContains: 'specDraftNMax' },
  steps: [
    { modelSource: { dep: 'llm-mtp', as: 'src' } },
    {
      callError: {
        method: 'loadModel',
        params: {
          modelSrc: '$src.modelSrc',
          modelType: '$src.modelType',
          modelConfig: { specType: 'draft-mtp', specDraftNMax: '$params.draftNMax' }
        },
        as: 'err'
      }
    },
    // SDK validation names the field: the JS worker with code 50010, the Python client before
    // the request is sent. The addon's own range error would mean the value skipped both.
    {
      assert: {
        on: '$err',
        named: 'errorMatches',
        with: {
          messageContains: 'specDraftNMax',
          messageNotMatching: 'must be an integer between'
        }
      }
    }
  ],
  metadata: { category: 'speculative-decoding', dependency: 'none', estimatedDurationMs: 5000 }
}

/** Asserts the completion drafted at least one token and accepted no more than it drafted. */
const drafts: Step[] = [
  { project: { from: '$stats', path: 'draftTokens', as: 'draftTokens' } },
  { assert: { on: '$draftTokens', named: 'atLeast', with: { value: 1 } } },
  {
    assert: {
      on: '$stats',
      named: 'atLeastField',
      with: { field: 'draftTokens', atLeast: 'draftAcceptedTokens' }
    }
  }
]

// The drafter's block is 9 tokens; the default n_max of 3 would use a third of it.
const DSPARK_DRAFT_N_MAX = 9

export const speculativeDecodingDspark: TestDefinition = {
  testId: 'speculative-decoding-dspark',
  params: { prompt: PLANETS_PROMPT },
  expectation: { validation: 'contains-all', contains: ['Mercury', 'Venus', 'Earth'] },
  steps: [
    ...completesWith(
      {
        ctxSize: 2048,
        specType: 'draft-dspark',
        specDraftNMax: DSPARK_DRAFT_N_MAX,
        draftModelSrc: '$draft.modelSrc'
      },
      'llm-dspark',
      [{ modelSource: { dep: 'llm-dspark-draft', as: 'draft' } }]
    ),
    ...drafts
  ],
  finally: unloads,
  metadata: {
    category: 'speculative-decoding',
    dependency: 'none',
    dependencies: ['llm-dspark', 'llm-dspark-draft'],
    estimatedDurationMs: 300000
  }
}

export const speculativeDecodingAuto: TestDefinition = {
  testId: 'speculative-decoding-auto',
  params: { prompt: PLANETS_PROMPT },
  expectation: { validation: 'contains-all', contains: ['Mercury', 'Venus', 'Earth'] },
  steps: [
    // `auto` reads `draft-dspark` from the drafter's header.
    ...completesWith(
      {
        ctxSize: 2048,
        specType: 'auto',
        specDraftNMax: DSPARK_DRAFT_N_MAX,
        draftModelSrc: '$draft.modelSrc'
      },
      'llm-dspark',
      [{ modelSource: { dep: 'llm-dspark-draft', as: 'draft' } }]
    ),
    ...drafts
  ],
  finally: unloads,
  metadata: {
    category: 'speculative-decoding',
    dependency: 'none',
    dependencies: ['llm-dspark', 'llm-dspark-draft'],
    estimatedDurationMs: 300000
  }
}

export const speculativeDecodingAutoUndetectedRejected: TestDefinition = {
  testId: 'speculative-decoding-auto-undetected-rejected',
  params: {},
  expectation: { validation: 'throws-error', errorContains: 'detected no speculative type' },
  steps: [
    // A plain model has no DFlash, DSpark or MTP header for `auto` to read.
    { modelSource: { dep: 'llm-no-mtp', as: 'src' } },
    { modelSource: { dep: 'llm-no-mtp', as: 'draft' } },
    {
      callError: {
        method: 'loadModel',
        params: {
          modelSrc: '$src.modelSrc',
          modelType: '$src.modelType',
          modelConfig: { ctxSize: 2048, specType: 'auto', draftModelSrc: '$draft.modelSrc' }
        },
        as: 'err'
      }
    },
    {
      assert: {
        on: '$err',
        named: 'errorMatches',
        with: { messageContains: 'detected no speculative type' }
      }
    }
  ],
  metadata: {
    category: 'speculative-decoding',
    dependency: 'none',
    dependencies: ['llm-no-mtp'],
    estimatedDurationMs: 120000
  }
}

export const speculativeDecodingTests = [
  speculativeDecodingMtp,
  speculativeDecodingMtpExternalHead,
  speculativeDecodingNone,
  speculativeDecodingDraftNMaxOutOfRangeRejected,
  speculativeDecodingDspark,
  speculativeDecodingAuto,
  speculativeDecodingAutoUndetectedRejected
]
