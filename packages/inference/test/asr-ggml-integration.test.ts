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

test('buildWhisperEngineConfig sends every key under its native name', (t) => {
  const config = buildWhisperEngineConfig({
    strategy: 'beam_search',
    threads: 4,
    nMaxTextCtx: 16,
    offsetMs: 100,
    durationMs: 2000,
    audioCtx: 0,
    translate: false,
    noContext: true,
    noTimestamps: false,
    singleSegment: true,
    printSpecial: false,
    printProgress: false,
    printRealtime: false,
    printTimestamps: false,
    tokenTimestamps: true,
    tholdPt: 0.01,
    tholdPtsum: 0.02,
    maxLen: 40,
    splitOnWord: true,
    maxTokens: 32,
    debugMode: false,
    tdrzEnable: false,
    suppressRegex: '^\\[',
    initialPrompt: 'QVAC',
    carryInitialPrompt: true,
    language: 'en',
    suppressBlank: true,
    suppressNst: true,
    temperature: 0,
    lengthPenalty: 1,
    temperatureInc: 0.2,
    entropyThold: 2.4,
    logprobThold: -1,
    greedyBestOf: 5,
    beamSize: 4,
    maxInitialTs: 1,
    noSpeechThold: 0.6,
    seed: 7,
    vadParams: {
      threshold: 0.5,
      minSpeechDurationMs: 250,
      minSilenceDurationMs: 100,
      maxSpeechDurationS: 30,
      speechPadMs: 30,
      samplesOverlap: 0.1
    },
    audioFormat: 's16le',
    vadModelSrc: '/models/vad.bin',
    contextParams: { useGpu: true, flashAttention: true, gpuDevice: 1 },
    miscConfig: { captionEnabled: true, seed: 3 }
  })

  t.alike(config, {
    engine: 'whisper',
    whisperConfig: {
      strategy: 'beam_search',
      n_threads: 4,
      n_max_text_ctx: 16,
      offset_ms: 100,
      duration_ms: 2000,
      audio_ctx: 0,
      translate: false,
      no_context: true,
      no_timestamps: false,
      single_segment: true,
      print_special: false,
      print_progress: false,
      print_realtime: false,
      print_timestamps: false,
      token_timestamps: true,
      thold_pt: 0.01,
      thold_ptsum: 0.02,
      max_len: 40,
      split_on_word: true,
      max_tokens: 32,
      debug_mode: false,
      tdrz_enable: false,
      suppress_regex: '^\\[',
      initial_prompt: 'QVAC',
      carry_initial_prompt: true,
      language: 'en',
      suppress_blank: true,
      suppress_nst: true,
      temperature: 0,
      length_penalty: 1,
      temperature_inc: 0.2,
      entropy_thold: 2.4,
      logprob_thold: -1,
      greedy_best_of: 5,
      beam_search_beam_size: 4,
      max_initial_ts: 1,
      no_speech_thold: 0.6,
      seed: 7,
      vad_params: {
        threshold: 0.5,
        min_speech_duration_ms: 250,
        min_silence_duration_ms: 100,
        max_speech_duration_s: 30,
        speech_pad_ms: 30,
        samples_overlap: 0.1
      },
      audio_format: 's16le'
    },
    contextParams: { use_gpu: true, flash_attn: true, gpu_device: 1 },
    miscConfig: { caption_enabled: true, seed: 3 }
  })
})

test('buildWhisperEngineConfig drops undefined addon fields', (t) => {
  t.alike(
    buildWhisperEngineConfig({
      language: 'en',
      contextParams: { useGpu: true, gpuDevice: undefined }
    }),
    { engine: 'whisper', whisperConfig: { language: 'en' }, contextParams: { use_gpu: true } }
  )
})

test('Whisper config maps detectLanguage to the unified auto language mode', (t) => {
  t.alike(buildWhisperEngineConfig({ language: 'fr', detectLanguage: true }), {
    engine: 'whisper',
    whisperConfig: {
      language: 'auto'
    }
  })
  t.alike(buildWhisperReloadConfig({ language: 'fr', detectLanguage: false }), {
    whisperConfig: {
      language: 'fr'
    }
  })
})

test('Whisper config forwards carryInitialPrompt and the mainGpu selector', (t) => {
  t.alike(
    buildWhisperEngineConfig({
      initialPrompt: 'QVAC',
      carryInitialPrompt: true,
      contextParams: { useGpu: true, mainGpu: 'dedicated' }
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
    buildWhisperReloadConfig({ carryInitialPrompt: false }),
    { whisperConfig: { carry_initial_prompt: false } },
    'carryInitialPrompt is a reloadable whisperConfig key'
  )
})

test('whisperConfigSchema accepts mainGpu and rejects conflicting selectors', (t) => {
  t.ok(whisperConfigSchema.safeParse({ carryInitialPrompt: true }).success)
  t.ok(whisperConfigSchema.safeParse({ contextParams: { mainGpu: 0 } }).success)
  t.ok(whisperConfigSchema.safeParse({ contextParams: { mainGpu: '1' } }).success)
  t.ok(whisperConfigSchema.safeParse({ contextParams: { mainGpu: 'integrated' } }).success)
  t.ok(whisperConfigSchema.safeParse({ contextParams: { gpuDevice: 1 } }).success)
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
      whisperConfigSchema.safeParse({ contextParams: { mainGpu: selector } }).success,
      `mainGpu rejects ${JSON.stringify(selector)} before model load`
    )
  }
  t.ok(whisperConfigSchema.safeParse({ contextParams: { mainGpu: 2147483647 } }).success)
  const withGpuDevice = whisperConfigSchema.safeParse({
    contextParams: { mainGpu: 'dedicated', gpuDevice: 0 }
  })
  t.absent(withGpuDevice.success, 'mainGpu combined with gpuDevice is rejected')
  if (!withGpuDevice.success) {
    t.ok(
      withGpuDevice.error.issues.some((issue) => issue.message.includes('gpuDevice')),
      'the error names gpuDevice'
    )
  }
  t.absent(
    whisperConfigSchema.partial().strict().safeParse({ mainGpu: 0 }).success,
    'mainGpu belongs under contextParams, not at the top level'
  )
})

test('buildParakeetEngineConfig removes undefined addon fields', (t) => {
  const config = buildParakeetEngineConfig({
    useGpu: true,
    threads: undefined
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
    useGpu: true
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
      contextParams: { useGpu: true },
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
    detectLanguage: true,
    vadModelSrc: '/models/vad.bin',
    initialPrompt: 'old prompt',
    miscConfig: {
      captionEnabled: true
    }
  }

  t.alike(buildWhisperReloadConfig({ ...originalConfig, initialPrompt: 'new prompt' }), {
    whisperConfig: {
      language: 'auto',
      initial_prompt: 'new prompt'
    },
    miscConfig: {
      caption_enabled: true
    }
  })
  t.alike(buildWhisperReloadConfig({ ...originalConfig, initialPrompt: '' }), {
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
  // Parakeet stamps its events with the session time and the native chunk
  // index; both reach the wire so a caller can line events up with segments.
  const nativeVad = {
    type: 'vad',
    speaking: false,
    score: 0.1,
    source: 'energy',
    timestamp: 2.5,
    chunkIndex: 3
  } as const
  const stamped = toVadStateEvent(nativeVad)
  t.alike(stamped, {
    speaking: false,
    probability: 0.1,
    source: 'energy',
    timestamp: 2.5,
    chunkIndex: 3
  })
  const wireVad = transcribeStreamResponseSchema.parse({
    type: 'transcribeStream',
    vad: stamped
  }).vad
  t.is(wireVad?.timestamp, 2.5)
  t.is(wireVad?.chunkIndex, 3)
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
