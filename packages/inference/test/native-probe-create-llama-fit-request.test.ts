import test from 'brittle'

import { ModelType } from '@/schemas/index'
import { createLlamaFitRequest } from '@/resources/model-fit/native-probe/create-llama-fit-request'

const COMPLETION_CONFIG = {
  ctx_size: 4096,
  gpu_layers: 99,
  device: 'gpu',
  system_prompt: 'You are a helpful assistant.',
  image_tile_mode: 'sequential',
  temp: 0.8,
  top_k: 40,
  top_p: 0.9,
  seed: -1,
  predict: -1,
  repeat_penalty: 1.1,
  tools: false,
  stop_sequences: ['</s>'],
  n_discarded: 0,
  parallel: 2,
  load_mode: 'mmap',
  'cache-type-k': 'q8_0',
  'cache-type-v': 'q8_0',
  'main-gpu': 0,
  'split-mode': 'layer',
  'tensor-split': '3,1',
  openclCacheDir: '/tmp/opencl'
}

const EMBEDDING_CONFIG = {
  device: 'gpu',
  gpuLayers: 99,
  batchSize: 1024,
  flashAttention: 'auto',
  pooling: 'mean',
  attention: 'non-causal',
  embdNormalize: 2,
  verbosity: 0,
  openclCacheDir: '/tmp/opencl'
}

function completionRequest(overrides: Record<string, unknown> = {}) {
  return createLlamaFitRequest({
    modelType: ModelType.llamacppCompletion,
    modelPath: '/models/model.gguf',
    modelConfig: { ...COMPLETION_CONFIG, ...overrides },
    isShardedModel: false
  })
}

test('createLlamaFitRequest: forwards only fit-relevant completion load settings', (t) => {
  const plan = completionRequest()

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.loadKind, 'completion')
  t.alike(plan.config.params, {
    device: 'gpu',
    ctx_size: '4096',
    gpu_layers: '99',
    load_mode: 'mmap',
    parallel: '2',
    'cache-type-k': 'q8_0',
    'cache-type-v': 'q8_0',
    'main-gpu': '0',
    'split-mode': 'layer',
    'tensor-split': '3,1'
  })
})

test('createLlamaFitRequest: forwards completion flash-attn as fit evidence', (t) => {
  // Flash attention alters KV/compute memory, so it must forward as evidence,
  // not refuse the check.
  const plan = completionRequest({ 'flash-attn': 'on' })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.config.params['flash-attn'], 'on')
})

test('createLlamaFitRequest: pins the requested context as the reduction floor', (t) => {
  const plan = completionRequest()

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.config.nCtxMin, 4096)
})

test('createLlamaFitRequest: leaves the floor unset for an auto context', (t) => {
  const plan = completionRequest({ ctx_size: 0 })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.config.params['ctx_size'], '0')
  t.absent('nCtxMin' in plan.config)
})

test('createLlamaFitRequest: forwards placement and fit settings for model-fit to judge', (t) => {
  const plan = completionRequest({
    'batch-size': 1024,
    'ubatch-size': 256,
    'cpu-moe': true,
    'n-cpu-moe': 2,
    'n-cpu-ffn': 4,
    'override-tensor': 'blk\\.1[0-9]\\.ffn_up_exps=CPU',
    'moe-cache-mib': 2048,
    'kv-offload': false,
    'prefetch-weights': 'auto',
    'tensor-read-lazy': 'on',
    fit: true,
    'fit-target': '1024,512',
    'fit-ctx': 8192,
    'image-max-tokens': 512,
    'image-min-tokens': 64
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.config.params['batch-size'], '1024')
  t.is(plan.config.params['ubatch-size'], '256')
  t.is(plan.config.params['cpu-moe'], '')
  t.is(plan.config.params['n-cpu-moe'], '2')
  t.is(plan.config.params['n-cpu-ffn'], '4')
  t.is(plan.config.params['override-tensor'], 'blk\\.1[0-9]\\.ffn_up_exps=CPU')
  t.is(plan.config.params['moe-cache-mib'], '2048')
  t.is(plan.config.params['no-kv-offload'], '')
  t.absent('kv-offload' in plan.config.params)
  t.is(plan.config.params['prefetch-weights'], 'auto')
  t.is(plan.config.params['tensor-read-lazy'], 'on')
  t.is(plan.config.params['fit'], 'true')
  t.is(plan.config.params['fit-target'], '1024,512')
  t.is(plan.config.params['fit-ctx'], '8192')
  t.is(plan.config.params['image-max-tokens'], '512')
  t.is(plan.config.params['image-min-tokens'], '64')
})

test('createLlamaFitRequest: drops CPU scheduling settings, which cannot move device memory', (t) => {
  const plan = completionRequest({
    threads: 8,
    'threads-batch': 16,
    'cpu-mask': 'ff',
    'cpu-mask-batch': 'f0'
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.absent('threads' in plan.config.params)
  t.absent('threads-batch' in plan.config.params)
  t.absent('cpu-mask' in plan.config.params)
  t.absent('cpu-mask-batch' in plan.config.params)
})

test('createLlamaFitRequest: refuses a load carrying an unclassified setting', (t) => {
  t.alike(completionRequest({ some_new_load_knob: 7 }), {
    supported: false,
    detail: 'unclassified load setting: some_new_load_knob'
  })
})

test('createLlamaFitRequest: refuses a LoRA load', (t) => {
  t.alike(completionRequest({ lora: '/adapters/style.gguf' }), {
    supported: false,
    detail: 'unsupported load setting: lora'
  })
})

test('createLlamaFitRequest: refuses an unresolved multimodal projection source', (t) => {
  t.alike(completionRequest({ projectionModelSrc: '/models/mmproj.gguf' }), {
    supported: false,
    detail: 'unsupported load setting: projection_model_src'
  })
})

test('createLlamaFitRequest: refuses a multimodal load', (t) => {
  t.alike(
    createLlamaFitRequest({
      modelType: ModelType.llamacppCompletion,
      modelPath: '/models/model.gguf',
      modelConfig: COMPLETION_CONFIG,
      artifacts: { projectionModelPath: '/models/mmproj.gguf' },
      isShardedModel: false
    }),
    { supported: false, detail: 'multimodal projection loads are not representable' }
  )
})

test('createLlamaFitRequest: refuses a sharded load', (t) => {
  t.alike(
    createLlamaFitRequest({
      modelType: ModelType.llamacppCompletion,
      modelPath: '/models/model-00001-of-00003.gguf',
      modelConfig: COMPLETION_CONFIG,
      isShardedModel: true
    }),
    { supported: false, detail: 'sharded models are not representable' }
  )
})

test('createLlamaFitRequest: refuses a model type that is not a llama.cpp load', (t) => {
  t.alike(
    createLlamaFitRequest({
      modelType: ModelType.whispercppTranscription,
      modelPath: '/models/whisper.bin',
      modelConfig: {},
      isShardedModel: false
    }),
    {
      supported: false,
      detail: `model type is not a llama.cpp load: ${ModelType.whispercppTranscription}`
    }
  )
})

test('createLlamaFitRequest: forwards only fit-relevant embedding load settings', (t) => {
  const plan = createLlamaFitRequest({
    modelType: ModelType.llamacppEmbedding,
    modelPath: '/models/embed.gguf',
    modelConfig: EMBEDDING_CONFIG,
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.loadKind, 'embedding')
  t.alike(plan.config.params, {
    device: 'gpu',
    gpu_layers: '99',
    batch_size: '1024',
    flash_attn: 'auto'
  })
  // Embedding context is resolved by the package's own embedding policy.
  t.absent('nCtxMin' in plan.config)
})

test('createLlamaFitRequest: refuses a CPU load, whose verdict carries no evidence', (t) => {
  t.alike(completionRequest({ device: 'cpu' }), {
    supported: false,
    detail: 'cpu loads carry no device-memory evidence'
  })
})
