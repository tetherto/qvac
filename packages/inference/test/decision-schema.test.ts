import test from 'brittle'
import {
  decideParamsSchema,
  decisionConfigSchema,
  loadModelOptionsToRequestSchema,
  loadModelSrcRequestSchema,
  deviceConfigDefaultsSchema,
  ModelType
} from '@/schemas/index'
import { resolveModelConfigWithContext } from '@/runtime/model-config-utils'
import {
  transformDecisionConfig,
  decisionModelFiles
} from '@/plugins/builtin/llamacpp-decision/helpers'

const questions = {
  team: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: null, technical: 'Bugs' },
    option_order: [1, 0]
  },
  urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] },
  refund: {
    type: 'noul',
    instructions: 'A refund is requested.',
    labels: { false: 'no', true: 'yes' },
    criteria: null
  }
}

test('Laya requests preserve option order, labels, structured states and batch shape', (t) => {
  const single = {
    modelId: 'laya',
    state: { text: 'Refund', history: [null, true, 1] },
    questions,
    max_len: 512,
    head_max_len: 128
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
    { ...single, max_len: -1 },
    { ...single, questions: { q: { type: 'unknown', instructions: 'x' } } }
  ]) {
    t.absent(decideParamsSchema.safeParse(input).success)
  }
})

test('Laya passes complete shard files in addon order', (t) => {
  t.alike(decisionModelFiles('/models/laya.gguf'), ['/models/laya.gguf'])
  t.alike(decisionModelFiles('/models/laya-00002-of-00002.gguf'), [
    '/models/laya.tensors.txt',
    '/models/laya-00001-of-00002.gguf',
    '/models/laya-00002-of-00002.gguf'
  ])
})

test('Laya config accepts only supported context options and preserves native defaults', (t) => {
  const config = {
    device: 'cpu' as const,
    threads: 0,
    'threads-batch': -1,
    batch_size: 2048,
    flash_attn: 'off' as const
  }
  t.alike(transformDecisionConfig(decisionConfigSchema.parse(config)), {
    device: 'cpu',
    threads: '0',
    'threads-batch': '-1',
    batch_size: '2048',
    flash_attn: 'off'
  })
  t.alike(transformDecisionConfig(decisionConfigSchema.parse({ device: 'gpu' })), {
    device: 'gpu'
  })
  t.alike(
    transformDecisionConfig(decisionConfigSchema.parse({ device: 'cpu', batch_size: undefined })),
    {
      device: 'cpu'
    }
  )
  for (const bad of [
    { device: 'cuda' },
    { device: 'gpu', ctx_size: 512 },
    { device: 'cpu', threads: 1.5 },
    { device: 'cpu', 'split-mode': 'row' }
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

test('Laya loads without a device and resolves GPU before calling the addon', (t) => {
  const context = { runtime: 'node' as const, platform: 'darwin' as const }
  for (const modelConfig of [undefined, {}, { device: undefined }, { threads: 0 }]) {
    const request = loadModelOptionsToRequestSchema.parse({
      modelSrc: '/tmp/laya.gguf',
      modelType: ModelType.llamacppDecision,
      ...(modelConfig === undefined ? {} : { modelConfig })
    })
    t.ok(loadModelSrcRequestSchema.safeParse(request).success)
    t.alike(request.modelConfig, modelConfig)
    const resolved = resolveModelConfigWithContext<Parameters<typeof transformDecisionConfig>[0]>(
      ModelType.llamacppDecision,
      request.modelConfig ?? {},
      context,
      []
    )
    t.is(transformDecisionConfig(resolved).device, 'gpu')
    if (modelConfig?.threads !== undefined) t.is(resolved.threads, modelConfig.threads)
  }
})

test('Laya device patterns and explicit device choices override the GPU default', (t) => {
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
    resolveModelConfigWithContext<Parameters<typeof transformDecisionConfig>[0]>(
      ModelType.llamacppDecision,
      config,
      context,
      withPattern ? patterns : []
    )
  t.is(transformDecisionConfig(resolve({ device: 'cpu' })).device, 'cpu')
  t.is(transformDecisionConfig(resolve({}, true)).device, 'cpu')
  t.is(transformDecisionConfig(resolve({ device: 'gpu' }, true)).device, 'gpu')
})
