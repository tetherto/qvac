import test from 'brittle'
import {
  rerankParamsSchema,
  rerankRequestSchema,
  rerankResponseSchema,
  rerankConfigSchema,
  loadModelOptionsToRequestSchema,
  loadModelSrcRequestSchema,
  deviceConfigDefaultsSchema,
  ModelType
} from '@/schemas/index'
import { resolveModelConfigWithContext } from '@/runtime/model-config-utils'
import { transformRerankConfig } from '@/plugins/builtin/llamacpp-rerank/helpers'

const params = {
  modelId: 'reranker',
  query: 'How do I get a refund?',
  documents: ['Refunds take 5 days.', '']
}

test('Rerank requests take one query and a non-empty list of documents', (t) => {
  t.alike(rerankParamsSchema.parse(params), params)
  t.ok(rerankRequestSchema.safeParse({ ...params, type: 'rerank', requestId: 'r1' }).success)
  for (const input of [
    { ...params, query: '' },
    { ...params, documents: [] },
    { ...params, documents: 'Refunds take 5 days.' },
    { ...params, documents: ['Refunds take 5 days.', 1] },
    { query: params.query, documents: params.documents },
    { ...params, topN: 1 }
  ]) {
    t.absent(rerankParamsSchema.safeParse(input).success, JSON.stringify(input))
  }
})

test('Rerank responses carry finite scores, including negative ones', (t) => {
  t.ok(rerankResponseSchema.safeParse({ type: 'rerank', scores: [4.25, -3.5, 0] }).success)
  for (const scores of [[Number.NaN], [Number.POSITIVE_INFINITY], ['1']]) {
    t.absent(rerankResponseSchema.safeParse({ type: 'rerank', scores }).success)
  }
})

test('Reranker config maps to native keys and rejects options the reranker fixes', (t) => {
  const config = {
    device: 'gpu' as const,
    gpu_layers: 99,
    batch_size: 4096,
    backend: ['cuda' as const, 'vulkan' as const],
    poll: 10,
    pollBatch: 20,
    threads: 0,
    'threads-batch': -1,
    flash_attn: 'off' as const,
    'main-gpu': 'dedicated' as const
  }
  t.alike(transformRerankConfig(rerankConfigSchema.parse(config)), {
    device: 'gpu',
    gpu_layers: '99',
    batch_size: '4096',
    backend: 'cuda,vulkan',
    poll: '10',
    'poll-batch': '20',
    threads: '0',
    'threads-batch': '-1',
    flash_attn: 'off',
    'main-gpu': 'dedicated'
  })
  t.alike(
    transformRerankConfig(rerankConfigSchema.parse({ device: 'cpu', batch_size: undefined })),
    {
      device: 'cpu'
    }
  )
  for (const bad of [
    { device: 'cuda' },
    { ctx_size: 512 },
    { pooling: 'rank' },
    { backend: [] },
    { threads: 1.5 },
    { 'split-mode': 'row' }
  ]) {
    t.absent(rerankConfigSchema.safeParse(bad).success, JSON.stringify(bad))
  }
  const loaded = loadModelOptionsToRequestSchema.parse({
    modelSrc: '/tmp/reranker.gguf',
    modelType: ModelType.llamacppRerank,
    modelConfig: config
  })
  t.alike(loaded.modelConfig, config)
  t.ok(loadModelSrcRequestSchema.safeParse(loaded).success)
  t.absent(
    loadModelSrcRequestSchema.safeParse({
      type: 'loadModel',
      modelType: ModelType.llamacppRerank,
      modelSrc: '/tmp/reranker.gguf',
      modelConfig: { ctx_size: 512 }
    }).success
  )
})

test('Reranker loads without a device and resolves GPU before calling the addon', (t) => {
  const context = { runtime: 'node' as const, platform: 'darwin' as const }
  for (const modelConfig of [undefined, {}, { device: undefined }, { threads: 0 }]) {
    const request = loadModelOptionsToRequestSchema.parse({
      modelSrc: '/tmp/reranker.gguf',
      modelType: ModelType.llamacppRerank,
      ...(modelConfig === undefined ? {} : { modelConfig })
    })
    t.ok(loadModelSrcRequestSchema.safeParse(request).success)
    t.alike(request.modelConfig, modelConfig)
    const resolved = resolveModelConfigWithContext<Parameters<typeof transformRerankConfig>[0]>(
      ModelType.llamacppRerank,
      request.modelConfig ?? {},
      context,
      []
    )
    t.is(transformRerankConfig(resolved).device, 'gpu')
    if (modelConfig?.threads !== undefined) t.is(resolved.threads, modelConfig.threads)
  }
})

test('Reranker device patterns and explicit device choices override the GPU default', (t) => {
  const context = { runtime: 'node' as const, platform: 'darwin' as const }
  const defaults = { [ModelType.llamacppRerank]: { threads: 2 } }
  t.alike(deviceConfigDefaultsSchema.parse(defaults), defaults)
  const patterns = [
    {
      name: 'CPU device',
      match: {},
      defaults: { [ModelType.llamacppRerank]: { device: 'cpu' as const } }
    }
  ]
  const resolve = (config: Record<string, unknown>, withPattern = false) =>
    resolveModelConfigWithContext<Parameters<typeof transformRerankConfig>[0]>(
      ModelType.llamacppRerank,
      config,
      context,
      withPattern ? patterns : []
    )
  t.is(transformRerankConfig(resolve({ device: 'cpu' })).device, 'cpu')
  t.is(transformRerankConfig(resolve({}, true)).device, 'cpu')
  t.is(transformRerankConfig(resolve({ device: 'gpu' }, true)).device, 'gpu')
})
