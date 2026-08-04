import test from 'brittle'
import {
  buildParakeetEngineConfig,
  buildParakeetReloadConfig,
  buildWhisperEngineConfig,
  buildWhisperReloadConfig
} from '@/server/bare/plugins/asr-ggml/config'
import { createAsrModelLogger } from '@/server/bare/plugins/asr-ggml/logging'
import {
  isEndOfTurnEvent,
  isVadEvent,
  toEndOfTurnEvent,
  toVadStateEvent
} from '@/server/bare/utils/asr-events'
import { ADDON_ASR, ADDON_PARAKEET, ADDON_WHISPER } from '@/schemas/plugin'
import { LEGACY_ENGINE_TO_CANONICAL } from '@/schemas/engine-addon-map'
import { ModelType } from '@/schemas/model-types'
import { clearAllAddonLoggers, createAddonLoggerCallback, unregisterAddonLogger } from '@/logging'
import {
  clearAllLoggingStreams,
  registerLoggingStream
} from '@/server/bare/registry/logging-stream-registry'

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
  t.alike(buildParakeetReloadConfig({ streamingChunkMs: 480 }), {
    parakeetConfig: {
      streamingChunkMs: 480
    }
  })
})

test('Whisper prompt reload strips SDK-only keys for asr-ggml', (t) => {
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

test('ASR event adapters preserve the public SDK event contract', (t) => {
  t.ok(
    isVadEvent({
      type: 'vad',
      speaking: true,
      score: 0.87,
      source: 'silero'
    })
  )
  t.ok(
    isEndOfTurnEvent({
      type: 'endOfTurn',
      source: 'model-eou'
    })
  )
  t.not(isVadEvent({ text: 'vad-like segment', type: 'vad' }))
  t.alike(
    toVadStateEvent({
      type: 'vad',
      speaking: true,
      score: 0.87,
      source: 'silero'
    }),
    {
      speaking: true,
      probability: 0.87
    }
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
