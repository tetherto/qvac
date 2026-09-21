import type { ServeConfig } from '@/serve/core/config/types'

export interface OpenAIServeOptions {
  audio: {
    speech: {
      defaultVoice: string | null
      /**
       * Maps an OpenAI `voice` string to a `serve.models` alias. Each alias can
       * carry its own TTS `config` (e.g. Chatterbox `referenceAudioSrc`, Supertonic
       * `ttsVoiceStyleSrc`). When set, this is tried before `${model}-${voice}` and
       * before the bare `model` alias. Keys are normalized to lowercase when parsed.
       */
      voices: Record<string, string> | null
      /**
       * Maximum allowed character length of `input`. Requests above this are
       * rejected with `400 input_too_long` before any synthesis runs (the
       * route otherwise buffers the full WAV in memory — DoS vector).
       * `null` disables the cap. Defaults to OpenAI's documented 4096.
       */
      maxInputChars: number | null
    }
  }
}

declare module '@/serve/core/config/types' {
  interface ServeExtensionConfig {
    openai: OpenAIServeOptions
  }
}

interface RawOpenAIOptions {
  audio?: {
    speech?: {
      defaultVoice?: unknown
      voices?: unknown
      maxInputChars?: unknown
    }
  }
}

const DEFAULT_SPEECH_VOICE = 'alloy'
// OpenAI's documented limit for /v1/audio/speech `input`. Keeps memory
// pressure bounded since we buffer the full WAV before responding.
const DEFAULT_MAX_INPUT_CHARS = 4096

export function openaiOptions(serveConfig: ServeConfig): OpenAIServeOptions {
  const options = serveConfig.extensions.openai
  if (options === undefined) {
    throw new Error('serve.openai config was not parsed; the openai extension is not registered.')
  }
  return options
}

export function parseOpenAIOptions(input: unknown): OpenAIServeOptions {
  const raw = input as RawOpenAIOptions | undefined
  const rawDefaultVoice = raw?.audio?.speech?.defaultVoice
  let defaultVoice: string | null = DEFAULT_SPEECH_VOICE

  if (rawDefaultVoice === null) {
    // Explicit null disables the fallback so callers must always send `voice`.
    defaultVoice = null
  } else if (typeof rawDefaultVoice === 'string') {
    const trimmed = rawDefaultVoice.trim()
    defaultVoice = trimmed.length > 0 ? trimmed : null
  } else if (rawDefaultVoice !== undefined) {
    throw new Error('serve.openai.audio.speech.defaultVoice must be a string or null')
  }

  const rawVoices = raw?.audio?.speech?.voices
  let voices: Record<string, string> | null = null
  if (rawVoices !== undefined && rawVoices !== null) {
    if (typeof rawVoices !== 'object' || Array.isArray(rawVoices)) {
      throw new Error(
        'serve.openai.audio.speech.voices must be a JSON object (voice -> model alias)'
      )
    }
    const out: Record<string, string> = {}
    for (const [key, val] of Object.entries(rawVoices as Record<string, unknown>)) {
      if (typeof val !== 'string' || !val.trim()) {
        throw new Error(
          `serve.openai.audio.speech.voices["${key}"] must be a non-empty string (model alias)`
        )
      }
      const k = key.trim().toLowerCase()
      if (!k) continue
      out[k] = val.trim()
    }
    voices = Object.keys(out).length > 0 ? out : null
  }

  const rawMaxInput = raw?.audio?.speech?.maxInputChars
  let maxInputChars: number | null = DEFAULT_MAX_INPUT_CHARS
  if (rawMaxInput === null) {
    maxInputChars = null
  } else if (rawMaxInput !== undefined) {
    if (typeof rawMaxInput !== 'number' || !Number.isInteger(rawMaxInput) || rawMaxInput < 1) {
      throw new Error('serve.openai.audio.speech.maxInputChars must be a positive integer or null')
    }
    maxInputChars = rawMaxInput
  }

  return { audio: { speech: { defaultVoice, voices, maxInputChars } } }
}
