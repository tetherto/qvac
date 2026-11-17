import test from 'brittle'
import {
  decideParamsSchema,
  decisionConfigSchema,
  loadModelOptionsToRequestSchema,
  loadModelSrcRequestSchema,
  deviceConfigDefaultsSchema,
  ModelType,
  type DecisionConfig
} from '@/schemas/index'
import { resolveModelConfigWithContext } from '@/runtime/model-config-utils'
import { toUpstreamConfig } from '@/plugins/builtin/llamacpp-decision/upstream'

const questions = {
  team: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: null, technical: 'Bugs' }
  },
  urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] },
  refund: {
    type: 'noul',
    instructions: 'A refund is requested.',
    criteria: null
  }
}

test('Decision requests preserve structured states and batch shape', (t) => {
  const single = {
    modelId: 'laya',
    state: { text: 'Refund', history: [null, true, 1] },
    questions
  }
  t.alike(decideParamsSchema.parse(single), single)
  const batch = {
    modelId: 'laya',
    states: ['text', 0, false, [{ role: 'user', content: 'Refund' }]],
    questions
  }
  t.alike(decideParamsSchema.parse(batch), batch)
  for (const input of [
    { modelId: 'laya', state: null, questions },
    { modelId: 'laya', state: 'x', states: ['x'], questions },
    { modelId: 'laya', questions },
    { ...single, state: { bad: undefined } },
    { ...single, state: { bad: BigInt(1) } },
    // Controls only fabric-format Laya took are gone from the contract.
    { ...single, maxLen: 512 },
    { ...single, headMaxLen: 128 },
    { ...single, questions: { team: { ...questions.team, optionOrder: [1, 0] } } },
    { ...single, questions: { refund: { ...questions.refund, labels: { false: 'no', true: 'yes' } } } },
    { ...single, questions: { q: { type: 'unknown', instructions: 'x' } } }
  ]) {
    t.absent(decideParamsSchema.safeParse(input).success)
  }
})

test('Decision config accepts only DecisionEngine options and maps them to the addon', (t) => {
  const config = {
    device: 'cpu' as const,
    gpu_layers: 0,
    threads: 0,
    batch_size: 2048,
    verbosity: 1,
    openclCacheDir: '/cache'
  }
  t.alike(toUpstreamConfig(decisionConfigSchema.parse(config)), {
    device: 'cpu',
    gpu_layers: '0',
    threads: '0',
    batch_size: '2048',
    verbosity: '1',
    openclCacheDir: '/cache'
  })
  t.alike(toUpstreamConfig(decisionConfigSchema.parse({ device: 'gpu' })), { device: 'gpu' })
  t.alike(toUpstreamConfig(decisionConfigSchema.parse({ device: 'cpu', batch_size: undefined })), {
    device: 'cpu'
  })
  for (const bad of [
    { device: 'cuda' },
    { device: 'gpu', ctx_size: 512 },
    { device: 'cpu', threads: 1.5 },
    // Options only fabric-format Laya took are gone from the contract.
    { device: 'cpu', 'split-mode': 'layer' },
    { device: 'cpu', 'main-gpu': 0 },
    { device: 'cpu', 'tensor-split': '1,1' },
    { device: 'cpu', 'threads-batch': 2 },
    { device: 'cpu', flash_attn: 'off' },
    { device: 'cpu', poll: 0 },
    { device: 'cpu', pollBatch: 0 }
  ]) {
    t.absent(decisionConfigSchema.safeParse(bad).success)
  }
  const loaded = loadModelOptionsToRequestSchema.parse({
    modelSrc: '/tmp/laya.gguf',
    modelType: ModelType.llamacppDecision,
    modelConfig: config
  })
  t.alike(loaded.modelConfig, config)
  t.ok(loadModelSrcRequestSchema.safeParse(loaded).success)
})

test('Decision models load without a device and resolve GPU before calling the addon', (t) => {
  const context = { runtime: 'node' as const, platform: 'darwin' as const }
  for (const modelConfig of [undefined, {}, { device: undefined }, { threads: 0 }]) {
    const request = loadModelOptionsToRequestSchema.parse({
      modelSrc: '/tmp/laya.gguf',
      modelType: ModelType.llamacppDecision,
      ...(modelConfig === undefined ? {} : { modelConfig })
    })
    t.ok(loadModelSrcRequestSchema.safeParse(request).success)
    t.alike(request.modelConfig, modelConfig)
    const resolved = resolveModelConfigWithContext<DecisionConfig>(
      ModelType.llamacppDecision,
      request.modelConfig ?? {},
      context,
      []
    )
    t.is(toUpstreamConfig(resolved).device, 'gpu')
    if (modelConfig?.threads !== undefined) t.is(resolved.threads, modelConfig.threads)
  }
})

test('Decision device patterns and explicit device choices override the GPU default', (t) => {
  const context = { runtime: 'node' as const, platform: 'darwin' as const }
  const defaults = { [ModelType.llamacppDecision]: { threads: 2 } }
  t.alike(deviceConfigDefaultsSchema.parse(defaults), defaults)
  const patterns = [
    {
      name: 'CPU device',
      match: {},
      defaults: { [ModelType.llamacppDecision]: { device: 'cpu' as const } }
    }
  ]
  const resolve = (config: Record<string, unknown>, withPattern = false) =>
    resolveModelConfigWithContext<DecisionConfig>(
      ModelType.llamacppDecision,
      config,
      context,
      withPattern ? patterns : []
    )
  t.is(toUpstreamConfig(resolve({ device: 'cpu' })).device, 'cpu')
  t.is(toUpstreamConfig(resolve({}, true)).device, 'cpu')
  t.is(toUpstreamConfig(resolve({ device: 'gpu' }, true)).device, 'gpu')
})
