import test from 'brittle'
import { toTranscribeSegment } from '@/utils/transcribe-metadata'
import {
  parakeetStreamingRunConfigSchema,
  transcribeStreamResponseSchema
} from '@/schemas/transcription'
import { whisperConfigSchema } from '@/schemas/transcription-config'
import {
  buildParakeetEngineConfig,
  buildParakeetReloadConfig,
  buildWhisperEngineConfig,
  buildWhisperReloadConfig
} from '@/plugins/builtin/asr-ggml/config'
import { createAsrModelLogger } from '@/plugins/builtin/asr-ggml/logging'
import { isEndOfTurnEvent, isVadEvent, toEndOfTurnEvent, toVadStateEvent } from '@/utils/asr-events'
import { ADDON_ASR, ADDON_PARAKEET, ADDON_WHISPER } from '@/schemas/plugin'
import { LEGACY_ENGINE_TO_CANONICAL } from '@/schemas/engine-addon-map'
import { ModelType } from '@/schemas/model-types'
import { clearAllAddonLoggers, createAddonLoggerCallback, unregisterAddonLogger } from '@/logging'
import { clearAllLoggingStreams, registerLoggingStream } from '@/runtime/logging-stream-registry'

test('ASR addon constants preserve legacy engine mappings', (t) => {
  t.is(ADDON_ASR, '@qvac/asr-ggml')
  t.is(LEGACY_ENGINE_TO_CANONICAL[ADDON_WHISPER], ModelType.whispercppTranscription)
  t.is(LEGACY_ENGINE_TO_CANONICAL[ADDON_PARAKEET], ModelType.parakeetTranscription)
})

test('buildWhisperEngineConfig creates strict unified addon config', (t) => {
  const config = buildWhisperEngineConfig({
    language: 'en',
    audio_format: 's16le',
    vadModelSrc: '/models/vad.bin',
    contextParams: {
      use_gpu: true,
      gpu_device: undefined
    },
    miscConfig: {
      caption_enabled: true
    }
  })

  t.alike(config, {
    engine: 'whisper',
    whisperConfig: {
      language: 'en',
      audio_format: 's16le'
    },
    contextParams: {
      use_gpu: true
    },
    miscConfig: {
      caption_enabled: true
    }
  })
})

test('Whisper config maps detect_language to the unified auto language mode', (t) => {
  t.alike(buildWhisperEngineConfig({ language: 'fr', detect_language: true }), {
    engine: 'whisper',
    whisperConfig: {
      language: 'auto'
    }
  })
  t.alike(buildWhisperReloadConfig({ language: 'fr', detect_language: false }), {
    whisperConfig: {
      language: 'fr'
    }
  })
})

test('Whisper config forwards carry_initial_prompt and the main-gpu selector', (t) => {
  t.alike(
    buildWhisperEngineConfig({
      initial_prompt: 'QVAC',
      carry_initial_prompt: true,
      contextParams: { use_gpu: true, 'main-gpu': 'dedicated' }
    }),
    {
      engine: 'whisper',
      whisperConfig: {
        initial_prompt: 'QVAC',
        carry_initial_prompt: true
      },
      contextParams: {
        use_gpu: true,
        'main-gpu': 'dedicated'
      }
    }
  )
  t.alike(
    buildWhisperReloadConfig({ carry_initial_prompt: false }),
    { whisperConfig: { carry_initial_prompt: false } },
    'carry_initial_prompt is a reloadable whisperConfig key'
  )
})

test('whisperConfigSchema accepts main-gpu and rejects conflicting selectors', (t) => {
  t.ok(whisperConfigSchema.safeParse({ carry_initial_prompt: true }).success)
  t.ok(whisperConfigSchema.safeParse({ contextParams: { 'main-gpu': 0 } }).success)
  t.ok(whisperConfigSchema.safeParse({ contextParams: { 'main-gpu': '1' } }).success)
  t.ok(whisperConfigSchema.safeParse({ contextParams: { 'main-gpu': 'integrated' } }).success)
  t.ok(whisperConfigSchema.safeParse({ contextParams: { gpu_device: 1 } }).success)
  // The addon's validateMainGpu() vocabulary: a non-negative 32-bit registry
  // index (number or digit string), 'dedicated', or 'integrated'.
  for (const selector of [
    1.5,
    -1,
    2147483648,
    'auto',
    '1.5',
    '-1',
    '2147483648',
    'Dedicated',
    ''
  ]) {
    t.absent(
      whisperConfigSchema.safeParse({ contextParams: { 'main-gpu': selector } }).success,
      `main-gpu rejects ${JSON.stringify(selector)} before model load`
    )
  }
  t.ok(whisperConfigSchema.safeParse({ contextParams: { 'main-gpu': 2147483647 } }).success)
  // The addon's `main_gpu` spelling is not SDK vocabulary: the generated
  // Python model's `main_gpu` field already serialises to `main-gpu`, and a
  // second wire key of that name would make it emit both spellings.
  t.alike(
    whisperConfigSchema.parse({ contextParams: { main_gpu: 'integrated' } }).contextParams,
    {},
    'the snake_case spelling is dropped like any other unknown context key'
  )
  const withLegacy = whisperConfigSchema.safeParse({
    contextParams: { 'main-gpu': 'dedicated', gpu_device: 0 }
  })
  t.absent(withLegacy.success, 'main-gpu combined with the legacy gpu_device is rejected')
  if (!withLegacy.success) {
    t.ok(
      withLegacy.error.issues.some((issue) => issue.message.includes('gpu_device')),
      'the error names gpu_device'
    )
  }
  t.absent(
    whisperConfigSchema.partial().strict().safeParse({ 'main-gpu': 0 }).success,
    'main-gpu belongs under contextParams, not at the top level'
  )
})

test('buildParakeetEngineConfig removes undefined addon fields', (t) => {
  const config = buildParakeetEngineConfig({
    useGPU: true,
    maxThreads: undefined
  })

  t.alike(config, {
    engine: 'parakeet',
    parakeetConfig: {
      useGPU: true
    }
  })
})

test('buildParakeetEngineConfig forwards Indic Conformer language', (t) => {
  const config = buildParakeetEngineConfig({
    language: 'hi',
    useGPU: true
  })

  t.alike(config, {
    engine: 'parakeet',
    parakeetConfig: {
      language: 'hi',
      useGPU: true
    }
  })
})

test('ASR reload config builders keep engine-specific wrappers', (t) => {
  t.alike(
    buildWhisperReloadConfig({
      language: 'fr',
      contextParams: { use_gpu: true },
      vadModelSrc: '/models/vad.bin'
    }),
    {
      whisperConfig: {
        language: 'fr'
      }
    }
  )
  t.alike(buildParakeetReloadConfig({ streamingChunkMs: 480, language: 'ta' }), {
    parakeetConfig: {
      streamingChunkMs: 480,
      language: 'ta'
    }
  })
})

test('Whisper prompt reload strips engine-only keys for asr-ggml', (t) => {
  const originalConfig = {
    language: 'en',
    detect_language: true,
    vadModelSrc: '/models/vad.bin',
    initial_prompt: 'old prompt',
    miscConfig: {
      caption_enabled: true
    }
  }

  t.alike(buildWhisperReloadConfig({ ...originalConfig, initial_prompt: 'new prompt' }), {
    whisperConfig: {
      language: 'auto',
      initial_prompt: 'new prompt'
    },
    miscConfig: {
      caption_enabled: true
    }
  })
  t.alike(buildWhisperReloadConfig({ ...originalConfig, initial_prompt: '' }), {
    whisperConfig: {
      language: 'auto',
      initial_prompt: ''
    },
    miscConfig: {
      caption_enabled: true
    }
  })
})

test('ASR model loggers isolate Whisper and Parakeet streams', (t) => {
  const whisperModelId = 'asr-whisper-logging-test'
  const parakeetModelId = 'asr-parakeet-logging-test'
  const whisperLogs: string[] = []
  const parakeetLogs: string[] = []

  clearAllAddonLoggers()
  clearAllLoggingStreams()
  t.teardown(() => {
    unregisterAddonLogger(whisperModelId)
    unregisterAddonLogger(parakeetModelId)
    clearAllAddonLoggers()
    clearAllLoggingStreams()
  })

  registerLoggingStream(whisperModelId, (_level, _namespace, message) => {
    whisperLogs.push(message)
  })
  registerLoggingStream(parakeetModelId, (_level, _namespace, message) => {
    parakeetLogs.push(message)
  })

  const whisperLogger = createAsrModelLogger(whisperModelId, ModelType.whispercppTranscription)
  const parakeetLogger = createAsrModelLogger(parakeetModelId, ModelType.parakeetTranscription)

  whisperLogger.info('whisper-only')
  parakeetLogger.info('parakeet-only')
  createAddonLoggerCallback(ADDON_ASR)(2, 'shared-native-log')

  t.alike(whisperLogs, ['whisper-only'])
  t.alike(parakeetLogs, ['parakeet-only'])
})

test('ASR event adapters preserve the public engine event contract', (t) => {
  t.ok(
    isVadEvent({
      type: 'vad',
      speaking: true,
      score: 0.87,
      source: 'silero'
    })
  )
  t.ok(
    isVadEvent({
      type: 'vad',
      speaking: true,
      score: 0.82,
      source: 'sortformer'
    })
  )
  t.ok(
    isEndOfTurnEvent({
      type: 'endOfTurn',
      source: 'model-eou'
    })
  )
  t.absent(isVadEvent({ text: 'vad-like segment', type: 'vad' }))
  t.alike(
    toVadStateEvent({
      type: 'vad',
      speaking: true,
      score: 0.87,
      source: 'silero'
    }),
    {
      speaking: true,
      probability: 0.87,
      // The detector is carried through so callers can tell whisper's silero
      // VAD from parakeet's energy hint.
      source: 'silero'
    }
  )
  // Parakeet stamps its events with the session time; the native chunk index
  // stays an engine detail. It is not part of the published addon typings, so
  // it rides along on a widened value rather than an object literal.
  const nativeVad = {
    type: 'vad',
    speaking: false,
    score: 0.1,
    source: 'energy',
    timestamp: 2.5,
    chunkIndex: 3
  } as const
  const stamped = toVadStateEvent(nativeVad)
  t.alike(stamped, { speaking: false, probability: 0.1, source: 'energy', timestamp: 2.5 })
  t.is(
    transcribeStreamResponseSchema.parse({ type: 'transcribeStream', vad: stamped }).vad?.timestamp,
    2.5
  )
  t.alike(
    toEndOfTurnEvent({
      type: 'endOfTurn',
      source: 'vad-silence',
      silenceDurationMs: 800
    }),
    {
      source: 'whisper',
      silenceDurationMs: 800
    }
  )
  t.alike(
    toEndOfTurnEvent({
      type: 'endOfTurn',
      source: 'model-eou'
    }),
    {
      source: 'parakeet'
    }
  )
  t.is(
    toEndOfTurnEvent({
      type: 'endOfTurn',
      source: 'vad-silence'
    }),
    null
  )
})

test('Parakeet energy-VAD tuning and prewarm reach the addon at load, on reload and per stream', (t) => {
  const config = {
    streaming: true,
    streamingEnergyVad: true,
    streamingEnergyVadThresholdDb: -40,
    streamingEnergyVadWindowMs: 50,
    streamingEnergyVadHangoverMs: 300,
    prewarm: true,
    prewarmAudioSeconds: 2
  }
  t.alike(buildParakeetEngineConfig(config), { engine: 'parakeet', parakeetConfig: config })
  t.alike(buildParakeetReloadConfig(config), { parakeetConfig: config })

  const runConfig = {
    emitEnergyVad: true,
    energyVadThresholdDb: -40,
    energyVadWindowMs: 50,
    energyVadHangoverMs: 300
  }
  t.alike(parakeetStreamingRunConfigSchema.parse(runConfig), runConfig)
  for (const invalid of [
    { energyVadWindowMs: 0 },
    { energyVadWindowMs: 12.5 },
    { energyVadHangoverMs: -1 }
  ]) {
    t.absent(parakeetStreamingRunConfigSchema.safeParse(invalid).success, JSON.stringify(invalid))
  }
})

test('Nemotron diarization streaming forwards controls and dominant speaker ids', (t) => {
  const config = {
    diarizationThreshold: 0.5,
    diarizationMinSegmentMs: 200,
    streamingSpeakerVad: true,
    streamingChunkLeftContextMs: 80
  }
  t.alike(buildParakeetEngineConfig(config), { engine: 'parakeet', parakeetConfig: config })
  const runConfig = {
    emitSpeakerVad: true,
    diarizationThreshold: 0.5,
    diarizationMinSegmentMs: 200,
    chunkLeftContextMs: 80
  }
  t.alike(parakeetStreamingRunConfigSchema.parse(runConfig), runConfig)
  for (const speakerId of [0, 7]) {
    const vad = toVadStateEvent({
      type: 'vad',
      source: 'sortformer',
      speaking: true,
      score: 0.9,
      speakerId
    })
    t.is(
      transcribeStreamResponseSchema.parse({ type: 'transcribeStream', vad }).vad?.speakerId,
      speakerId
    )
    const segment = toTranscribeSegment({
      text: 'Speaker activity',
      speakerId,
      start: 1.25,
      end: 2.5
    })
    t.is(
      transcribeStreamResponseSchema.parse({ type: 'transcribeStream', segment }).segment
        ?.speakerId,
      speakerId
    )
  }
})
