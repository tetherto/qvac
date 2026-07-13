import test from 'brittle'
import { ttsConfigSchema } from '@/schemas/text-to-speech'
import { LegacyTtsModelDeprecatedError } from '@/utils/errors-server'

type TtsGgmlDebugModel = {
  _streamChunkTokens?: number
  _streamFirstChunkTokens?: number
  _cfmSteps?: number
  _threads?: number
  _nGpuLayers?: number
  _seed?: number
  _mecabDictPath?: string
  _cangjieTsvPath?: string
  _enhancerGgufPath?: string
  _denoiserGgufPath?: string
  _outputSampleRate?: number | null
  _config?: {
    language?: string
    useGPU?: boolean
    outputSampleRate?: number
  }
}

test('ttsPlugin resolveConfig: legacy ONNX Chatterbox shape throws LegacyTtsModelDeprecatedError', async (t) => {
  const { ttsPlugin } = await import('@/server/bare/plugins/tts-ggml/plugin')
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
  const { ttsPlugin } = await import('@/server/bare/plugins/tts-ggml/plugin')

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
      threads: 8,
      nGpuLayers: 99,
      seed: 42
    }
  })

  const model = result.model as TtsGgmlDebugModel
  t.is(model._streamChunkTokens, 25)
  t.is(model._streamFirstChunkTokens, 10)
  t.is(model._cfmSteps, 1)
  t.is(model._threads, 8)
  t.is(model._nGpuLayers, 99)
  t.is(model._seed, 42)
  t.alike(model._config, { language: 'en', useGPU: true })
})

test('ttsPlugin resolveConfig: resolves Chatterbox multilingual tokenizer assets', async (t) => {
  const { ttsPlugin } = await import('@/server/bare/plugins/tts-ggml/plugin')
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
  const { ttsPlugin } = await import('@/server/bare/plugins/tts-ggml/plugin')

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
  const { ttsPlugin } = await import('@/server/bare/plugins/tts-ggml/plugin')

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
  const { ttsPlugin } = await import('@/server/bare/plugins/tts-ggml/plugin')

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
      outputSampleRate: 48000
    }
  })

  const model = result.model as TtsGgmlDebugModel
  t.is(model._enhancerGgufPath, '/tmp/lavasr-enhancer.gguf')
  t.is(model._denoiserGgufPath, '/tmp/lavasr-denoiser.gguf')
  t.is(model._outputSampleRate, 48000)
  t.is(model._config?.outputSampleRate, 48000)
})

test('ttsPlugin createModel: forwards LavaSR enhancer (chatterbox)', async (t) => {
  const { ttsPlugin } = await import('@/server/bare/plugins/tts-ggml/plugin')

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
  const { ttsPlugin } = await import('@/server/bare/plugins/tts-ggml/plugin')

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
