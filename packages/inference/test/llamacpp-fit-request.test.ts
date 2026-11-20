import test from 'brittle'

import type LlmLlamacpp from '@qvac/llm-llamacpp'
import type { EmbedFitRequest } from '@qvac/embed-llamacpp'
import { llmFitRequest } from '@/plugins/builtin/llamacpp-completion/fit'
import { embedFitRequest } from '@/plugins/builtin/llamacpp-embedding/fit'
import type { FitRequestPlan } from '@/schemas/plugin'

const COMPLETION_CONFIG = {
  ctxSize: 4096,
  gpuLayers: 99,
  device: 'gpu',
  systemPrompt: 'You are a helpful assistant.',
  imageTileMode: 'sequential',
  temperature: 0.8,
  topK: 40,
  topP: 0.9,
  seed: -1,
  predict: -1,
  repeatPenalty: 1.1,
  tools: false,
  stopSequences: ['</s>'],
  parallel: 2,
  loadMode: 'mmap',
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  mainGpu: 0,
  splitMode: 'layer',
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

function completion(overrides: Record<string, unknown> = {}): FitRequestPlan {
  return llmFitRequest({
    modelPath: '/models/model.gguf',
    modelConfig: { ...COMPLETION_CONFIG, ...overrides },
    isShardedModel: false
  })
}

function llmRequest(plan: FitRequestPlan): LlmLlamacpp.FitRequest | undefined {
  return 'request' in plan ? (plan.request as LlmLlamacpp.FitRequest) : undefined
}

test('completion: forwards the whole resolved load to its own engine', (t) => {
  const request = llmRequest(completion({ threads: 8, cpuMask: 'ff' }))

  t.ok(request)
  const config = request?.config ?? {}
  t.is(request?.modelPath, '/models/model.gguf')
  t.is(config['ctx_size'], '4096')
  t.is(config['gpu_layers'], '99')
  t.is(config['cache-type-k'], 'q8_0')
  // A setting the projection does not read is llama's to ignore, so nothing is
  // filtered on the way out.
  t.is(config['threads'], '8')
  t.is(config['cpu-mask'], 'ff')
})

test('completion: the checkpoint and prompt-cache keys stay out of the fit request', (t) => {
  const config =
    llmRequest(
      completion({
        cacheCheckpoints: 2,
        cacheCheckpointsMaxBytes: 1073741824,
        cacheCheckpointStorage: 'disk',
        cacheCheckpointDir: '/data/cache',
        cacheRamMib: 512,
        cacheShareAcrossKeys: true
      })
    )?.config ?? {}

  t.absent('cache_checkpoints' in config)
  t.absent('cache_checkpoints_max_bytes' in config)
  t.absent('cache_checkpoint_storage' in config)
  t.absent('cache_checkpoint_dir' in config)
  t.absent('cache_ram_mib' in config)
  t.absent('cache_share_across_keys' in config)
  t.is(config['ctx_size'], '4096')
})

test('completion: the image limit stays out of the fit request', (t) => {
  const config = llmRequest(completion({ imageMaxMegapixels: 20 }))?.config ?? {}

  t.absent('image-max-megapixels' in config)
  t.is(config['ctx_size'], '4096')
})

test('completion: a symbolic mainGpu travels as written', (t) => {
  t.is(llmRequest(completion({ mainGpu: 'dedicated' }))?.config?.['main-gpu'], 'dedicated')
})

test('completion: a multimodal load is unknown', (t) => {
  const plan = llmFitRequest({
    modelPath: '/models/model.gguf',
    modelConfig: COMPLETION_CONFIG,
    artifacts: { projectionModelPath: '/models/mmproj.gguf' },
    isShardedModel: false
  })
  t.ok('unknown' in plan)
})

test('completion: a split model is unknown', (t) => {
  const plan = llmFitRequest({
    modelPath: '/models/model-00001-of-00003.gguf',
    modelConfig: COMPLETION_CONFIG,
    isShardedModel: true
  })
  t.ok('unknown' in plan)
})

test('completion: an RPC load is unknown', (t) => {
  t.ok('unknown' in completion({ rpcServers: '10.0.0.2:50052,10.0.0.3:50052' }))
})

test('completion: the speculative keys and the draft model path reach the fit', (t) => {
  const config =
    llmRequest(
      llmFitRequest({
        modelPath: '/models/model.gguf',
        modelConfig: { ...COMPLETION_CONFIG, specType: 'draft-dflash', specDraftNMax: 7 },
        artifacts: { draftModelPath: '/models/dflash.gguf' },
        isShardedModel: false
      })
    )?.config ?? {}

  t.is(config['spec_type'], 'draft-dflash')
  t.is(config['spec_draft_n_max'], '7')
  t.is(config['spec_draft_model'], '/models/dflash.gguf')
})

test('completion: an external MTP head reaches the fit as spec_draft_model', (t) => {
  const config =
    llmRequest(
      llmFitRequest({
        modelPath: '/models/model.gguf',
        modelConfig: { ...COMPLETION_CONFIG, specType: 'draft-mtp' },
        artifacts: { draftModelPath: '/models/mtp-head.gguf' },
        isShardedModel: false
      })
    )?.config ?? {}

  t.is(config['spec_type'], 'draft-mtp')
  t.is(config['spec_draft_model'], '/models/mtp-head.gguf')
})

test('completion: no draft model artifact sends no spec_draft_model to the fit', (t) => {
  const config = llmRequest(completion({ specType: 'draft-mtp' }))?.config ?? {}

  t.is(config['spec_type'], 'draft-mtp')
  t.absent('spec_draft_model' in config)
})

test('embedding: forwards its own resolved load to its own engine', (t) => {
  const plan = embedFitRequest({
    modelPath: '/models/embed.gguf',
    modelConfig: EMBEDDING_CONFIG,
    isShardedModel: false
  })

  const request = 'request' in plan ? (plan.request as EmbedFitRequest) : undefined
  t.ok(request)
  const config = request?.config ?? {}
  t.is(request?.modelPath, '/models/embed.gguf')
  t.is(config['gpu_layers'], '99')
  t.is(config['batch_size'], '1024')
  t.is(config['pooling'], 'mean')
})

test('embedding: the requested context and the projector reach the fit', (t) => {
  const plan = embedFitRequest({
    modelPath: '/models/embeddinggemma.gguf',
    modelConfig: { ...EMBEDDING_CONFIG, ctxSize: 2048 },
    artifacts: { projectionModelPath: '/models/mmproj.gguf' },
    isShardedModel: false
  })

  const request = 'request' in plan ? (plan.request as EmbedFitRequest) : undefined
  t.is(request?.config?.['ctx_size'], '2048')
  t.is(request?.projectionModel, '/models/mmproj.gguf')
})

test('embedding: a split model and an RPC load are unknown', (t) => {
  t.ok(
    'unknown' in
      embedFitRequest({
        modelPath: '/models/embed-00001-of-00002.gguf',
        modelConfig: EMBEDDING_CONFIG,
        isShardedModel: true
      })
  )
  t.ok(
    'unknown' in
      embedFitRequest({
        modelPath: '/models/embed.gguf',
        modelConfig: { ...EMBEDDING_CONFIG, 'rpc-servers': '10.0.0.2:50052' },
        isShardedModel: false
      })
  )
})
