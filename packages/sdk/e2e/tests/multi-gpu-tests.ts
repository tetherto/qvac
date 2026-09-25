import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * Loads a model with a split configuration of its own, runs one call, and
 * checks the work actually landed on the GPU.
 *
 * `backendDevice` is the whole point: a split config that silently fell back
 * to CPU would still produce the right answer, so the answer alone proves
 * nothing about the split.
 *
 * The model is unloaded in `finally`. These tests load their own instance
 * rather than taking one from the resource manager -- the split config is what
 * is under test -- so nothing else would clean it up.
 */
const splitSteps = (dep: string, modelConfig: Record<string, unknown>, call: Step[]): Step[] => [
  { modelSource: { dep, as: 'src' } },
  {
    call: {
      method: 'loadModel',
      params: { modelSrc: '$src.modelSrc', modelType: '$src.modelType', modelConfig },
      as: 'loaded'
    }
  },
  { project: { from: '$loaded', path: 'modelId', as: 'modelId' } },
  ...call,
  { project: { from: '$run', path: 'stats.backendDevice', as: 'device' } },
  { assert: { on: '$device', named: 'valueIn', with: { values: ['gpu'] } } }
]

/** Unloads whatever the body managed to load, on both paths. */
const unloadSplitModel: Step[] = [
  { call: { method: 'unloadModel', params: { modelId: '$modelId?', clearStorage: false } } }
]

const completesOnSplitModel: Step[] = [
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: { modelId: '$modelId', history: '$params.history', stream: false },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  { assert: { on: '$text', use: 'expectation' } }
]

const embedsOnSplitModel: Step[] = [
  { call: { method: 'embed', params: { modelId: '$modelId', text: '$params.text' }, as: 'run' } },
  { project: { from: '$run', path: 'embedding', as: 'embedding' } },
  { assert: { on: '$embedding', use: 'expectation' } }
]

const multiGpuSkip =
  process.env.QVAC_HAS_MULTI_GPU === '1'
    ? undefined
    : {
        reason: 'Requires a runner with at least two eligible GPUs',
        issue: 'QVAC-24821'
      }

export const multiGpuConfigSmoke: TestDefinition = {
  testId: 'multi-gpu-config-smoke',
  params: {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }]
  },
  expectation: { validation: 'contains-all', contains: ['4'] },
  suites: ['smoke'],
  skip: multiGpuSkip,
  steps: splitSteps(
    'llm',
    {
      ctx_size: 1024,
      verbosity: 0,
      gpu_layers: 99,
      'split-mode': 'layer',
      'tensor-split': '1,1',
      'main-gpu': 0
    },
    completesOnSplitModel
  ),
  finally: unloadSplitModel,
  metadata: {
    category: 'multi-gpu',
    dependency: 'none',
    estimatedDurationMs: 30000
  }
}

export const multiGpuTensorConfigSmoke: TestDefinition = {
  testId: 'multi-gpu-tensor-config-smoke',
  params: {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }]
  },
  expectation: { validation: 'contains-all', contains: ['4'] },
  suites: ['smoke'],
  skip: multiGpuSkip,
  steps: splitSteps(
    'llm',
    { ctx_size: 1024, verbosity: 0, gpu_layers: 99, 'split-mode': 'tensor', 'flash-attn': 'on' },
    completesOnSplitModel
  ),
  finally: unloadSplitModel,
  metadata: {
    category: 'multi-gpu',
    dependency: 'none',
    estimatedDurationMs: 30000
  }
}

export const multiGpuEmbedConfigSmoke: TestDefinition = {
  testId: 'multi-gpu-embed-config-smoke',
  params: {
    text: 'Multi-GPU embedding splits layers across all available GPUs.'
  },
  expectation: { validation: 'type', expectedType: 'array' },
  suites: ['smoke'],
  skip: multiGpuSkip,
  steps: splitSteps(
    'multi-gpu-embeddings',
    { gpuLayers: 99, verbosity: 0, splitMode: 'layer', tensorSplit: '1,1', mainGpu: 0 },
    embedsOnSplitModel
  ),
  finally: unloadSplitModel,
  metadata: {
    category: 'multi-gpu',
    dependency: 'none',
    estimatedDurationMs: 30000
  }
}

export const multiGpuTests = [
  multiGpuConfigSmoke,
  multiGpuTensorConfigSmoke,
  multiGpuEmbedConfigSmoke
]
