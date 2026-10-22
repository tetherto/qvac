import type { Step, TestDefinition } from '@qvac/test-suite'

// ggml-org's Qwen3.5-0.8B keeps its MTP layers; the unsloth quants in the
// registry strip them, so `draft-mtp` cannot load those.
const MTP_MODEL_URL =
  'https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/807dfd9a6fadbf703207aac3bfb0b2b3040d077c/Qwen3.5-0.8B-Q8_0.gguf'

const PLANETS_PROMPT =
  'List the planets of the solar system in order from the Sun, comma separated.'

/** Loads the MTP model with the given speculative config, then runs one greedy completion. */
const completesWith = (modelConfig: Record<string, unknown>): Step[] => [
  {
    call: {
      method: 'loadModel',
      params: { modelSrc: '$params.modelUrl', modelType: 'llamacpp-completion', modelConfig },
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
        generationParams: { temp: 0, seed: 42, predict: 96, reasoning_budget: 0 }
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
  params: { modelUrl: MTP_MODEL_URL, prompt: PLANETS_PROMPT },
  expectation: { validation: 'contains-all', contains: ['Mercury', 'Venus', 'Earth'] },
  suites: ['smoke'],
  steps: [
    ...completesWith({ ctx_size: 2048, spec_type: 'draft-mtp' }),
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
  metadata: { category: 'speculative-decoding', dependency: 'none', estimatedDurationMs: 120000 }
}

export const speculativeDecodingNone: TestDefinition = {
  testId: 'speculative-decoding-none',
  params: { modelUrl: MTP_MODEL_URL, prompt: PLANETS_PROMPT },
  expectation: { validation: 'contains-all', contains: ['Mercury', 'Venus', 'Earth'] },
  steps: [
    ...completesWith({ ctx_size: 2048, spec_type: 'none' }),
    {
      assert: {
        on: '$stats',
        named: 'fieldsAbsent',
        with: { fields: ['draftTokens', 'draftAcceptedTokens'] }
      }
    }
  ],
  finally: unloads,
  metadata: { category: 'speculative-decoding', dependency: 'none', estimatedDurationMs: 120000 }
}

export const speculativeDecodingDraftNMaxOutOfRangeRejected: TestDefinition = {
  testId: 'speculative-decoding-draft-n-max-out-of-range-rejected',
  params: { modelUrl: MTP_MODEL_URL, draftNMax: 65 },
  expectation: { validation: 'throws-error', errorContains: 'spec_draft_n_max' },
  steps: [
    {
      callError: {
        method: 'loadModel',
        params: {
          modelSrc: '$params.modelUrl',
          modelType: 'llamacpp-completion',
          modelConfig: { spec_type: 'draft-mtp', spec_draft_n_max: '$params.draftNMax' }
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
          messageContains: 'spec_draft_n_max',
          messageNotMatching: 'must be an integer between'
        }
      }
    }
  ],
  metadata: { category: 'speculative-decoding', dependency: 'none', estimatedDurationMs: 5000 }
}

export const speculativeDecodingTests = [
  speculativeDecodingMtp,
  speculativeDecodingNone,
  speculativeDecodingDraftNMaxOutOfRangeRejected
]
