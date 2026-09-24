import test from 'brittle'

import { ModelType } from '@/schemas/index'
import { createFitRequest } from '@/resources/model-fit/native-probe/create-fit-request'

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

// The load reaches the engine in llama's own spelling, so the SDK classifies
// rather than interprets and llama's argument table does the parsing.
test('completion: forwards the load settings in llama spelling', (t) => {
  const plan = completionRequest()

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.probe.engine, 'llm-llamacpp')
  t.alike(plan.probe.request, {
    modelPath: '/models/model.gguf',
    minCtxSize: 4096,
    params: {
      'ctx-size': '4096',
      'gpu-layers': '99',
      'load-mode': 'mmap',
      parallel: '2',
      'cache-type-k': 'q8_0',
      'cache-type-v': 'q8_0',
      'main-gpu': '0',
      'split-mode': 'layer'
    }
  })
})

// These move memory between devices, or between device and host. llama parses
// them, so they reach the engine untouched.
test('completion: placement settings reach the engine untouched', (t) => {
  const plan = completionRequest({
    'tensor-split': '3,1',
    'cpu-moe': true,
    'n-cpu-moe': 2,
    'override-tensor': 'ffn_.*=CPU',
    'kv-offload': false
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  const params = plan.probe.request.params ?? {}
  t.is(params['tensor-split'], '3,1')
  t.is(params['n-cpu-moe'], '2')
  t.is(params['override-tensor'], 'ffn_.*=CPU')
  t.ok('cpu-moe' in params)
  t.ok('no-kv-offload' in params)
})

test('completion: flash attention is evidence, not a refusal', (t) => {
  const plan = completionRequest({ 'flash-attn': 'on' })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  t.is(plan.probe.request.params?.['flash-attn'], 'on')
})

test('completion: an auto context leaves the fitter free to choose', (t) => {
  const plan = completionRequest({ ctx_size: 0 })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.absent('ctxSize' in plan.probe.request)
  t.absent('minCtxSize' in plan.probe.request)
})

test('completion: CPU scheduling settings are dropped, not refused', (t) => {
  const plan = completionRequest({
    threads: 8,
    'threads-batch': 16,
    'cpu-mask': 'ff',
    'cpu-mask-batch': 'f0'
  })

  t.ok(plan.supported)
})

test('completion: the margin reaches the engine request', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.llamacppCompletion,
    modelPath: '/models/model.gguf',
    modelConfig: COMPLETION_CONFIG,
    isShardedModel: false,
    marginBytes: 2 * 1024 ** 3
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  t.is(plan.probe.request.marginBytes, 2 * 1024 ** 3)
})

// `fit-target` is the margin the real load asks the engine to leave free; the
// advisory margin covers the models already resident. The stricter wins.
test('completion: the load target and the advisory margin resolve to the stricter', (t) => {
  const targetWins = createFitRequest({
    modelType: ModelType.llamacppCompletion,
    modelPath: '/models/model.gguf',
    modelConfig: { ...COMPLETION_CONFIG, 'fit-target': 4096 },
    isShardedModel: false,
    marginBytes: 1024 * 1024 * 1024
  })
  t.ok(targetWins.supported)
  if (!targetWins.supported || targetWins.probe.engine !== 'llm-llamacpp') return
  t.is(targetWins.probe.request.marginBytes, 4096 * 1024 * 1024)

  const advisoryWins = createFitRequest({
    modelType: ModelType.llamacppCompletion,
    modelPath: '/models/model.gguf',
    modelConfig: { ...COMPLETION_CONFIG, 'fit-target': 512 },
    isShardedModel: false,
    marginBytes: 8 * 1024 ** 3
  })
  t.ok(advisoryWins.supported)
  if (!advisoryWins.supported || advisoryWins.probe.engine !== 'llm-llamacpp') return
  t.is(advisoryWins.probe.request.marginBytes, 8 * 1024 ** 3)
})

// A per-device list resolves to its largest entry: the only reading that cannot
// project a device as roomier than the load will leave it.
test('completion: a per-device fit target takes its largest entry', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.llamacppCompletion,
    modelPath: '/models/model.gguf',
    modelConfig: { ...COMPLETION_CONFIG, 'fit-target': '1024,2048' },
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  t.is(plan.probe.request.marginBytes, 2048 * 1024 * 1024)
})

// Whether a setting is one llama knows is llama's own question, answered by its
// argument table at projection time rather than guessed at here.
test('completion: a setting this layer does not know is left for llama to judge', (t) => {
  const plan = completionRequest({ some_new_load_knob: 7 })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  t.is(plan.probe.request.params?.['some_new_load_knob'], '7')
})

// The transform rewrites the boolean into whichever flag it asserts, and llama
// reads the flag's polarity from its own negated-argument table.
test('completion: kv offload reaches the engine as the flag it asserts', (t) => {
  const off = completionRequest({ 'kv-offload': false })
  t.ok(off.supported)
  if (!off.supported || off.probe.engine !== 'llm-llamacpp') return
  t.ok('no-kv-offload' in (off.probe.request.params ?? {}))

  const on = completionRequest({ 'kv-offload': true })
  t.ok(on.supported)
  if (!on.supported || on.probe.engine !== 'llm-llamacpp') return
  t.ok('kv-offload' in (on.probe.request.params ?? {}))

  const unset = completionRequest()
  t.ok(unset.supported)
  if (!unset.supported || unset.probe.engine !== 'llm-llamacpp') return
  const params = unset.probe.request.params ?? {}
  t.absent('kv-offload' in params)
  t.absent('no-kv-offload' in params)
})

// `integrated` and `dedicated` restrict selection to a device class. The value
// travels as written, so llama decides whether it can honour it.
test('completion: a symbolic main-gpu travels as written', (t) => {
  const plan = completionRequest({ 'main-gpu': 'dedicated' })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  t.is(plan.probe.request.params?.['main-gpu'], 'dedicated')
})

// llama's own auto-fit is what the fitter performs, and how weights are read
// does not change how many are resident.
test('completion: settings that cannot move device memory are dropped', (t) => {
  t.ok(
    completionRequest({
      load_mode: 'mmap',
      parallel: 2,
      'prefetch-weights': 'auto',
      'tensor-read-lazy': 'on',
      fit: true,
      'fit-ctx': 8192
    }).supported
  )
})

test('completion: a LoRA load is refused', (t) => {
  t.alike(completionRequest({ lora: '/adapters/style.gguf' }), {
    supported: false,
    detail: 'unsupported load setting: lora'
  })
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

test('completion: a sharded load is refused', (t) => {
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

test('completion: a CPU load carries no device-memory evidence', (t) => {
  t.alike(completionRequest({ device: 'cpu' }), {
    supported: false,
    detail: 'cpu loads carry no device-memory evidence'
  })
})

// A cache type llama does not have is llama's to reject, at the point where it
// knows which types this build carries.
test('completion: an unknown KV cache type travels to the engine', (t) => {
  const plan = completionRequest({ 'cache-type-k': 'tbq4_0' })

  t.ok(plan.supported)
  if (!plan.supported || plan.probe.engine !== 'llm-llamacpp') return
  t.is(plan.probe.request.params?.['cache-type-k'], 'tbq4_0')
})

test('embedding: forwards its own spellings and goes to its own engine', (t) => {
  const plan = createFitRequest({
    modelType: ModelType.llamacppEmbedding,
    modelPath: '/models/embed.gguf',
    modelConfig: EMBEDDING_CONFIG,
    isShardedModel: false
  })

  t.ok(plan.supported)
  if (!plan.supported) return
  t.is(plan.probe.engine, 'embed-llamacpp')
  t.alike(plan.probe.request, {
    modelPath: '/models/embed.gguf',
    params: {
      'gpu-layers': '99',
      'batch-size': '1024',
      'flash-attn': 'auto'
    }
  })
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
    t3Path: '/models/t3.gguf',
    s3genPath: '/models/s3gen.gguf',
    gpuLayers: 99,
    contextSize: 2048,
    kvCacheType: 'q8_0'
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
  t.absent('codecEncoderPath' in withoutEncoder.probe.request)

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
      ? withEncoder.probe.request.codecEncoderPath
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
    modelPath: '/models/supertonic.gguf',
    gpuLayers: 0,
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
    modelPath: '/models/parler.gguf',
    gpuLayers: 0,
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
    t.is(plan.probe.request.gpuLayers, layers, JSON.stringify(config))
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

test('audiogen: the minimax pipeline has no fitter', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.audiogenGgml,
      modelPath: '/models/minimax.gguf',
      modelConfig: { engine: 'minimax' },
      isShardedModel: false
    }),
    { supported: false, detail: 'the minimax pipeline has no fitter' }
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

// Their file sets carry an audio VAE, embeddings connectors, a preview decoder
// and a seed scene, none of which the fit request has a place for.
test('diffusion: video and world loads are refused', (t) => {
  for (const mode of ['video', 'world'] as const) {
    t.alike(
      createFitRequest({
        modelType: ModelType.sdcppGeneration,
        modelPath: '/models/wan.safetensors',
        modelConfig: { mode },
        isShardedModel: false
      }),
      { supported: false, detail: `${mode} loads are not representable` }
    )
  }
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

test('a model type with no fitter is refused by name', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.ggmlOcr,
      modelPath: '/models/ocr.gguf',
      modelConfig: {},
      isShardedModel: false
    }),
    { supported: false, detail: `no fitter for model type: ${ModelType.ggmlOcr}` }
  )
})
