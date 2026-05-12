// OpenAI's documented voice catalog. These are accepted as input on
// /v1/audio/speech for client compatibility, but voice routing in QVAC is
// resolved through the model alias suffix (see resolveSpeechAlias).
export const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse'
] as const

export type OpenAIVoice = typeof OPENAI_VOICES[number]

const NATIVE_FORMATS = new Set(['wav', 'pcm'])
const TRANSCODED_FORMATS = new Set(['mp3', 'opus', 'aac', 'flac'])

export type SpeechResponseFormat = 'wav' | 'pcm'

export interface SpeechFormatNative {
  kind: 'native'
  format: SpeechResponseFormat
  contentType: string
}

export interface SpeechFormatUnsupported {
  kind: 'unsupported'
  format: string
  message: string
}

export interface SpeechFormatInvalid {
  kind: 'invalid'
  format: string
  message: string
}

export type MappedSpeechFormat =
  | SpeechFormatNative
  | SpeechFormatUnsupported
  | SpeechFormatInvalid

// Default to wav (the simplest container we can produce without a transcoder).
// OpenAI's documented default is mp3, which we cannot encode natively yet —
// see docs/openai-api-coverage.md for the gap and follow-up plan.
export const DEFAULT_SPEECH_FORMAT: SpeechResponseFormat = 'wav'

export function mapResponseFormat (input: unknown): MappedSpeechFormat {
  if (input === undefined || input === null || input === '') {
    return formatNative(DEFAULT_SPEECH_FORMAT)
  }

  if (typeof input !== 'string') {
    return {
      kind: 'invalid',
      format: String(input),
      message: 'response_format must be a string.'
    }
  }

  const normalized = input.toLowerCase()

  if (NATIVE_FORMATS.has(normalized)) {
    return formatNative(normalized as SpeechResponseFormat)
  }

  if (TRANSCODED_FORMATS.has(normalized)) {
    return {
      kind: 'unsupported',
      format: normalized,
      message: `response_format "${normalized}" requires an audio transcoder which is not bundled with this CLI yet. Use "wav" or "pcm".`
    }
  }

  return {
    kind: 'invalid',
    format: normalized,
    message: `Unknown response_format "${normalized}". Use "wav" or "pcm".`
  }
}

function formatNative (format: SpeechResponseFormat): SpeechFormatNative {
  return {
    kind: 'native',
    format,
    contentType: format === 'wav' ? 'audio/wav' : 'audio/pcm'
  }
}

// Engine → native sample rate. Mirrors the constants used in the SDK
// examples (packages/sdk/examples/tts/{chatterbox,supertonic}.ts).
const ENGINE_SAMPLE_RATE: Record<string, number> = {
  chatterbox: 24000,
  supertonic: 44100
}

// 24 kHz matches OpenAI's documented pcm output (mono, 16-bit signed LE)
// and is the right default when the engine is unknown.
export const DEFAULT_SAMPLE_RATE = 24000

export function resolveSampleRate (config: Record<string, unknown> | undefined): number {
  if (!config) return DEFAULT_SAMPLE_RATE

  const explicit = config['sampleRate']
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit)
  }

  const engine = config['ttsEngine']
  if (typeof engine === 'string') {
    const fromEngine = ENGINE_SAMPLE_RATE[engine.toLowerCase()]
    if (fromEngine) return fromEngine
  }

  return DEFAULT_SAMPLE_RATE
}

// Convert Int16 PCM samples (number[] from the SDK) into a tightly packed
// little-endian Buffer. Out-of-range values are clamped to the Int16 domain
// to match the SDK example utility (packages/sdk/examples/tts/utils.ts).
export function int16SamplesToBuffer (samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i] ?? 0
    const clamped = Math.max(-32768, Math.min(32767, Math.round(raw)))
    buffer.writeInt16LE(clamped, i * 2)
  }
  return buffer
}

// Build a 44-byte RIFF/WAVE header for 16-bit signed PCM, mono, at the given
// sample rate, followed by `dataLength` data bytes. Layout matches the
// canonical PCM WAV format used by the SDK example helpers.
export function buildWavHeader (dataLength: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataLength, 4)
  header.write('WAVE', 8)

  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)

  header.write('data', 36)
  header.writeUInt32LE(dataLength, 40)

  return header
}

export function buildWavBuffer (samples: number[], sampleRate: number): Buffer {
  const data = int16SamplesToBuffer(samples)
  const header = buildWavHeader(data.length, sampleRate)
  return Buffer.concat([header, data])
}

// Voice + model → alias lookup key. The route tries this first and falls
// back to the bare model name when no <model>-<voice> alias exists, so
// existing single-alias TTS configs continue to work even when callers omit
// or randomly pick a voice.
export function speechAliasKey (model: string, voice: string): string {
  return `${model}-${voice}`
}
