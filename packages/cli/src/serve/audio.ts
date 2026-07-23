// Voice routing on /v1/audio/speech (no enforced catalog — clients can use
// any string; the route resolves it via, in order):
//   1) serve.openai.audio.speech.voices[voice] -> serve.models alias
//   2) serve.models["${model}-${voice}"]
//   3) serve.models[model]

import { ENCODED_SPEECH_FORMATS, type EncodedSpeechFormat } from './lib/audio-transcode.js'

const NATIVE_FORMATS = new Set(['wav', 'pcm'])

// Content-Type per ffmpeg-encoded format. opus rides in an Ogg container, so it
// is `audio/ogg` rather than `audio/opus`.
const ENCODED_CONTENT_TYPE: Record<EncodedSpeechFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac'
}

const ALL_FORMATS_HINT = `Use "wav", "pcm", ${ENCODED_SPEECH_FORMATS.map((f) => `"${f}"`).join(', ')}.`

export type SpeechResponseFormat = 'wav' | 'pcm'

export interface SpeechFormatNative {
  kind: 'native'
  format: SpeechResponseFormat
  contentType: string
}

export interface SpeechFormatTranscoded {
  kind: 'transcoded'
  format: EncodedSpeechFormat
  contentType: string
}

export interface SpeechFormatInvalid {
  kind: 'invalid'
  format: string
  message: string
}

export type MappedSpeechFormat = SpeechFormatNative | SpeechFormatTranscoded | SpeechFormatInvalid

// Default stays wav: it needs no transcoder, so it works on every host
// regardless of whether ffmpeg is installed. OpenAI's documented default is
// mp3, but switching to it would 503 wherever ffmpeg is absent.
export const DEFAULT_SPEECH_FORMAT: SpeechResponseFormat = 'wav'

export function mapResponseFormat(input: unknown): MappedSpeechFormat {
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

  if ((ENCODED_SPEECH_FORMATS as readonly string[]).includes(normalized)) {
    const format = normalized as EncodedSpeechFormat
    return { kind: 'transcoded', format, contentType: ENCODED_CONTENT_TYPE[format] }
  }

  return {
    kind: 'invalid',
    format: normalized,
    message: `Unknown response_format "${normalized}". ${ALL_FORMATS_HINT}`
  }
}

function formatNative(format: SpeechResponseFormat): SpeechFormatNative {
  // PCM uses a placeholder here; the route rebuilds it via pcmContentType()
  // once it knows the model's sample rate (RFC 2586 audio/L16 needs `rate`).
  return {
    kind: 'native',
    format,
    contentType: format === 'wav' ? 'audio/wav' : 'audio/L16'
  }
}

// RFC 2586 audio/L16: linear PCM, 16-bit, signed, big-endian by default —
// we emit little-endian, so consumers must read the `rate`/`channels` params.
// We document the sample rate inline so HTTP clients can pick it up without
// reaching for the `X-Audio-Sample-Rate` header.
export function pcmContentType(sampleRate: number): string {
  return `audio/L16; rate=${sampleRate}; channels=1`
}

// Engine → native sample rate. Mirrors the constants used in the SDK
// examples (packages/sdk/examples/tts/{chatterbox,supertonic}.ts).
// TODO(QVAC-18522): add the GGML engine key here when the TTS-GGML migration
// lands, otherwise the engine falls through to DEFAULT_SAMPLE_RATE and audio
// plays back at the wrong speed.
const ENGINE_SAMPLE_RATE: Record<string, number> = {
  chatterbox: 24000,
  supertonic: 44100
}

// 24 kHz matches OpenAI's documented pcm output (mono, 16-bit signed LE)
// and is the right default when the engine is unknown.
export const DEFAULT_SAMPLE_RATE = 24000

export function resolveSampleRate(config: Record<string, unknown> | undefined): number {
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
export function int16SamplesToBuffer(samples: number[]): Buffer {
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
export function buildWavHeader(dataLength: number, sampleRate: number): Buffer {
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

export function buildWavBuffer(samples: number[], sampleRate: number): Buffer {
  const data = int16SamplesToBuffer(samples)
  const header = buildWavHeader(data.length, sampleRate)
  return Buffer.concat([header, data])
}

// Voice + model → alias lookup key. The route tries this first and falls
// back to the bare model name when no <model>-<voice> alias exists, so
// existing single-alias TTS configs continue to work even when callers omit
// or randomly pick a voice.
export function speechAliasKey(model: string, voice: string): string {
  return `${model}-${voice}`
}
