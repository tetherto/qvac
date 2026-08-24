import test from 'brittle'
import { ttsConfigSchema } from '@/schemas/text-to-speech'
import { LegacyTtsModelDeprecatedError } from '@/errors/index'

type TtsGgmlDebugModel = {
  _streamChunkTokens?: number
  _streamFirstChunkTokens?: number
  _cfmSteps?: number
  _cfgRate?: number
  _threads?: number
  _nGpuLayers?: number
  _seed?: number
  _mecabDictPath?: string
  _cangjieTsvPath?: string
  _enhancerGgufPath?: string
  _denoiserGgufPath?: string
  _parlerModelPath?: string
  _description?: string
  _voice?: string
  _emotion?: string
  _temperature?: number
  _topK?: number
  _topP?: number
  _maxFrames?: number
  _minNewTokens?: number
  _normalizeNumbers?: boolean
  _outputSampleRate?: number | null
  _cosyvoiceModelDir?: string
  _cosyvoiceLlmModelPath?: string
  _instruct?: string
  _pace?: string
  _audio8LmPath?: string
  _audio8CodecDecoderPath?: string
  _audio8CodecEncoderPath?: string
  _referenceText?: string
  _greedy?: boolean
  _config?: {
    language?: string
    useGPU?: boolean
    outputSampleRate?: number
    vulkanCacheDir?: string
  }
  getEngineType?: () => string
}

test('ttsPlugin resolveConfig: legacy ONNX Chatterbox shape throws LegacyTtsModelDeprecatedError', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')
  const legacyConfig = {
    ttsEngine: 'chatterbox',
    language: 'en',
    ttsSpeechEncoderSrc: 's3:///legacy/speech_encoder.onnx',
    ttsEmbedTokensSrc: 's3:///legacy/embed_tokens.onnx',
    ttsConditionalDecoderSrc: 's3:///legacy/conditional_decoder.onnx',
    ttsLanguageModelSrc: 's3:///legacy/language_model.onnx'
  }

  const parsed = ttsConfigSchema.safeParse(legacyConfig)
  t.is(parsed.success, true, 'schema must accept legacy shape before resolveConfig')

  try {
    await ttsPlugin.resolveConfig!(legacyConfig, {
      resolveModelPath: async () => '',
      modelSrc: 's3:///legacy/model',
      modelType: 'tts-ggml'
    })
    t.ok(false, 'expected LegacyTtsModelDeprecatedError')
  } catch (err) {
    t.ok(
      err instanceof LegacyTtsModelDeprecatedError,
      'resolveConfig must throw LegacyTtsModelDeprecatedError for legacy ONNX config'
    )
  }
})

test('ttsPlugin createModel: forwards Chatterbox native constructor options', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const result = ttsPlugin.createModel({
    modelId: 'tts-chatterbox-test',
    modelPath: '/tmp/chatterbox-t3.gguf',
    artifacts: { s3genPath: '/tmp/chatterbox-s3gen.gguf' },
    modelConfig: {
      ttsEngine: 'chatterbox',
      language: 'en',
      useGPU: true,
      streamChunkTokens: 25,
      streamFirstChunkTokens: 10,
      cfmSteps: 1,
      cfgRate: 0.7,
      threads: 8,
      nGpuLayers: 99,
      seed: 42
    }
  })

  const model = result.model as TtsGgmlDebugModel
  t.is(model._streamChunkTokens, 25)
  t.is(model._streamFirstChunkTokens, 10)
  t.is(model._cfmSteps, 1)
  t.is(model._cfgRate, 0.7)
  t.is(model._threads, 8)
  t.is(model._nGpuLayers, 99)
  t.is(model._seed, 42)
  t.alike(model._config, { language: 'en', useGPU: true })
})

test('ttsPlugin resolveConfig: keeps Parler config runtime-only', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')
  const config = {
    ttsEngine: 'parler' as const,
    voice: 'Rohit',
    emotion: 'happy' as const,
    temperature: 0.9
  }

  const resolved = await ttsPlugin.resolveConfig!(config, {
    resolveModelPath: async () => {
      throw new Error('Parler has no companion artifacts')
    },
    modelSrc: 'registry://s3/parler-mini-v1-q8_0.gguf',
    modelType: 'tts-ggml'
  })

  t.alike(resolved.config, config)
  t.alike(resolved.artifacts, {})
})

test('ttsPlugin createModel: wires the full Parler constructor surface', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const result = ttsPlugin.createModel({
    modelId: 'tts-parler-test',
    modelPath: '/tmp/parler-mini-v1-q8_0.gguf',
    modelConfig: {
      ttsEngine: 'parler',
      voice: 'Rohit',
      emotion: 'happy',
      useGPU: true,
      outputSampleRate: 44100,
      streamChunkTokens: 43,
      streamFirstChunkTokens: 20,
      threads: 2,
      nGpuLayers: 99,
      seed: 7,
      temperature: 0.9,
      topK: 40,
      topP: 0.95,
      maxFrames: 860,
      minNewTokens: -1,
      normalizeNumbers: false
    }
  })

  const model = result.model as TtsGgmlDebugModel
  t.is(model.getEngineType?.(), 'parler')
  t.is(model._parlerModelPath, '/tmp/parler-mini-v1-q8_0.gguf')
  t.is(model._voice, 'Rohit')
  t.is(model._emotion, 'happy')
  t.is(model._temperature, 0.9)
  t.is(model._topK, 40)
  t.is(model._topP, 0.95)
  t.is(model._maxFrames, 860)
  t.is(model._minNewTokens, -1)
  t.is(model._normalizeNumbers, false)
  t.is(model._streamChunkTokens, 43)
  t.is(model._streamFirstChunkTokens, 20)
  t.is(model._threads, 2)
  t.is(model._nGpuLayers, 99)
  t.is(model._seed, 7)
  t.is(model._outputSampleRate, 44100)
  t.alike(model._config, { useGPU: true, outputSampleRate: 44100 })
})

test('ttsPlugin resolveConfig: resolves Chatterbox multilingual tokenizer assets', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')
  const resolved: string[] = []

  const result = await ttsPlugin.resolveConfig!(
    {
      ttsEngine: 'chatterbox',
      language: 'ja',
      s3genModelSrc: 'registry://s3/s3gen.gguf',
      mecabDictSrc: 'registry://s3/qvac_models_compiled/chatterbox/mecab-ipadic/char.bin',
      cangjieTsvSrc: 'registry://s3/qvac_models_compiled/ggml/chatterbox/2026-07-03/Cangjie5_TC.tsv'
    },
    {
      resolveModelPath: async (src) => {
        const value = typeof src === 'string' ? src : src.src
        resolved.push(value)
        if (value.includes('mecab-ipadic')) {
          return '/tmp/qvac/sets/mecab-ipadic/char.bin'
        }
        if (value.includes('Cangjie5_TC')) {
          return '/tmp/qvac/Cangjie5_TC.tsv'
        }
        return '/tmp/qvac/s3gen.gguf'
      },
      modelSrc: 'registry://s3/t3.gguf',
      modelType: 'tts-ggml'
    }
  )

  t.alike(resolved, [
    'registry://s3/s3gen.gguf',
    'registry://s3/qvac_models_compiled/chatterbox/mecab-ipadic/char.bin',
    'registry://s3/qvac_models_compiled/ggml/chatterbox/2026-07-03/Cangjie5_TC.tsv'
  ])
  t.alike(result.config, { ttsEngine: 'chatterbox', language: 'ja' })
  t.alike(result.artifacts, {
    s3genPath: '/tmp/qvac/s3gen.gguf',
    mecabDictPath: '/tmp/qvac/sets/mecab-ipadic',
    cangjieTsvPath: '/tmp/qvac/Cangjie5_TC.tsv'
  })
})

test('ttsPlugin resolveConfig: resolves LavaSR enhancer/denoiser to artifacts and strips *Src', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const resolved = await ttsPlugin.resolveConfig!(
    {
      ttsEngine: 'supertonic',
      language: 'en',
      outputSampleRate: 48000,
      lavasrEnhancerModelSrc: 'registry://s3/lavasr/enhancer.gguf',
      lavasrDenoiserModelSrc: 'registry://s3/lavasr/denoiser.gguf'
    },
    {
      resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
      modelSrc: 'registry://s3/supertonic.gguf',
      modelType: 'tts-ggml'
    }
  )

  t.alike(resolved.artifacts, {
    lavasrEnhancerPath: '/cache/registry://s3/lavasr/enhancer.gguf',
    lavasrDenoiserPath: '/cache/registry://s3/lavasr/denoiser.gguf'
  })
  // *Src fields must not leak into the runtime config.
  t.is('lavasrEnhancerModelSrc' in resolved.config, false)
  t.is('lavasrDenoiserModelSrc' in resolved.config, false)
  t.is((resolved.config as { outputSampleRate?: number }).outputSampleRate, 48000)
})

test('ttsPlugin resolveConfig: resolves Chatterbox LavaSR artifacts and strips *Src', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const resolved = await ttsPlugin.resolveConfig!(
    {
      ttsEngine: 'chatterbox',
      language: 'en',
      s3genModelSrc: 'registry://s3/chatterbox/s3gen.gguf',
      lavasrEnhancerModelSrc: 'registry://s3/lavasr/enhancer.gguf',
      lavasrDenoiserModelSrc: 'registry://s3/lavasr/denoiser.gguf'
    },
    {
      resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
      modelSrc: 'registry://s3/chatterbox/t3.gguf',
      modelType: 'tts-ggml'
    }
  )

  t.alike(resolved.artifacts, {
    s3genPath: '/cache/registry://s3/chatterbox/s3gen.gguf',
    lavasrEnhancerPath: '/cache/registry://s3/lavasr/enhancer.gguf',
    lavasrDenoiserPath: '/cache/registry://s3/lavasr/denoiser.gguf'
  })
  // *Src fields must not leak into the runtime config.
  t.is('s3genModelSrc' in resolved.config, false)
  t.is('lavasrEnhancerModelSrc' in resolved.config, false)
  t.is('lavasrDenoiserModelSrc' in resolved.config, false)
})

test('ttsPlugin createModel: forwards LavaSR files + outputSampleRate (supertonic)', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const result = ttsPlugin.createModel({
    modelId: 'tts-supertonic-lavasr',
    modelPath: '/tmp/supertonic.gguf',
    artifacts: {
      lavasrEnhancerPath: '/tmp/lavasr-enhancer.gguf',
      lavasrDenoiserPath: '/tmp/lavasr-denoiser.gguf'
    },
    modelConfig: {
      ttsEngine: 'supertonic',
      language: 'en',
      outputSampleRate: 48000,
      vulkanCacheDir: '/tmp/vulkan-cache'
    }
  })

  const model = result.model as TtsGgmlDebugModel
  t.is(model._enhancerGgufPath, '/tmp/lavasr-enhancer.gguf')
  t.is(model._denoiserGgufPath, '/tmp/lavasr-denoiser.gguf')
  t.is(model._outputSampleRate, 48000)
  t.alike(model._config, {
    language: 'en',
    useGPU: false,
    outputSampleRate: 48000,
    vulkanCacheDir: '/tmp/vulkan-cache'
  })
})

test('ttsPlugin createModel: forwards LavaSR enhancer (chatterbox)', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const result = ttsPlugin.createModel({
    modelId: 'tts-chatterbox-lavasr',
    modelPath: '/tmp/chatterbox-t3.gguf',
    artifacts: {
      s3genPath: '/tmp/chatterbox-s3gen.gguf',
      lavasrEnhancerPath: '/tmp/lavasr-enhancer.gguf'
    },
    modelConfig: {
      ttsEngine: 'chatterbox',
      language: 'en'
    }
  })

  const model = result.model as TtsGgmlDebugModel
  t.is(model._enhancerGgufPath, '/tmp/lavasr-enhancer.gguf')
  t.is(model._denoiserGgufPath, undefined)
  // Chatterbox does not resample; outputSampleRate is never forwarded.
  t.is(model._outputSampleRate ?? null, null)
})

test('ttsPlugin createModel: forwards Chatterbox multilingual tokenizer paths', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const result = ttsPlugin.createModel({
    modelId: 'tts-chatterbox-mtl-test',
    modelPath: '/tmp/chatterbox-t3-mtl.gguf',
    artifacts: {
      s3genPath: '/tmp/chatterbox-s3gen-mtl.gguf',
      mecabDictPath: '/tmp/mecab-ipadic',
      cangjieTsvPath: '/tmp/Cangjie5_TC.tsv'
    },
    modelConfig: {
      ttsEngine: 'chatterbox',
      language: 'ja'
    }
  })

  const model = result.model as TtsGgmlDebugModel
  t.is(model._mecabDictPath, '/tmp/mecab-ipadic')
  t.is(model._cangjieTsvPath, '/tmp/Cangjie5_TC.tsv')
})

test('ttsPlugin resolveConfig: resolves CosyVoice3 LavaSR artifacts and strips *Src', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const resolved = await ttsPlugin.resolveConfig!(
    {
      ttsEngine: 'cosyvoice3',
      emotion: 'happy',
      seed: 42,
      lavasrEnhancerModelSrc: 'registry://s3/lavasr/enhancer.gguf'
    },
    {
      resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
      modelSrc: 'registry://s3/cosy_voice/cosyvoice3-llm-q8_0.gguf',
      modelType: 'tts-ggml'
    }
  )

  t.alike(resolved.config, { ttsEngine: 'cosyvoice3', emotion: 'happy', seed: 42 })
  t.alike(resolved.artifacts, {
    lavasrEnhancerPath: '/cache/registry://s3/lavasr/enhancer.gguf'
  })
})

test('ttsPlugin createModel: wires the CosyVoice3 constructor surface', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const result = ttsPlugin.createModel({
    modelId: 'tts-cosyvoice3-test',
    modelPath: '/tmp/qvac/sets/cosyvoice3/cosyvoice3-llm-q8_0.gguf',
    artifacts: { lavasrEnhancerPath: '/tmp/lavasr-enhancer.gguf' },
    modelConfig: {
      ttsEngine: 'cosyvoice3',
      emotion: 'happy',
      useGPU: true,
      outputSampleRate: 24000,
      streamChunkTokens: 25,
      streamFirstChunkTokens: 10,
      threads: 4,
      nGpuLayers: 99,
      seed: 42
    }
  })

  const model = result.model as TtsGgmlDebugModel
  t.is(model.getEngineType?.(), 'cosyvoice3')
  // The companion set co-locates the model files, so the model dir is the
  // primary GGUF's containing directory.
  t.is(model._cosyvoiceModelDir, '/tmp/qvac/sets/cosyvoice3')
  t.is(model._cosyvoiceLlmModelPath, '/tmp/qvac/sets/cosyvoice3/cosyvoice3-llm-q8_0.gguf')
  t.is(model._emotion, 'happy')
  t.is(model._enhancerGgufPath, '/tmp/lavasr-enhancer.gguf')
  t.is(model._streamChunkTokens, 25)
  t.is(model._streamFirstChunkTokens, 10)
  t.is(model._threads, 4)
  t.is(model._nGpuLayers, 99)
  t.is(model._seed, 42)
  t.is(model._outputSampleRate, 24000)
  t.alike(model._config, { useGPU: true, outputSampleRate: 24000 })
})

test('ttsPlugin createModel: renders the CosyVoice3 structured instruct', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const result = ttsPlugin.createModel({
    modelId: 'tts-cosyvoice3-instruct-test',
    modelPath: '/tmp/qvac/sets/cosyvoice3/cosyvoice3-llm-q8_0.gguf',
    modelConfig: {
      ttsEngine: 'cosyvoice3',
      instruct: { dialect: 'cantonese' }
    }
  })

  const model = result.model as TtsGgmlDebugModel
  t.is(model._instruct, '请用广东话表达。')
})

test('ttsPlugin resolveConfig: resolves Audio8 component GGUFs and strips *Src', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')
  const resolved: string[] = []

  const result = await ttsPlugin.resolveConfig!(
    {
      ttsEngine: 'audio8',
      greedy: true,
      referenceText: 'Exactly what the recording says.',
      audio8CodecDecoderModelSrc: 'registry://s3/audio-8/audio8-codec-decoder-q8_0.gguf',
      audio8CodecEncoderModelSrc: 'registry://s3/audio-8/audio8-codec-encoder-q8_0.gguf',
      referenceAudioSrc: 'registry://s3/audio-8/voice.wav'
    },
    {
      resolveModelPath: async (src) => {
        const value = typeof src === 'string' ? src : (src as { src: string }).src
        resolved.push(value)
        return `/cache/${value.split('/').pop()}`
      },
      modelSrc: 'registry://s3/audio-8/audio8-lm-q8_0.gguf',
      modelType: 'tts-ggml'
    }
  )

  t.alike(resolved, [
    'registry://s3/audio-8/audio8-codec-decoder-q8_0.gguf',
    'registry://s3/audio-8/audio8-codec-encoder-q8_0.gguf',
    'registry://s3/audio-8/voice.wav'
  ])
  t.alike(result.config, {
    ttsEngine: 'audio8',
    greedy: true,
    referenceText: 'Exactly what the recording says.'
  })
  t.alike(result.artifacts, {
    audio8CodecDecoderPath: '/cache/audio8-codec-decoder-q8_0.gguf',
    audio8CodecEncoderPath: '/cache/audio8-codec-encoder-q8_0.gguf',
    referenceAudioPath: '/cache/voice.wav'
  })
})

test('ttsPlugin createModel: wires the Audio8 constructor surface', async (t) => {
  const { ttsPlugin } = await import('@/plugins/builtin/tts-ggml/plugin')

  const result = ttsPlugin.createModel({
    modelId: 'tts-audio8-test',
    modelPath: '/tmp/audio8-lm-q8_0.gguf',
    artifacts: {
      audio8CodecDecoderPath: '/tmp/audio8-codec-decoder-q8_0.gguf',
      audio8CodecEncoderPath: '/tmp/audio8-codec-encoder-q8_0.gguf',
      referenceAudioPath: '/tmp/voice.wav'
    },
    modelConfig: {
      ttsEngine: 'audio8',
      referenceText: 'Exactly what the recording says.',
      temperature: 0.7,
      topK: 50,
      topP: 0.9,
      maxFrames: 430,
      useGPU: true,
      outputSampleRate: 44100,
      threads: 4,
      nGpuLayers: 99,
      seed: 42
    }
  })

  const model = result.model as TtsGgmlDebugModel
  t.is(model.getEngineType?.(), 'audio8')
  t.is(model._audio8LmPath, '/tmp/audio8-lm-q8_0.gguf')
  t.is(model._audio8CodecDecoderPath, '/tmp/audio8-codec-decoder-q8_0.gguf')
  t.is(model._audio8CodecEncoderPath, '/tmp/audio8-codec-encoder-q8_0.gguf')
  t.is(model._referenceText, 'Exactly what the recording says.')
  t.is(model._temperature, 0.7)
  t.is(model._topK, 50)
  t.is(model._topP, 0.9)
  t.is(model._maxFrames, 430)
  t.is(model._threads, 4)
  t.is(model._nGpuLayers, 99)
  t.is(model._seed, 42)
  t.is(model._outputSampleRate, 44100)
  t.alike(model._config, { useGPU: true, outputSampleRate: 44100 })
})
