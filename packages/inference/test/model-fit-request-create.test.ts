import test from 'brittle'

import { ModelType } from '@/schemas/index'
import { createFitRequest } from '@/model-fit/request/create'

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
  return createFitRequest({
    modelType: ModelType.llamacppCompletion,
    modelPath: '/models/model.gguf',
    modelConfig: { ...COMPLETION_CONFIG, ...overrides },
    isShardedModel: false
  })
}

// === llama.cpp ===

test('completion: forwards the whole resolved load to its own engine', (t) => {
  const plan = completionRequest({ threads: 8, 'cpu-mask': 'ff' })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  const config = plan.probe.request.config ?? {}
  t.is(plan.probe.request.modelPath, '/models/model.gguf')
  t.is(config['ctx_size'], '4096')
  t.is(config['gpu_layers'], '99')
  t.is(config['cache-type-k'], 'q8_0')
  // A setting the projection does not read is llama's to ignore, not the SDK's
  // to drop, so nothing is filtered on the way out.
  t.is(config['threads'], '8')
  t.is(config['cpu-mask'], 'ff')
  // The engine resolves its own floor from the load it was given.
  t.absent('minCtxSize' in plan.probe.request)
})

test('completion: the checkpoint count stays out of the fit request', (t) => {
  for (const count of [0, 2]) {
    const plan = completionRequest({ cache_checkpoints: count })

    t.ok(plan.supported)
    if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
    const config = plan.probe.request.config ?? {}
    t.absent('cache_checkpoints' in config, String(count))
    t.is(config['ctx_size'], '4096')
  }
})

test('completion: the checkpoint budget, storage and RAM tier stay out of the fit request', (t) => {
  const plan = completionRequest({
    cache_checkpoints_max_bytes: 1073741824,
    cache_checkpoint_storage: 'disk',
    cache_checkpoint_dir: '/data/cache',
    cache_ram_mib: 512
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  const config = plan.probe.request.config ?? {}
  t.absent('cache_checkpoints_max_bytes' in config)
  t.absent('cache_checkpoint_storage' in config)
  t.absent('cache_checkpoint_dir' in config)
  t.absent('cache_ram_mib' in config)
  t.is(config['ctx_size'], '4096')
})

test('completion: the image limit stays out of the fit request', (t) => {
  const plan = completionRequest({ 'image-max-megapixels': 20 })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  const config = plan.probe.request.config ?? {}
  t.absent('image-max-megapixels' in config)
  t.is(config['ctx_size'], '4096')
})

test('completion: a symbolic main-gpu travels as written', (t) => {
  const plan = completionRequest({ 'main-gpu': 'dedicated' })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  t.is((plan.probe.request.config ?? {})['main-gpu'], 'dedicated')
})

test('completion: the margin reaches the engine request', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.llamacppCompletion,
    modelPath: '/models/model.gguf',
    modelConfig: COMPLETION_CONFIG,
    isShardedModel: false,
    marginBytes: 2048
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  t.is(plan.probe.request.marginBytes, 2048)
})

test('completion: a multimodal load is refused', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.llamacppCompletion,
      modelPath: '/models/model.gguf',
      modelConfig: COMPLETION_CONFIG,
      artifacts: { projectionModelPath: '/models/mmproj.gguf' },
      isShardedModel: false
    }),
    { supported: false, detail: 'multimodal projection loads are not representable' }
  )
})

test('a sharded load is refused whatever engine would run it', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.llamacppCompletion,
      modelPath: '/models/model-00001-of-00003.gguf',
      modelConfig: COMPLETION_CONFIG,
      isShardedModel: true
    }),
    { supported: false, detail: 'sharded models are not representable' }
  )
})

test('completion: a clustered load is refused', (t) => {
  t.alike(completionRequest({ 'rpc-servers': '10.0.0.2:50052,10.0.0.3:50052' }), {
    supported: false,
    detail: 'unsupported load setting: rpc-servers'
  })
})

test('embedding: forwards its own resolved load to its own engine', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.llamacppEmbedding,
    modelPath: '/models/embed.gguf',
    modelConfig: EMBEDDING_CONFIG,
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'embed-llamacpp') return
  const config = plan.probe.request.config ?? {}
  t.is(plan.probe.request.modelPath, '/models/embed.gguf')
  t.is(config['gpu_layers'], '99')
  t.is(config['batch_size'], '1024')
  t.is(config['pooling'], 'mean')
})

// === speech to text ===

test('whisper: carries the VAD model, flash attention, and the decoder count', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.whispercppTranscription,
    modelPath: '/models/whisper.bin',
    modelConfig: {
      strategy: 'beam_search',
      beam_search_beam_size: 5,
      contextParams: { use_gpu: true, flash_attn: true, gpu_device: 1 }
    },
    artifacts: { vadModelPath: '/models/vad.bin' },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.probe.engine, 'asr-ggml')
  t.alike(plan.probe.request, {
    engine: 'whisper',
    modelPath: '/models/whisper.bin',
    gpuLayers: 1,
    vadModelPath: '/models/vad.bin',
    flashAttn: true,
    gpuDevice: 1,
    decoders: 5
  })
})

test('whisper: a CPU load asks the fitter for no offload', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.whispercppTranscription,
    modelPath: '/models/whisper.bin',
    modelConfig: { contextParams: { use_gpu: false } },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.probe.engine === 'asr-ggml' ? plan.probe.request.gpuLayers : undefined, 0)
})

// The KV cache and decode graph are sized from the longest single transcribe.
test('whisper: the transcribe duration bounds the projection', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.whispercppTranscription,
    modelPath: '/models/whisper.bin',
    modelConfig: { duration_ms: 90_000 },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'asr-ggml') return
  t.is(plan.probe.request.audioSeconds, 90)
})

test('whisper: the default decoder sentinel is left to the engine', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.whispercppTranscription,
    modelPath: '/models/whisper.bin',
    modelConfig: { strategy: 'greedy', greedy_best_of: -1 },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.absent('decoders' in plan.probe.request)
})

test('parakeet: carries threads and the streaming chunk cadence', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.parakeetTranscription,
    modelPath: '/models/parakeet.gguf',
    modelConfig: { useGPU: true, maxThreads: 6, streaming: true, streamingChunkMs: 320 },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.alike(plan.probe.request, {
    engine: 'parakeet',
    modelPath: '/models/parakeet.gguf',
    gpuLayers: 1,
    threads: 6,
    nemotronChunkMs: 320
  })
})

// The fit request sizes the live session in frames while the load sets it in
// milliseconds, and converting needs the checkpoint's frame rate.
test('parakeet: a streaming context the projection cannot represent is refused', (t) => {
  for (const key of ['streamingLeftContextMs', 'streamingHistoryMs']) {
    const plan = createFitRequest({
      modelType: ModelType.parakeetTranscription,
      modelPath: '/models/parakeet.gguf',
      modelConfig: { useGPU: true, streaming: true, [key]: 8000 },
      isShardedModel: false
    })
    t.absent(plan.supported, key)
    if (plan.supported) continue
    t.ok(plan.detail.includes('cannot represent'))
  }
})

test('parakeet: those windows bind nothing outside a streaming load', (t) => {
  t.ok(
    createFitRequest({
      modelType: ModelType.parakeetTranscription,
      modelPath: '/models/parakeet.gguf',
      modelConfig: { useGPU: true, streamingLeftContextMs: 8000 },
      isShardedModel: false
    }).supported
  )
})

test('parakeet: a non-streaming load holds no live session to size', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.parakeetTranscription,
    modelPath: '/models/parakeet.gguf',
    modelConfig: { useGPU: true, streamingChunkMs: 320 },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.absent('nemotronChunkMs' in plan.probe.request)
})

test('bci: carries the embedder and defaults the GPU on', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.bciWhispercppTranscription,
    modelPath: '/models/bci.bin',
    modelConfig: {},
    artifacts: { embedderPath: '/models/embedder.gguf' },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.probe.engine, 'bci-whispercpp')
  t.alike(plan.probe.request, {
    modelPath: '/models/bci.bin',
    embedderPath: '/models/embedder.gguf',
    gpuLayers: 1
  })
})

test('bci: reads the duration and decoder count out of its whisper block', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.bciWhispercppTranscription,
    modelPath: '/models/bci.bin',
    modelConfig: {
      whisperConfig: { duration_ms: 30_000, beam_search_beam_size: 5 },
      contextParams: { use_gpu: false }
    },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'bci-whispercpp') return
  t.is(plan.probe.request.audioSeconds, 30)
  t.is(plan.probe.request.decoders, 5)
  t.is(plan.probe.request.gpuLayers, 0)
})

// === text to speech ===

test('tts: chatterbox carries both checkpoints and the cache type', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.ttsGgml,
    modelPath: '/models/t3.gguf',
    modelConfig: {
      ttsEngine: 'chatterbox',
      nCtx: 2048,
      kvCacheType: 'q8_0',
      useGPU: true,
      nGpuLayers: 99
    },
    artifacts: { s3genPath: '/models/s3gen.gguf' },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.alike(plan.probe.request, {
    engineType: 'chatterbox',
    t3ModelPath: '/models/t3.gguf',
    s3genModelPath: '/models/s3gen.gguf',
    nGpuLayers: 99,
    nCtx: 2048,
    kvCacheType: 'q8_0'
  })
})

test('tts: the LavaSR stages reach the fitter when the load names them', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.ttsGgml,
    modelPath: '/models/t3.gguf',
    modelConfig: { ttsEngine: 'chatterbox', useGPU: true, nGpuLayers: 99 },
    artifacts: {
      s3genPath: '/models/s3gen.gguf',
      lavasrEnhancerPath: '/models/enhancer.gguf',
      lavasrDenoiserPath: '/models/denoiser.gguf'
    },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.alike(plan.probe.request, {
    engineType: 'chatterbox',
    t3ModelPath: '/models/t3.gguf',
    s3genModelPath: '/models/s3gen.gguf',
    nGpuLayers: 99,
    lavasrEnhancerPath: '/models/enhancer.gguf',
    lavasrDenoiserPath: '/models/denoiser.gguf'
  })
})

test('tts: a load naming neither LavaSR stage sends neither path', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.ttsGgml,
    modelPath: '/models/supertonic.gguf',
    modelConfig: { ttsEngine: 'supertonic', useGPU: true, nGpuLayers: 99 },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.alike(plan.probe.request, {
    engineType: 'supertonic',
    supertonicModelPath: '/models/supertonic.gguf',
    nGpuLayers: 99
  })
})

test('tts: chatterbox without its s3gen checkpoint is refused', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.ttsGgml,
      modelPath: '/models/t3.gguf',
      modelConfig: { ttsEngine: 'chatterbox' },
      isShardedModel: false
    }),
    { supported: false, detail: 'the chatterbox s3gen checkpoint is not resolved' }
  )
})

test('tts: audio8 projects cloning only when the encoder is resolved', (t) => {
  const withoutEncoder = createFitRequest({
    modelType: ModelType.ttsGgml,
    modelPath: '/models/audio8-lm.gguf',
    modelConfig: { ttsEngine: 'audio8' },
    artifacts: { audio8CodecDecoderPath: '/models/decoder.gguf' },
    isShardedModel: false
  })

  t.ok(withoutEncoder.supported)
  if (!withoutEncoder.supported) return
  t.absent('audio8CodecEncoderPath' in withoutEncoder.probe.request)

  const withEncoder = createFitRequest({
    modelType: ModelType.ttsGgml,
    modelPath: '/models/audio8-lm.gguf',
    modelConfig: { ttsEngine: 'audio8' },
    artifacts: {
      audio8CodecDecoderPath: '/models/decoder.gguf',
      audio8CodecEncoderPath: '/models/encoder.gguf'
    },
    isShardedModel: false
  })

  t.ok(withEncoder.supported)
  if (!withEncoder.supported) return
  t.is(
    withEncoder.probe.engine === 'tts-ggml' && withEncoder.probe.request.engineType === 'audio8'
      ? withEncoder.probe.request.audio8CodecEncoderPath
      : undefined,
    '/models/encoder.gguf'
  )
})

test('tts: audio8 without its decoder is refused', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.ttsGgml,
      modelPath: '/models/audio8-lm.gguf',
      modelConfig: { ttsEngine: 'audio8' },
      isShardedModel: false
    }),
    { supported: false, detail: 'the audio8 codec decoder is not resolved' }
  )
})

test('tts: supertonic and parler are single-file loads', (t) => {
  const supertonic = createFitRequest({
    modelType: ModelType.ttsGgml,
    modelPath: '/models/supertonic.gguf',
    modelConfig: { ttsEngine: 'supertonic', ttsNumInferenceSteps: 16 },
    isShardedModel: false
  })
  t.ok(supertonic.supported)
  if (!supertonic.supported) return
  t.alike(supertonic.probe.request, {
    engineType: 'supertonic',
    supertonicModelPath: '/models/supertonic.gguf',
    nGpuLayers: 0,
    steps: 16
  })

  const parler = createFitRequest({
    modelType: ModelType.ttsGgml,
    modelPath: '/models/parler.gguf',
    modelConfig: { ttsEngine: 'parler', maxFrames: 2048 },
    isShardedModel: false
  })
  t.ok(parler.supported)
  if (!parler.supported) return
  t.alike(parler.probe.request, {
    engineType: 'parler',
    parlerModelPath: '/models/parler.gguf',
    nGpuLayers: 0,
    maxFrames: 2048
  })
})

// TTS `nGpuLayers` takes effect on its own and wins over `useGPU`, unlike
// audiogen's, which only applies once the gate is open.
test('tts: an explicit layer count wins over the GPU flag', (t) => {
  const cases = [
    { config: { useGPU: true }, layers: 1 },
    { config: { useGPU: false }, layers: 0 },
    { config: {}, layers: 0 },
    { config: { nGpuLayers: 24 }, layers: 24 },
    { config: { useGPU: false, nGpuLayers: 0 }, layers: 0 }
  ]

  for (const { config, layers } of cases) {
    const plan = createFitRequest({
      modelType: ModelType.ttsGgml,
      modelPath: '/models/parler.gguf',
      modelConfig: { ttsEngine: 'parler', ...config },
      isShardedModel: false
    })
    t.ok(plan.supported)
    if (!plan.supported || plan.probe.engine !== 'tts-ggml') continue
    t.is(plan.probe.request.nGpuLayers, layers, JSON.stringify(config))
  }
})

test('tts: cosyvoice without its companion set beside the checkpoint is refused', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.ttsGgml,
      modelPath: '/models/nowhere/cosyvoice3-llm-q8_0.gguf',
      modelConfig: { ttsEngine: 'cosyvoice3' },
      isShardedModel: false
    }),
    {
      supported: false,
      detail: 'the cosyvoice companion set is not laid out beside the checkpoint'
    }
  )
})

// === music and images ===

test('audiogen: carries all four ace-step stages', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.audiogenGgml,
    modelPath: '/models/acestep.gguf',
    modelConfig: { useGPU: true, nGpuLayers: 99, threads: 4 },
    artifacts: {
      textEncModelPath: '/models/text.gguf',
      lmModelPath: '/models/lm.gguf',
      ditModelPath: '/models/dit.gguf',
      vaeModelPath: '/models/vae.gguf'
    },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.probe.engine, 'audiogen-ggml')
  t.alike(plan.probe.request, {
    textEncoderPath: '/models/text.gguf',
    lmPath: '/models/lm.gguf',
    ditPath: '/models/dit.gguf',
    vaePath: '/models/vae.gguf',
    gpuLayers: 99,
    threads: 4
  })
})

test('audiogen: layers set against a closed GPU gate project no offload', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.audiogenGgml,
    modelPath: '/models/acestep.gguf',
    modelConfig: { nGpuLayers: 99 },
    artifacts: {
      textEncModelPath: '/models/text.gguf',
      lmModelPath: '/models/lm.gguf',
      ditModelPath: '/models/dit.gguf',
      vaeModelPath: '/models/vae.gguf'
    },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'audiogen-ggml') return
  t.is(plan.probe.request.gpuLayers, 0)
})

test('audiogen: an incomplete stage set is refused', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.audiogenGgml,
      modelPath: '/models/acestep.gguf',
      modelConfig: {},
      artifacts: { lmModelPath: '/models/lm.gguf' },
      isShardedModel: false
    }),
    { supported: false, detail: 'the ace-step stage checkpoints are not all resolved' }
  )
})

const MINIMAX_ARTIFACTS = {
  lmModelPath: '/models/mm3-lm-q8.gguf',
  synthModelPath: '/models/mm3-synth-q8.gguf'
}

test('audiogen: carries the minimax model pair', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.audiogenGgml,
    modelPath: '',
    modelConfig: { engine: 'minimax', useGPU: true, threads: 8, inferenceSteps: 12 },
    artifacts: MINIMAX_ARTIFACTS,
    isShardedModel: false,
    marginBytes: 1024
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.probe.engine, 'audiogen-ggml')
  t.alike(plan.probe.request, {
    engine: 'minimax',
    lmPath: '/models/mm3-lm-q8.gguf',
    synthPath: '/models/mm3-synth-q8.gguf',
    gpuLayers: 1,
    threads: 8,
    marginBytes: 1024
  })
})

// The fitter projects `auto` for a positive layer count and `cpu` otherwise,
// the same reading the load gives `useGPU`; a named device goes through as-is.
test('audiogen: the minimax device follows the load', (t) => {
  const cases = [
    { config: {}, expected: { gpuLayers: 0 } },
    { config: { useGPU: false }, expected: { gpuLayers: 0 } },
    { config: { useGPU: true }, expected: { gpuLayers: 1 } },
    { config: { device: 'gpu' }, expected: { device: 'gpu' } },
    { config: { device: 'auto' }, expected: { device: 'auto' } },
    { config: { device: 'cpu' }, expected: { device: 'cpu' } }
  ]

  for (const { config, expected } of cases) {
    const plan = createFitRequest({
      modelType: ModelType.audiogenGgml,
      modelPath: '',
      modelConfig: { engine: 'minimax', ...config },
      artifacts: MINIMAX_ARTIFACTS,
      isShardedModel: false
    })
    t.ok(plan.supported, JSON.stringify(config))
    if (!plan.supported || plan.probe.engine !== 'audiogen-ggml') continue
    t.alike(
      plan.probe.request,
      {
        engine: 'minimax',
        lmPath: MINIMAX_ARTIFACTS.lmModelPath,
        synthPath: MINIMAX_ARTIFACTS.synthModelPath,
        ...expected
      },
      JSON.stringify(config)
    )
  }
})

test('audiogen: an incomplete minimax pair is refused', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.audiogenGgml,
      modelPath: '',
      modelConfig: { engine: 'minimax' },
      artifacts: { lmModelPath: MINIMAX_ARTIFACTS.lmModelPath },
      isShardedModel: false
    }),
    { supported: false, detail: 'the minimax model pair is not resolved' }
  )
})

test('diffusion: carries the split text encoders and the VAE', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.sdcppGeneration,
    modelPath: '/models/flux.safetensors',
    modelConfig: { vae_tiling: true },
    artifacts: {
      clipLModelPath: '/models/clip_l.safetensors',
      t5XxlModelPath: '/models/t5xxl.safetensors',
      vaeModelPath: '/models/vae.safetensors'
    },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.probe.engine, 'diffusion-cpp')
  if (plan.probe.engine !== 'diffusion-cpp') return
  t.alike(plan.probe.request.files, {
    model: '/models/flux.safetensors',
    clipL: '/models/clip_l.safetensors',
    t5Xxl: '/models/t5xxl.safetensors',
    vae: '/models/vae.safetensors'
  })
  t.alike(plan.probe.request.workload, { vaeTiling: true })
})

test('diffusion: a standalone upscaler load has no fitter', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.sdcppGeneration,
      modelPath: '/models/esrgan.pth',
      modelConfig: { mode: 'upscale' },
      isShardedModel: false
    }),
    { supported: false, detail: 'a standalone upscaler load has no fitter' }
  )
})

test('diffusion: a world load is refused', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.sdcppGeneration,
      modelPath: '/models/wan.safetensors',
      modelConfig: { mode: 'world' },
      isShardedModel: false
    }),
    { supported: false, detail: 'world loads are not representable' }
  )
})

test('diffusion: a video load carries its companion set and a frame count', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.sdcppGeneration,
    modelPath: '/models/ltx.gguf',
    modelConfig: { mode: 'video', vae_tiling: true },
    artifacts: {
      llmModelPath: '/models/gemma.gguf',
      vaeModelPath: '/models/video_vae.safetensors',
      audioVaeModelPath: '/models/audio_vae.safetensors',
      embeddingsConnectorsModelPath: '/models/connectors.safetensors'
    },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  if (plan.probe.engine !== 'diffusion-cpp') return
  t.alike(plan.probe.request.files, {
    model: '/models/ltx.gguf',
    llm: '/models/gemma.gguf',
    vae: '/models/video_vae.safetensors',
    audioVae: '/models/audio_vae.safetensors',
    embeddingsConnectors: '/models/connectors.safetensors'
  })
  t.alike(plan.probe.request.workload, { vaeTiling: true, videoFrames: 33 })
})

test('diffusion: an image load carries no frame count', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.sdcppGeneration,
    modelPath: '/models/flux.safetensors',
    modelConfig: { mode: 'diffusion' },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  if (plan.probe.engine !== 'diffusion-cpp') return
  t.alike(plan.probe.request.workload, {})
})

test('diffusion: a configured upscaler is a second resident model the projection omits', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.sdcppGeneration,
      modelPath: '/models/sdxl.safetensors',
      modelConfig: { mode: 'diffusion', upscaler: { repeats: 2 } },
      isShardedModel: false
    }),
    { supported: false, detail: 'a configured upscaler is not part of the projection' }
  )
})

test('ocr: carries both models and the placement the load uses', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.ggmlOcr,
    modelPath: '/models/recognizer.gguf',
    modelConfig: {
      pipelineType: 'doctr',
      backendDevice: 'vulkan',
      gpuDevice: 1,
      nThreads: 4
    },
    artifacts: { detectorModelPath: '/models/detector.gguf' },
    isShardedModel: false,
    marginBytes: 1024
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.alike(plan.probe, {
    engine: 'ocr-ggml',
    request: {
      pathDetector: '/models/detector.gguf',
      pathRecognizer: '/models/recognizer.gguf',
      pipelineType: 'doctr',
      nThreads: 4,
      backendDevice: 'vulkan',
      gpuDevice: 1,
      marginBytes: 1024
    }
  })
})

test('ocr: a main-gpu selector reaches the fitter as the load sends it', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.ggmlOcr,
    modelPath: '/models/recognizer.gguf',
    modelConfig: { backendDevice: 'vulkan', mainGpu: 'dedicated' },
    artifacts: { detectorModelPath: '/models/detector.gguf' },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'ocr-ggml') return
  t.is(plan.probe.request.backendDevice, 'vulkan')
  t.is(plan.probe.request['main-gpu'], 'dedicated')
})

test('ocr: an easyocr load names English when it names no language', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.ggmlOcr,
    modelPath: '/models/recognizer.gguf',
    modelConfig: {},
    artifacts: { detectorModelPath: '/models/detector.gguf' },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'ocr-ggml') return
  t.alike(plan.probe.request.langList, ['en'])
})

test('ocr: a load without its detector is refused', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.ggmlOcr,
      modelPath: '/models/recognizer.gguf',
      modelConfig: {},
      isShardedModel: false
    }),
    { supported: false, detail: 'the ocr detector is not resolved' }
  )
})

test('translation: an IndicTrans load carries its model and generation config', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.nmtcppTranslation,
    modelPath: '/models/indictrans.bin',
    modelConfig: { engine: 'IndicTrans', from: 'en', to: 'hi', beamsize: 4 },
    isShardedModel: false,
    marginBytes: 1024
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'translation-nmtcpp') return
  t.alike(plan.probe.request.files, { model: '/models/indictrans.bin' })
  t.is(plan.probe.request.config.modelType, 'IndicTrans')
  t.is(plan.probe.request.config['beamsize'], 4)
  t.is(plan.probe.request.marginBytes, 1024)
})

test('translation: a Bergamot load finds its vocabulary beside the model', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.nmtcppTranslation,
    modelPath: '/models/enfr/model.enfr.intgemm.alphas.bin',
    modelConfig: { engine: 'Bergamot', from: 'en', to: 'fr' },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'translation-nmtcpp') return
  t.alike(plan.probe.request.files, {
    model: '/models/enfr/model.enfr.intgemm.alphas.bin',
    srcVocab: '/models/enfr/vocab.enfr.spm',
    dstVocab: '/models/enfr/vocab.enfr.spm'
  })
  t.is(plan.probe.request.config.modelType, 'Bergamot')
})

test('translation: a pivot load carries both models and their vocabularies', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.nmtcppTranslation,
    modelPath: '/models/esen/model.esen.intgemm.alphas.bin',
    modelConfig: { engine: 'Bergamot', from: 'es', to: 'it' },
    artifacts: {
      srcVocabPath: '/models/esen/vocab.esen.spm',
      dstVocabPath: '/models/esen/vocab.esen.spm',
      pivotModelPath: '/models/enit/model.enit.intgemm.alphas.bin',
      pivotSrcVocabPath: '/models/enit/vocab.enit.spm',
      pivotDstVocabPath: '/models/enit/vocab.enit.spm'
    },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'translation-nmtcpp') return
  t.alike(plan.probe.request.files, {
    model: '/models/esen/model.esen.intgemm.alphas.bin',
    srcVocab: '/models/esen/vocab.esen.spm',
    dstVocab: '/models/esen/vocab.esen.spm',
    pivotModel: '/models/enit/model.enit.intgemm.alphas.bin',
    pivotSrcVocab: '/models/enit/vocab.enit.spm',
    pivotDstVocab: '/models/enit/vocab.enit.spm'
  })
})

test('a model type with no fitter is refused by name', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.ggmlClassification,
      modelPath: '/models/classifier.gguf',
      modelConfig: {},
      isShardedModel: false
    }),
    { supported: false, detail: `no fitter for model type: ${ModelType.ggmlClassification}` }
  )
})

test('MOSS: fit projects the declared recording and matching decoding options', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.mossTranscribe,
    modelPath: '/models/moss.gguf',
    modelConfig: { useGPU: true, maxThreads: 4, backendsDir: '/backends' },
    transcriptionWorkload: { audioSeconds: 90, hotwords: ['Erin'], maxNewTokens: 0 },
    marginBytes: 1024,
    isShardedModel: false
  })
  t.alike(plan, {
    supported: true,
    probe: {
      engine: 'asr-ggml',
      request: {
        engine: 'moss-transcribe',
        modelPath: '/models/moss.gguf',
        audioSeconds: 90,
        hotwords: ['Erin'],
        maxNewTokens: 0,
        gpuLayers: 1,
        threads: 4,
        backendsDir: '/backends',
        marginBytes: 1024
      }
    }
  })
})

test('MOSS: missing workload cannot claim a fit; default load remains CPU', (t) => {
  const base = {
    modelType: ModelType.mossTranscribe,
    modelPath: '/models/moss.gguf',
    modelConfig: {},
    isShardedModel: false
  }
  t.is(createFitRequest(base).supported, false)
  const plan = createFitRequest({
    ...base,
    transcriptionWorkload: { audioSeconds: 30, prompt: 'Transcribe.' }
  })
  t.ok(plan.supported)
  if (plan.supported && plan.probe.engine === 'asr-ggml') t.is(plan.probe.request.gpuLayers, 0)
  t.is(
    createFitRequest({
      ...base,
      modelType: ModelType.parakeetTranscription,
      transcriptionWorkload: { audioSeconds: 30 }
    }).supported,
    false
  )
})
