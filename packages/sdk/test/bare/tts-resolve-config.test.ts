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
