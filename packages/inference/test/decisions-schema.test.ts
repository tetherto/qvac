import test from 'brittle'
import {
  decideParamsSchema,
  decisionsConfigSchema,
  loadModelOptionsToRequestSchema,
  loadModelSrcRequestSchema,
  deviceConfigDefaultsSchema,
  ModelType
} from '@/schemas/index'
import { resolveModelConfigWithContext } from '@/runtime/model-config-utils'
import {
  transformDecisionsConfig,
  decisionsModelFiles
} from '@/plugins/builtin/llamacpp-decisions/helpers'

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
  t.alike(decisionsModelFiles('/models/laya.gguf'), ['/models/laya.gguf'])
  t.alike(decisionsModelFiles('/models/laya-00002-of-00002.gguf'), [
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
  t.alike(transformDecisionsConfig(decisionsConfigSchema.parse(config)), {
    device: 'cpu',
    threads: '0',
    'threads-batch': '-1',
    batch_size: '2048',
    flash_attn: 'off'
  })
  t.alike(transformDecisionsConfig(decisionsConfigSchema.parse({ device: 'gpu' })), {
    device: 'gpu'
  })
  t.alike(
    transformDecisionsConfig(decisionsConfigSchema.parse({ device: 'cpu', batch_size: undefined })),
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
    t.absent(decisionsConfigSchema.safeParse(bad).success)
  }
  const loaded = loadModelOptionsToRequestSchema.parse({
    modelSrc: '/tmp/laya.gguf',
    modelType: ModelType.llamacppDecisions,
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
      modelType: ModelType.llamacppDecisions,
      ...(modelConfig === undefined ? {} : { modelConfig })
    })
    t.ok(loadModelSrcRequestSchema.safeParse(request).success)
    t.alike(request.modelConfig, modelConfig)
    const resolved = resolveModelConfigWithContext<Parameters<typeof transformDecisionsConfig>[0]>(
      ModelType.llamacppDecisions,
      request.modelConfig ?? {},
      context,
      []
    )
    t.is(transformDecisionsConfig(resolved).device, 'gpu')
    if (modelConfig?.threads !== undefined) t.is(resolved.threads, modelConfig.threads)
  }
})

test('Laya device patterns and explicit device choices override the GPU default', (t) => {
  const context = { runtime: 'node' as const, platform: 'darwin' as const }
  const defaults = { [ModelType.llamacppDecisions]: { threads: 2 } }
  t.alike(deviceConfigDefaultsSchema.parse(defaults), defaults)
  const patterns = [
    {
      name: 'CPU device',
      match: {},
      defaults: { [ModelType.llamacppDecisions]: { device: 'cpu' as const } }
    }
  ]
  const resolve = (config: Record<string, unknown>, withPattern = false) =>
    resolveModelConfigWithContext<Parameters<typeof transformDecisionsConfig>[0]>(
      ModelType.llamacppDecisions,
      config,
      context,
      withPattern ? patterns : []
    )
  t.is(transformDecisionsConfig(resolve({ device: 'cpu' })).device, 'cpu')
  t.is(transformDecisionsConfig(resolve({}, true)).device, 'cpu')
  t.is(transformDecisionsConfig(resolve({ device: 'gpu' }, true)).device, 'gpu')
})
