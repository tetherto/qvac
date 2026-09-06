import test from 'brittle'

import { ModelType } from '@/schemas/index'
import { createLlamaFitRequest } from '@/model-fit/create-llama-fit-request'

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
    isShardedModel: false,
    isMobile: false
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

test('createLlamaFitRequest: refuses a multimodal load', (t) => {
  t.alike(
    createLlamaFitRequest({
      modelType: ModelType.llamacppCompletion,
      modelPath: '/models/model.gguf',
      modelConfig: COMPLETION_CONFIG,
      artifacts: { projectionModelPath: '/models/mmproj.gguf' },
      isShardedModel: false,
      isMobile: false
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
      isShardedModel: true,
      isMobile: false
    }),
    { supported: false, detail: 'sharded models are not representable' }
  )
})

test('createLlamaFitRequest: refuses every load on mobile before inspecting it', (t) => {
  t.alike(
    createLlamaFitRequest({
      modelType: ModelType.llamacppCompletion,
      modelPath: '/models/model.gguf',
      modelConfig: { some_new_load_knob: 7 },
      isShardedModel: true,
      isMobile: true
    }),
    { supported: false, detail: 'mobile has no disposable process boundary' }
  )
})

test('createLlamaFitRequest: refuses a model type that is not a llama.cpp load', (t) => {
  t.alike(
    createLlamaFitRequest({
      modelType: ModelType.whispercppTranscription,
      modelPath: '/models/whisper.bin',
      modelConfig: {},
      isShardedModel: false,
      isMobile: false
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
    isShardedModel: false,
    isMobile: false
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
