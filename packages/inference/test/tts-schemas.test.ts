import test from 'brittle'
import {
  ttsRequestSchema,
  ttsResponseSchema,
  textToSpeechStreamRequestSchema,
  textToSpeechStreamResponseSchema,
  ttsConfigSchema,
  ttsChatterboxRuntimeConfigSchema,
  ttsParlerRuntimeConfigSchema,
  ttsSupertonicRuntimeConfigSchema,
  TTS_CHATTERBOX_LANGUAGES,
  TTS_PARLER_EMOTIONS,
  TTS_COSYVOICE3_EMOTIONS,
  TTS_PACES,
  TTS_SUPERTONIC_LANGUAGES,
  TTS_ENGINES,
  TTS_SENTENCE_DELIMITER_PRESETS,
  LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS
} from '@/schemas/text-to-speech'

test('ttsConfigSchema: accepts GGML chatterbox load config', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'en',
    s3genModelSrc: 's3:///qvac_models_compiled/chatterbox/2026-05-08/chatterbox-s3gen.gguf'
  })
  t.is(r.success, true)
})

test('ttsConfigSchema: accepts Chatterbox multilingual tokenizer assets', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'ja',
    s3genModelSrc: 's3:///example/s3gen.gguf',
    mecabDictSrc: {
      src: 'registry://s3/qvac_models_compiled/chatterbox/mecab-ipadic/char.bin',
      name: 'TTS_MECAB_IPADIC_CHATTERBOX'
    },
    cangjieTsvSrc: {
      src: 'registry://s3/qvac_models_compiled/ggml/chatterbox/2026-07-03/Cangjie5_TC.tsv',
      name: 'TTS_CANGJIE_ZH_CHATTERBOX'
    }
  })

  t.is(r.success, true)
})

test('ttsConfigSchema: requires MeCab dictionary for Chatterbox Japanese', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'ja',
    s3genModelSrc: 's3:///example/s3gen.gguf'
  })

  t.is(r.success, false)
  if (!r.success) {
    t.is(r.error.issues[0]?.path.join('.'), 'mecabDictSrc')
    t.is(r.error.issues[0]?.message, 'mecabDictSrc is required when Chatterbox language is "ja".')
  }
})

test('ttsConfigSchema: requires Cangjie TSV for Chatterbox Chinese', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'zh',
    s3genModelSrc: 's3:///example/s3gen.gguf'
  })

  t.is(r.success, false)
  if (!r.success) {
    t.is(r.error.issues[0]?.path.join('.'), 'cangjieTsvSrc')
    t.is(r.error.issues[0]?.message, 'cangjieTsvSrc is required when Chatterbox language is "zh".')
  }
})

test('ttsConfigSchema: accepts Chatterbox native constructor options', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'en',
    s3genModelSrc: 's3:///example/s3gen.gguf',
    streamChunkTokens: 25,
    streamFirstChunkTokens: 10,
    cfmSteps: 1,
    cfgRate: 0.7,
    threads: 8,
    nGpuLayers: 99,
    seed: 42
  })
  t.is(r.success, true)
  if (r.success) {
    const data = r.data as Record<string, unknown>
    t.is(data['streamChunkTokens'], 25)
    t.is(data['streamFirstChunkTokens'], 10)
    t.is(data['cfmSteps'], 1)
    t.is(data['cfgRate'], 0.7)
    t.is(data['threads'], 8)
    t.is(data['nGpuLayers'], 99)
    t.is(data['seed'], 42)
  }
})

test('ttsConfigSchema: rejects invalid Chatterbox constructor option ranges', (t) => {
  const invalidConfigs = [
    { streamChunkTokens: -1 },
    { streamFirstChunkTokens: -1 },
    { cfmSteps: -1 },
    { cfgRate: -0.1 },
    { threads: 0 },
    { nGpuLayers: 1.5 },
    { seed: 1.5 }
  ]

  for (const invalidConfig of invalidConfigs) {
    const r = ttsConfigSchema.safeParse({
      ttsEngine: 'chatterbox',
      language: 'en',
      s3genModelSrc: 's3:///example/s3gen.gguf',
      ...invalidConfig
    })
    t.is(r.success, false, JSON.stringify(invalidConfig))
  }
})

test('ttsConfigSchema: accepts LavaSR enhancer/denoiser (chatterbox)', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'en',
    s3genModelSrc: 's3:///example/s3gen.gguf',
    lavasrEnhancerModelSrc: 'registry://s3/lavasr/enhancer.gguf',
    lavasrDenoiserModelSrc: 'registry://s3/lavasr/denoiser.gguf'
  })
  t.is(r.success, true)
})

test('ttsConfigSchema: accepts outputSampleRate for chatterbox', (t) => {
  // Chatterbox does resample: @qvac/tts-ggml forwards outputSampleRate for it
  // through _assignCommonNativeParams, and JSAdapter::buildChatterboxConfig
  // reads it. This used to assert a rejection, which contradicted both the
  // addon and the SDK's own published sample-rate table.
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'en',
    s3genModelSrc: 's3:///example/s3gen.gguf',
    outputSampleRate: 48000
  })
  t.is(r.success, true, 'chatterbox must accept outputSampleRate')
  if (r.success) {
    const data = r.data as Record<string, unknown>
    t.is(data['outputSampleRate'], 48000)
  }
})

test('ttsConfigSchema: rejects outputSampleRate outside 8000-192000 for chatterbox', (t) => {
  for (const outputSampleRate of [7999, 192001]) {
    const r = ttsConfigSchema.safeParse({
      ttsEngine: 'chatterbox',
      language: 'en',
      s3genModelSrc: 's3:///example/s3gen.gguf',
      outputSampleRate
    })
    t.is(r.success, false, `chatterbox outputSampleRate ${outputSampleRate} must be rejected`)
  }
})

test('ttsConfigSchema: accepts LavaSR enhancer/denoiser + outputSampleRate (supertonic)', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'supertonic',
    language: 'en',
    lavasrEnhancerModelSrc: 'registry://s3/lavasr/enhancer.gguf',
    lavasrDenoiserModelSrc: 'registry://s3/lavasr/denoiser.gguf',
    outputSampleRate: 24000,
    vulkanCacheDir: '/data/qvac/vulkan-cache'
  })
  t.is(r.success, true)
  if (r.success) {
    const data = r.data as Record<string, unknown>
    t.is(data['outputSampleRate'], 24000)
    t.is(data['vulkanCacheDir'], '/data/qvac/vulkan-cache')
  }
})

test('ttsConfigSchema: rejects outputSampleRate outside 8000-192000', (t) => {
  for (const outputSampleRate of [7999, 192001, 44100.5]) {
    const r = ttsConfigSchema.safeParse({
      ttsEngine: 'supertonic',
      language: 'en',
      outputSampleRate
    })
    t.is(r.success, false, `outputSampleRate ${outputSampleRate} must be rejected`)
  }
})

test('ttsConfigSchema: accepts inclusive outputSampleRate boundaries', (t) => {
  for (const outputSampleRate of [8000, 192000]) {
    const r = ttsConfigSchema.safeParse({
      ttsEngine: 'supertonic',
      language: 'en',
      outputSampleRate
    })
    t.is(r.success, true, `outputSampleRate ${outputSampleRate} must be accepted`)
    if (r.success) {
      t.is(r.data.outputSampleRate, outputSampleRate)
    }
  }
})

test('ttsConfigSchema: rejects Chatterbox-only native streaming options for supertonic', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'supertonic',
    language: 'en',
    streamChunkTokens: 25
  })
  t.is(r.success, false)
})

test('ttsConfigSchema: accepts GGML supertonic load config', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'supertonic',
    language: 'en',
    voice: 'F1'
  })
  t.is(r.success, true)
})

test('ttsConfigSchema: accepts the full Parler load-time config surface', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'parler',
    voice: 'Rohit',
    emotion: 'happy',
    pitch: 'high',
    pace: 'slow',
    expressivity: 'expressive',
    noise: 'clear',
    reverb: 'close',
    quality: 'very high',
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
  })

  t.is(r.success, true)
  if (r.success) {
    const data = r.data as Record<string, unknown>
    t.is(data['emotion'], 'happy')
    t.is(data['outputSampleRate'], 44100)
    t.is(data['maxFrames'], 860)
  }
})

test('ttsConfigSchema: accepts a free-text Parler voice description', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'parler',
    voiceDescription: 'A calm female voice with very clear audio.'
  })

  t.is(r.success, true)
})

test('ttsConfigSchema: rejects conflicting Parler description and template fields', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'parler',
    description: 'A calm female voice.',
    emotion: 'happy'
  })

  t.is(r.success, false)
  if (!r.success) {
    t.is(r.error.issues[0]?.path.join('.'), 'emotion')
  }
})

test('ttsParlerRuntimeConfigSchema: validates Parler option ranges', (t) => {
  const invalidConfigs = [
    { emotion: 'angry' },
    { emotion: 'HAPPY' },
    { temperature: -0.1 },
    { topK: -1 },
    { topP: 0 },
    { topP: 1.1 },
    { maxFrames: 9 },
    { minNewTokens: -2 },
    { outputSampleRate: 7999 },
    { outputSampleRate: 16000, streamChunkTokens: 43 },
    { streamChunkTokens: 2147483648 },
    { streamFirstChunkTokens: 2147483648 },
    { threads: 2147483648 },
    { nGpuLayers: -2147483649 },
    { seed: 2147483648 },
    { topK: 2147483648 },
    { maxFrames: 2147483648 },
    { minNewTokens: 2147483648 }
  ]

  for (const invalidConfig of invalidConfigs) {
    const r = ttsParlerRuntimeConfigSchema.safeParse({
      ttsEngine: 'parler',
      ...invalidConfig
    })
    t.is(r.success, false, JSON.stringify(invalidConfig))
  }
})

test('ttsParlerRuntimeConfigSchema: allows resampling with only first-chunk tuning', (t) => {
  const r = ttsParlerRuntimeConfigSchema.safeParse({
    ttsEngine: 'parler',
    outputSampleRate: 16000,
    streamFirstChunkTokens: 20
  })

  t.is(r.success, true)
})

test('TTS_PARLER_EMOTIONS: exposes all 12 trained styles', (t) => {
  t.is(TTS_PARLER_EMOTIONS.length, 12)
  t.ok(TTS_PARLER_EMOTIONS.includes('proper noun'))
  t.ok(TTS_PARLER_EMOTIONS.includes('surprise'))
})

test('TTS_CHATTERBOX_LANGUAGES: exposes all 23 supported languages', (t) => {
  t.is(TTS_CHATTERBOX_LANGUAGES.length, 23)
  const expected = [
    'en',
    'es',
    'fr',
    'de',
    'it',
    'ja',
    'pt',
    'nl',
    'pl',
    'tr',
    'sv',
    'da',
    'fi',
    'no',
    'el',
    'ms',
    'sw',
    'ar',
    'ko',
    'he',
    'ru',
    'zh',
    'hi'
  ]
  t.alike([...TTS_CHATTERBOX_LANGUAGES], expected)
})

test('ttsChatterboxRuntimeConfigSchema: accepts all 23 chatterbox languages', (t) => {
  for (const language of TTS_CHATTERBOX_LANGUAGES) {
    const r = ttsChatterboxRuntimeConfigSchema.safeParse({
      ttsEngine: 'chatterbox',
      language
    })
    t.is(r.success, true, `chatterbox should accept ${language}`)
  }
})

test('ttsSupertonicRuntimeConfigSchema: accepts all 31 supertonic languages', (t) => {
  t.is(TTS_SUPERTONIC_LANGUAGES.length, 31)
  t.alike(
    [...TTS_SUPERTONIC_LANGUAGES],
    [
      'en',
      'ko',
      'ja',
      'ar',
      'bg',
      'cs',
      'da',
      'de',
      'el',
      'es',
      'et',
      'fi',
      'fr',
      'hi',
      'hr',
      'hu',
      'id',
      'it',
      'lt',
      'lv',
      'nl',
      'pl',
      'pt',
      'ro',
      'ru',
      'sk',
      'sl',
      'sv',
      'tr',
      'uk',
      'vi'
    ]
  )
  for (const language of TTS_SUPERTONIC_LANGUAGES) {
    const r = ttsSupertonicRuntimeConfigSchema.safeParse({
      ttsEngine: 'supertonic',
      language
    })
    t.is(r.success, true, `supertonic should accept ${language}`)
  }
})

test('ttsSupertonicRuntimeConfigSchema: rejects chatterbox-only languages', (t) => {
  // 'no' (Norwegian) is supported by chatterbox but not supertonic.
  const r = ttsSupertonicRuntimeConfigSchema.safeParse({
    ttsEngine: 'supertonic',
    language: 'no'
  })
  t.is(r.success, false, "supertonic must reject 'no'")
})

test('ttsConfigSchema: accepts a chatterbox-only language for chatterbox', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'he',
    s3genModelSrc: 's3:///example/s3gen.gguf'
  })
  t.is(r.success, true, "chatterbox load config accepts 'he'")
})

test('ttsSupertonicRuntimeConfigSchema: strips removed ttsSupertonicMultilingual', (t) => {
  const r = ttsSupertonicRuntimeConfigSchema.safeParse({
    ttsEngine: 'supertonic',
    language: 'es',
    ttsSupertonicMultilingual: true
  })
  t.is(r.success, true)
  if (r.success) {
    t.is('ttsSupertonicMultilingual' in r.data, false)
  }
})

test('ttsConfigSchema: accepts real legacy ONNX Chatterbox shape without s3genModelSrc', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'en',
    ttsSpeechEncoderSrc: 's3:///legacy/speech_encoder.onnx',
    ttsEmbedTokensSrc: 's3:///legacy/embed_tokens.onnx',
    ttsConditionalDecoderSrc: 's3:///legacy/conditional_decoder.onnx',
    ttsLanguageModelSrc: 's3:///legacy/language_model.onnx'
  })
  t.is(
    r.success,
    true,
    'legacy ONNX Chatterbox config must pass schema (plugin rejects at resolveConfig)'
  )
})

test('ttsConfigSchema: accepts legacy ONNX field names for migration errors', (t) => {
  for (const name of LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS) {
    const r = ttsConfigSchema.safeParse({
      ttsEngine: 'chatterbox',
      language: 'en',
      s3genModelSrc: 's3:///example/s3gen.gguf',
      [name]: 'legacy-value'
    })
    t.is(r.success, true, `${name} should parse (plugin rejects at resolveConfig)`)
  }
})

test('ttsConfigSchema: rejects truly unknown fields under .strict()', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'en',
    s3genModelSrc: 's3:///example/s3gen.gguf',
    notATtsField: 'anything'
  })
  t.is(r.success, false, 'non-legacy unknown fields remain strictly rejected')
})

test('ttsRequestSchema: accepts sentenceStream options', (t) => {
  const r = ttsRequestSchema.safeParse({
    type: 'textToSpeech',
    modelId: 'm1',
    text: 'Hello. World.',
    stream: true,
    sentenceStream: true,
    sentenceStreamLocale: 'en-US',
    sentenceStreamMaxChunkScalars: 200
  })
  t.is(r.success, true)
  if (r.success) {
    t.is(r.data.sentenceStream, true)
    t.is(r.data.sentenceStreamLocale, 'en-US')
    t.is(r.data.sentenceStreamMaxChunkScalars, 200)
  }
})

test('ttsRequestSchema: accepts per-call Parler voice conditioning', (t) => {
  const r = ttsRequestSchema.safeParse({
    type: 'textToSpeech',
    modelId: 'parler',
    text: 'Hello.',
    stream: false,
    voice: 'Laura',
    emotion: 'news'
  })

  t.is(r.success, true)
  if (r.success) {
    t.is(r.data.voice, 'Laura')
    t.is(r.data.emotion, 'news')
  }
})

test('ttsRequestSchema: rejects conflicting per-call Parler descriptions', (t) => {
  const conflicts = [
    { description: 'A calm voice.', emotion: 'happy' },
    { description: 'A calm voice.', voiceDescription: 'A second description.' }
  ]

  for (const conflict of conflicts) {
    const r = ttsRequestSchema.safeParse({
      type: 'textToSpeech',
      modelId: 'parler',
      text: 'Hello.',
      ...conflict
    })
    t.is(r.success, false, JSON.stringify(conflict))
  }
})

test('textToSpeechStreamRequestSchema: rejects conflicting Parler descriptions', (t) => {
  const r = textToSpeechStreamRequestSchema.safeParse({
    type: 'textToSpeechStream',
    modelId: 'parler',
    description: 'A calm voice.',
    pace: 'fast'
  })

  t.is(r.success, false)
})

test('ttsResponseSchema: accepts optional chunk metadata', (t) => {
  const r = ttsResponseSchema.safeParse({
    type: 'textToSpeech',
    buffer: [1, 2, 3],
    done: false,
    chunkIndex: 0,
    sentenceChunk: 'Hello.'
  })
  t.is(r.success, true)
  if (r.success) {
    t.is(r.data.chunkIndex, 0)
    t.is(r.data.sentenceChunk, 'Hello.')
  }
})

test('ttsResponseSchema: accepts LavaSR enhancer backend stats', (t) => {
  const r = ttsResponseSchema.safeParse({
    type: 'textToSpeech',
    buffer: [],
    done: true,
    stats: {
      enhancerBackendDevice: 1,
      enhancerBackendId: 3
    }
  })

  t.is(r.success, true)
  if (r.success) {
    t.is(r.data.stats?.enhancerBackendDevice, 1)
    t.is(r.data.stats?.enhancerBackendId, 3)
  }
})

// =============================================================================
// textToSpeechStreamResponseSchema
// =============================================================================

test('textToSpeechStreamResponseSchema: accepts minimal valid response', (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: 'textToSpeechStream',
    buffer: [1, 2, 3]
  })
  t.is(r.success, true)
  if (r.success) {
    t.is(r.data.type, 'textToSpeechStream')
    t.alike(r.data.buffer, [1, 2, 3])
    t.is(r.data.done, false, 'done defaults to false')
  }
})

test('textToSpeechStreamResponseSchema: accepts done response with stats', (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: 'textToSpeechStream',
    buffer: [],
    done: true,
    stats: { audioDuration: 1200, totalSamples: 48000 }
  })
  t.is(r.success, true)
  if (r.success) {
    t.is(r.data.done, true)
    t.is(r.data.stats?.audioDuration, 1200)
    t.is(r.data.stats?.totalSamples, 48000)
  }
})

test('textToSpeechStreamResponseSchema: accepts optional chunk metadata', (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: 'textToSpeechStream',
    buffer: [10, 20],
    chunkIndex: 3,
    sentenceChunk: 'World.'
  })
  t.is(r.success, true)
  if (r.success) {
    t.is(r.data.chunkIndex, 3)
    t.is(r.data.sentenceChunk, 'World.')
  }
})

test('textToSpeechStreamResponseSchema: rejects wrong type literal', (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: 'textToSpeech',
    buffer: [1, 2, 3]
  })
  t.is(r.success, false, 'wrong type literal is rejected')
})

test('textToSpeechStreamResponseSchema: rejects missing buffer', (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: 'textToSpeechStream'
  })
  t.is(r.success, false, 'missing buffer is rejected')
})

// === CosyVoice3 ===

test('ttsConfigSchema: accepts the full CosyVoice3 load surface', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    emotion: 'happy',
    useGPU: true,
    outputSampleRate: 24000,
    streamChunkTokens: 25,
    streamFirstChunkTokens: 10,
    threads: 4,
    nGpuLayers: 99,
    seed: 42,
    lavasrEnhancerModelSrc: 's3:///example/lavasr-enhancer.gguf',
    lavasrDenoiserModelSrc: 's3:///example/lavasr-denoiser.gguf'
  })
  t.is(r.success, false, 'denoiser is batch-only, native streaming conflicts')

  const withoutDenoiser = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    emotion: 'happy',
    useGPU: true,
    outputSampleRate: 24000,
    streamChunkTokens: 25,
    streamFirstChunkTokens: 10,
    threads: 4,
    nGpuLayers: 99,
    seed: 42,
    lavasrEnhancerModelSrc: 's3:///example/lavasr-enhancer.gguf'
  })
  t.is(withoutDenoiser.success, true)
})

test('ttsConfigSchema: accepts CosyVoice3 structured and raw-string instruct', (t) => {
  const structured = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    instruct: { dialect: 'cantonese' }
  })
  t.is(structured.success, true)

  const raw = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    instruct: '请用广东话表达。'
  })
  t.is(raw.success, true)
})

test('ttsConfigSchema: rejects empty or unknown CosyVoice3 instruct controls', (t) => {
  const empty = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    instruct: {}
  })
  t.is(empty.success, false, 'instruct object requires at least one control')

  // The addon trims raw-string instructions, so a whitespace-only string would
  // silently disengage conditioning (zero-shot) instead of erroring.
  const whitespace = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    instruct: '   '
  })
  t.is(whitespace.success, false, 'whitespace-only instruct strings are rejected')

  const unknown = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    instruct: { emotion: 'happy' }
  })
  t.is(unknown.success, false, 'emotion is a top-level option, not an instruct key')
})

test('ttsConfigSchema: enforces the CosyVoice3 one-instruction rule', (t) => {
  const emotionAndInstruct = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    emotion: 'happy',
    instruct: { volume: 'loud' }
  })
  t.is(emotionAndInstruct.success, false)
  if (!emotionAndInstruct.success) {
    t.ok(emotionAndInstruct.error.issues[0]?.message.includes('one conditioning control'))
  }

  const emotionAndPace = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    emotion: 'sad',
    pace: 'slow'
  })
  t.is(emotionAndPace.success, false)

  const moderatePaceDisengages = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    emotion: 'sad',
    pace: 'moderate'
  })
  t.is(moderatePaceDisengages.success, true, 'pace "moderate" disengages the pace channel')
})

test('ttsConfigSchema: restricts CosyVoice3 emotions to the supported subset', (t) => {
  for (const emotion of TTS_COSYVOICE3_EMOTIONS) {
    const r = ttsConfigSchema.safeParse({ ttsEngine: 'cosyvoice3', emotion })
    t.is(r.success, true, `emotion "${emotion}" is accepted`)
  }

  const unsupported = ttsConfigSchema.safeParse({ ttsEngine: 'cosyvoice3', emotion: 'fear' })
  t.is(unsupported.success, false, 'cross-engine emotion outside the CosyVoice3 subset is rejected')
})

test('ttsConfigSchema: pins CosyVoice3 native streaming to 24 kHz without the enhancer', (t) => {
  const mismatch = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    streamChunkTokens: 25,
    outputSampleRate: 48000
  })
  t.is(mismatch.success, false)
  if (!mismatch.success) {
    t.is(mismatch.error.issues[0]?.path.join('.'), 'outputSampleRate')
  }

  const withEnhancer = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    streamChunkTokens: 25,
    outputSampleRate: 48000,
    lavasrEnhancerModelSrc: 's3:///example/lavasr-enhancer.gguf'
  })
  t.is(withEnhancer.success, true, 'the enhancer resamples seam-free')

  const batchResample = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    outputSampleRate: 16000
  })
  t.is(batchResample.success, true, 'batch synthesis resamples freely')
})

test('ttsConfigSchema: rejects sampling options on CosyVoice3', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'cosyvoice3',
    temperature: 0.7
  })
  t.is(r.success, false, 'temperature is a Parler/Audio8 option')
})

test('TTS_COSYVOICE3_EMOTIONS and TTS_PACES expose the canonical vocabularies', (t) => {
  t.alike([...TTS_COSYVOICE3_EMOTIONS], ['anger', 'happy', 'neutral', 'sad'])
  t.alike([...TTS_PACES], ['slow', 'moderate', 'fast'])
  for (const emotion of TTS_COSYVOICE3_EMOTIONS) {
    t.ok(
      (TTS_PARLER_EMOTIONS as readonly string[]).includes(emotion),
      `"${emotion}" is part of the cross-engine vocabulary`
    )
  }
})

test('ttsRequestSchema: rejects free-form pace strings', (t) => {
  const r = ttsRequestSchema.safeParse({
    type: 'textToSpeech',
    modelId: 'parler',
    text: 'Hello.',
    pace: 'very fast'
  })
  t.is(r.success, false, 'pace uses the canonical vocabulary since tts-ggml 0.7')

  const ok = ttsRequestSchema.safeParse({
    type: 'textToSpeech',
    modelId: 'parler',
    text: 'Hello.',
    pace: 'fast'
  })
  t.is(ok.success, true)
})

// === Audio8 ===

test('ttsConfigSchema: accepts the full Audio8 load surface', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: 's3:///example/audio8-codec-decoder-q8_0.gguf',
    audio8CodecEncoderModelSrc: 's3:///example/audio8-codec-encoder-q8_0.gguf',
    referenceAudioSrc: 's3:///example/voice.wav',
    referenceText: 'Exactly what the recording says.',
    greedy: true,
    temperature: 0.7,
    topK: 50,
    topP: 0.9,
    maxFrames: 430,
    useGPU: true,
    outputSampleRate: 44100,
    threads: 4,
    nGpuLayers: 99,
    seed: 42
  })
  t.is(r.success, true)
})

test('ttsConfigSchema: requires the Audio8 codec decoder source', (t) => {
  const r = ttsConfigSchema.safeParse({ ttsEngine: 'audio8' })
  t.is(r.success, false, 'audio8CodecDecoderModelSrc is required')
})

test('ttsConfigSchema: rejects a whitespace-only Audio8 referenceText', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
    audio8CodecEncoderModelSrc: 's3:///example/encoder.gguf',
    referenceAudioSrc: 's3:///example/voice.wav',
    referenceText: '   '
  })
  t.is(r.success, false, 'a whitespace-only transcript must not reach the engine')
})

test('ttsConfigSchema: enforces the Audio8 voice-cloning pairing rules', (t) => {
  const missingTranscript = ttsConfigSchema.safeParse({
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
    audio8CodecEncoderModelSrc: 's3:///example/encoder.gguf',
    referenceAudioSrc: 's3:///example/voice.wav'
  })
  t.is(missingTranscript.success, false)
  if (!missingTranscript.success) {
    t.is(missingTranscript.error.issues[0]?.path.join('.'), 'referenceText')
  }

  const missingRecording = ttsConfigSchema.safeParse({
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
    referenceText: 'A transcript without a recording.'
  })
  t.is(missingRecording.success, false)
  if (!missingRecording.success) {
    t.is(missingRecording.error.issues[0]?.path.join('.'), 'referenceAudioSrc')
  }

  const missingEncoder = ttsConfigSchema.safeParse({
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
    referenceAudioSrc: 's3:///example/voice.wav',
    referenceText: 'Exactly what the recording says.'
  })
  t.is(missingEncoder.success, false)
  if (!missingEncoder.success) {
    t.is(missingEncoder.error.issues[0]?.path.join('.'), 'audio8CodecEncoderModelSrc')
  }
})

test('ttsConfigSchema: rejects conditioning and LavaSR options on Audio8', (t) => {
  const emotion = ttsConfigSchema.safeParse({
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
    emotion: 'happy'
  })
  t.is(emotion.success, false, 'Audio8 has no emotion vocabulary')

  const lavasr = ttsConfigSchema.safeParse({
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
    lavasrEnhancerModelSrc: 's3:///example/lavasr-enhancer.gguf'
  })
  t.is(lavasr.success, false, 'Audio8 emits native 44.1 kHz, LavaSR is rejected')

  const streaming = ttsConfigSchema.safeParse({
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
    streamChunkTokens: 25
  })
  t.is(streaming.success, false, 'Audio8 has no native chunk streaming')
})

test('ttsConfigSchema: validates Audio8 sampling ranges', (t) => {
  const badTopP = ttsConfigSchema.safeParse({
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
    topP: 1.5
  })
  t.is(badTopP.success, false)

  const negativeTemperature = ttsConfigSchema.safeParse({
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
    temperature: -1
  })
  t.is(negativeTemperature.success, false)
})

// === Chatterbox parity with @qvac/tts-ggml ===

function chatterbox(extra: Record<string, unknown>) {
  return ttsConfigSchema.safeParse({
    ttsEngine: 'chatterbox',
    language: 'en',
    s3genModelSrc: 's3:///example/s3gen.gguf',
    ...extra
  })
}

test('ttsConfigSchema: accepts Chatterbox ttsSpeed inside the WSOLA range', (t) => {
  for (const ttsSpeed of [0.25, 1, 4]) {
    t.is(chatterbox({ ttsSpeed }).success, true, `ttsSpeed ${ttsSpeed} must be accepted`)
  }
})

test('ttsConfigSchema: rejects Chatterbox ttsSpeed outside the WSOLA range', (t) => {
  // ChatterboxModel.cpp rejects anything outside [0.25, 4.0]; catching it here
  // turns a native throw into a field-level validation error.
  for (const ttsSpeed of [0.2, 4.1, 0]) {
    t.is(chatterbox({ ttsSpeed }).success, false, `ttsSpeed ${ttsSpeed} must be rejected`)
  }
})

test('ttsConfigSchema: accepts Chatterbox nCtx and kvCacheType', (t) => {
  const r = chatterbox({ nCtx: 1000, kvCacheType: 'q8_0' })
  t.is(r.success, true)
  if (r.success) {
    const data = r.data as Record<string, unknown>
    t.is(data['nCtx'], 1000)
    t.is(data['kvCacheType'], 'q8_0')
  }

  t.is(chatterbox({ nCtx: -1 }).success, false, 'negative nCtx must be rejected')
  t.is(chatterbox({ kvCacheType: 'q4_0' }).success, false, 'unknown kvCacheType must be rejected')
})

test('ttsConfigSchema: rejects the Chatterbox LavaSR denoiser with native chunk streaming', (t) => {
  // The addon's guard is engine-agnostic; it was previously mirrored for
  // CosyVoice3 only, so this combination reached a raw addon throw.
  const r = chatterbox({
    lavasrDenoiserModelSrc: 'registry://s3/lavasr/denoiser.gguf',
    streamChunkTokens: 25
  })
  t.is(r.success, false)
  if (!r.success) {
    t.is(r.error.issues[0]?.path.join('.'), 'lavasrDenoiserModelSrc')
  }

  t.is(
    chatterbox({ lavasrDenoiserModelSrc: 'registry://s3/lavasr/denoiser.gguf' }).success,
    true,
    'batch synthesis still accepts the denoiser'
  )
})

// === Supertonic parity with @qvac/tts-ggml ===

function supertonic(extra: Record<string, unknown>) {
  return ttsConfigSchema.safeParse({ ttsEngine: 'supertonic', language: 'en', ...extra })
}

test('ttsConfigSchema: accepts the Supertonic backend knobs the addon honours', (t) => {
  const r = supertonic({ threads: 4, nGpuLayers: 99, seed: 7 })
  t.is(r.success, true)
  if (r.success) {
    const data = r.data as Record<string, unknown>
    t.is(data['threads'], 4)
    t.is(data['nGpuLayers'], 99)
    t.is(data['seed'], 7)
  }
})

test('ttsConfigSchema: accepts Supertonic pace', (t) => {
  for (const pace of TTS_PACES) {
    t.is(supertonic({ pace }).success, true, `pace ${pace} must be accepted`)
  }
})

test('ttsConfigSchema: rejects Supertonic pace together with ttsSpeed', (t) => {
  // SupertonicConfig.hpp: "Exact rate multiplier. Mutually exclusive with
  // `pace` (engine rejects)."
  const r = supertonic({ pace: 'fast', ttsSpeed: 1.2 })
  t.is(r.success, false)
  if (!r.success) {
    t.is(r.error.issues[0]?.path.join('.'), 'pace')
  }
})

test('ttsConfigSchema: rejects a negative Supertonic ttsSpeed', (t) => {
  t.is(supertonic({ ttsSpeed: -1 }).success, false)
})

// === Parler LavaSR ===

test('ttsConfigSchema: accepts the LavaSR sources for Parler', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'parler',
    lavasrEnhancerModelSrc: 'registry://s3/lavasr/enhancer.gguf',
    lavasrDenoiserModelSrc: 'registry://s3/lavasr/denoiser.gguf'
  })
  t.is(r.success, true, 'Parler is one of the four engines whose native config reads LavaSR')
})

test('ttsConfigSchema: rejects the Parler LavaSR denoiser with native chunk streaming', (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: 'parler',
    lavasrDenoiserModelSrc: 'registry://s3/lavasr/denoiser.gguf',
    streamChunkTokens: 25
  })
  t.is(r.success, false)
})

// === CosyVoice3 voice cloning ===

function cosyvoice3(extra: Record<string, unknown>) {
  return ttsConfigSchema.safeParse({ ttsEngine: 'cosyvoice3', ...extra })
}

test('ttsConfigSchema: accepts a complete CosyVoice3 zero-shot cloning config', (t) => {
  const r = cosyvoice3({
    referenceAudioSrc: 's3:///example/reference.wav',
    cosyvoice3S3tokModelSrc: 'registry://s3/cosyvoice3-s3tok-f16.gguf',
    cosyvoice3CampplusModelSrc: 'registry://s3/cosyvoice3-campplus-f32.gguf',
    promptText: 'the verbatim transcript of the recording'
  })
  t.is(r.success, true)
  if (r.success) {
    const data = r.data as Record<string, unknown>
    t.is(data['promptText'], 'the verbatim transcript of the recording')
  }
})

test('ttsConfigSchema: accepts CosyVoice3 cross-lingual cloning (no promptText)', (t) => {
  // Omitting promptText is what selects cross-lingual mode, so it must not be
  // required alongside the reference recording.
  const r = cosyvoice3({
    referenceAudioSrc: 's3:///example/reference.wav',
    cosyvoice3S3tokModelSrc: 'registry://s3/cosyvoice3-s3tok-f16.gguf',
    cosyvoice3CampplusModelSrc: 'registry://s3/cosyvoice3-campplus-f32.gguf'
  })
  t.is(r.success, true)
})

test('ttsConfigSchema: rejects CosyVoice3 reference audio without the cloning GGUFs', (t) => {
  // The addon fails the native load rather than falling back to the baked
  // voice, so the incomplete set has to be caught here.
  const noS3tok = cosyvoice3({
    referenceAudioSrc: 's3:///example/reference.wav',
    cosyvoice3CampplusModelSrc: 'registry://s3/cosyvoice3-campplus-f32.gguf'
  })
  t.is(noS3tok.success, false)
  if (!noS3tok.success) {
    t.is(noS3tok.error.issues[0]?.path.join('.'), 'cosyvoice3S3tokModelSrc')
  }

  const noCampplus = cosyvoice3({
    referenceAudioSrc: 's3:///example/reference.wav',
    cosyvoice3S3tokModelSrc: 'registry://s3/cosyvoice3-s3tok-f16.gguf'
  })
  t.is(noCampplus.success, false)
  if (!noCampplus.success) {
    t.is(noCampplus.error.issues[0]?.path.join('.'), 'cosyvoice3CampplusModelSrc')
  }
})

test('ttsConfigSchema: rejects CosyVoice3 cloning GGUFs without a reference recording', (t) => {
  const r = cosyvoice3({ cosyvoice3S3tokModelSrc: 'registry://s3/cosyvoice3-s3tok-f16.gguf' })
  t.is(r.success, false)
  if (!r.success) {
    t.is(r.error.issues[0]?.path.join('.'), 'referenceAudioSrc')
  }
})

test('ttsConfigSchema: accepts CosyVoice3 promptText without a reference recording', (t) => {
  // Without referenceAudioSrc it still overrides the baked voice's transcript
  // metadata for the LM prompt.
  t.is(cosyvoice3({ promptText: 'baked voice transcript' }).success, true)
  t.is(cosyvoice3({ promptText: '   ' }).success, false, 'whitespace-only must be rejected')
})

// === ggml backend knobs ===

test('ttsConfigSchema: accepts backendsDir on every engine', (t) => {
  t.is(chatterbox({ backendsDir: '/opt/backends' }).success, true)
  t.is(supertonic({ backendsDir: '/opt/backends' }).success, true)
  t.is(ttsConfigSchema.safeParse({ ttsEngine: 'parler', backendsDir: '/o' }).success, true)
  t.is(cosyvoice3({ backendsDir: '/opt/backends' }).success, true)
  t.is(
    ttsConfigSchema.safeParse({
      ttsEngine: 'audio8',
      audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
      backendsDir: '/opt/backends'
    }).success,
    true
  )
})

test('ttsConfigSchema: exposes openclCacheDir only where the native config reads it', (t) => {
  t.is(chatterbox({ openclCacheDir: '/cache/opencl' }).success, true)
  t.is(supertonic({ openclCacheDir: '/cache/opencl' }).success, true)
  t.is(cosyvoice3({ openclCacheDir: '/cache/opencl' }).success, true)

  // JSAdapter's Parler and Audio8 builders never read openclCacheDir, so the
  // SDK must not pretend they do.
  t.is(
    ttsConfigSchema.safeParse({ ttsEngine: 'parler', openclCacheDir: '/cache/opencl' }).success,
    false
  )
  t.is(
    ttsConfigSchema.safeParse({
      ttsEngine: 'audio8',
      audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
      openclCacheDir: '/cache/opencl'
    }).success,
    false
  )
})

// === GPU intent ===

test('ttsConfigSchema: rejects a useGPU that contradicts nGpuLayers', (t) => {
  // Mirrors the addon's assertGpuIntentConsistent, which throws at construction.
  t.is(chatterbox({ useGPU: false, nGpuLayers: 99 }).success, false)
  t.is(chatterbox({ useGPU: true, nGpuLayers: 0 }).success, false)
  t.is(supertonic({ useGPU: false, nGpuLayers: 99 }).success, false)
  t.is(cosyvoice3({ useGPU: true, nGpuLayers: 0 }).success, false)
  t.is(
    ttsConfigSchema.safeParse({ ttsEngine: 'parler', useGPU: false, nGpuLayers: 1 }).success,
    false
  )
  t.is(
    ttsConfigSchema.safeParse({
      ttsEngine: 'audio8',
      audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf',
      useGPU: false,
      nGpuLayers: 99
    }).success,
    false
  )
})

test('ttsConfigSchema: accepts agreeing or partial GPU intent', (t) => {
  t.is(chatterbox({ useGPU: true, nGpuLayers: 99 }).success, true)
  t.is(chatterbox({ useGPU: false, nGpuLayers: 0 }).success, true)
  t.is(chatterbox({ nGpuLayers: 99 }).success, true, 'nGpuLayers alone states the intent')
  t.is(chatterbox({ useGPU: true }).success, true, 'useGPU alone states the intent')
})

// === Response surface ===

test('ttsResponseSchema: carries sampleRate and isLast', (t) => {
  const r = ttsResponseSchema.safeParse({
    type: 'textToSpeech',
    buffer: [1, 2, 3],
    sampleRate: 48000,
    chunkIndex: 0,
    sentenceChunk: 'Hello.',
    isLast: true
  })
  t.is(r.success, true)
  if (r.success) {
    t.is(r.data.sampleRate, 48000)
    t.is(r.data.isLast, true)
  }

  t.is(
    ttsResponseSchema.safeParse({ type: 'textToSpeech', buffer: [], sampleRate: 0 }).success,
    false,
    'a zero sample rate is not a rate'
  )
})

test('textToSpeechStreamResponseSchema: carries sampleRate and isLast', (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: 'textToSpeechStream',
    buffer: [1],
    sampleRate: 24000,
    isLast: false
  })
  t.is(r.success, true)
  if (r.success) {
    t.is(r.data.sampleRate, 24000)
    t.is(r.data.isLast, false)
  }
})

test('ttsStatsSchema: carries the addon RuntimeStats surface', (t) => {
  const r = ttsResponseSchema.safeParse({
    type: 'textToSpeech',
    buffer: [],
    done: true,
    stats: {
      audioDuration: 1200,
      totalTime: 400,
      realTimeFactor: 0.33,
      tokensPerSecond: 75,
      totalSamples: 28800,
      generatedFrames: 26,
      backendDevice: 1,
      backendId: 1,
      gpuUnsupported: 0,
      enhancerBackendDevice: 0,
      enhancerBackendId: 0
    }
  })
  t.is(r.success, true)
  if (r.success) {
    t.is(r.data.stats?.realTimeFactor, 0.33)
    t.is(r.data.stats?.backendId, 1)
    t.is(r.data.stats?.generatedFrames, 26)
  }
})

test('TTS_ENGINES matches the ttsEngine discriminator of every config arm', (t) => {
  // The exported constant is the machine-readable engine list; it must not
  // drift from the discriminated union it describes.
  const fromUnion = [
    ttsConfigSchema.safeParse({ ttsEngine: 'chatterbox', language: 'en' }),
    ttsConfigSchema.safeParse({ ttsEngine: 'supertonic', language: 'en' }),
    ttsConfigSchema.safeParse({ ttsEngine: 'parler' }),
    ttsConfigSchema.safeParse({ ttsEngine: 'cosyvoice3' }),
    ttsConfigSchema.safeParse({
      ttsEngine: 'audio8',
      audio8CodecDecoderModelSrc: 's3:///example/decoder.gguf'
    })
  ]
  t.is(fromUnion.length, TTS_ENGINES.length, 'one arm per exported engine')
  for (const engine of TTS_ENGINES) {
    const r = ttsConfigSchema.safeParse({ ttsEngine: engine })
    // Some arms need required companions; what matters is that the
    // discriminator itself is recognised, i.e. no "invalid union" issue.
    const unrecognised =
      !r.success && r.error.issues.some((issue) => issue.path.join('.') === 'ttsEngine')
    t.is(unrecognised, false, `${engine} must be a recognised ttsEngine`)
  }
})

test('TTS_SENTENCE_DELIMITER_PRESETS drives the stream request schema', (t) => {
  for (const preset of TTS_SENTENCE_DELIMITER_PRESETS) {
    const r = textToSpeechStreamRequestSchema.safeParse({
      type: 'textToSpeechStream',
      modelId: 'm',
      sentenceDelimiterPreset: preset
    })
    t.is(r.success, true, `${preset} must be accepted`)
  }
  const bad = textToSpeechStreamRequestSchema.safeParse({
    type: 'textToSpeechStream',
    modelId: 'm',
    sentenceDelimiterPreset: 'cyrillic'
  })
  t.is(bad.success, false)
})
