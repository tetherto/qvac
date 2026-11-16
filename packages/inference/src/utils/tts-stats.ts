import { encodeTtsPcm } from '@/schemas/tts-pcm'
import type { TtsStats } from '@/schemas/index'
import type { TtsStats as AddonTtsStats, TtsOutputChunk } from '@/utils/addon-responses'

/**
 * Shared types and utilities for TTS operations.
 * Used by both text-to-speech.ts and text-to-speech-stream.ts.
 */

export type TtsStreamChunk = TtsOutputChunk

export type TtsOpYield = {
  text?: string
  buffer: number[]
  /** Base64 int16 LE PCM; set instead of `buffer` by the ops (see `encodeTtsPcm`). */
  pcm?: string
  sampleRate?: number
  chunkIndex?: number
  sentenceChunk?: string
  isLast?: boolean
  /** CosyVoice3: the speech tokens of the synthesis this frame belongs to. */
  speechTokenIds?: number[]
}

/**
 * Everything an addon chunk carries beyond its PCM. Shared by both TTS ops so
 * the plain `stream: true` path and the sentence-stream path emit the same
 * shape — they run the same addon chunker, and previously only the latter
 * forwarded the metadata.
 */
export function chunkMetadata(chunk: TtsStreamChunk) {
  return {
    ...(chunk.sampleRate !== undefined ? { sampleRate: chunk.sampleRate } : {}),
    ...(chunk.chunkIndex !== undefined ? { chunkIndex: chunk.chunkIndex } : {}),
    ...(typeof chunk.sentenceChunk === 'string' && chunk.sentenceChunk.length > 0
      ? { sentenceChunk: chunk.sentenceChunk }
      : {}),
    ...(chunk.isLast !== undefined ? { isLast: chunk.isLast } : {}),
    ...(chunk.speechTokenIds !== undefined ? { speechTokenIds: chunk.speechTokenIds } : {})
  }
}

/**
 * Whether a chunk has anything to forward besides PCM. CosyVoice3's native
 * chunk streaming ends with an empty-PCM `isLast` chunk that carries the
 * run's `speechTokenIds`; Audio8's native end markers are empty too but carry
 * nothing, so the ops skip those and forward these.
 */
export function carriesSpeechTokenIds(chunk: TtsStreamChunk): boolean {
  return chunk.speechTokenIds !== undefined
}

/**
 * Appends a chunk's samples to `target` in place, which keeps collecting an
 * utterance linear in its length — a natively chunked MOSS run emits dozens of
 * chunks into one buffer.
 */
export function appendPcm(target: number[], samples: ArrayLike<number>) {
  for (let i = 0; i < samples.length; i++) target.push(samples[i]!)
}

/**
 * One contiguous buffer from the engine's per-chunk output arrays: an
 * `Int16Array` when every part is one (the engines' PCM), else a plain array.
 */
export function concatPcm(parts: readonly ArrayLike<number>[]): Int16Array | number[] {
  if (parts.length === 1 && parts[0] instanceof Int16Array) return parts[0]
  if (!parts.every((p) => p instanceof Int16Array)) {
    const out: number[] = []
    for (const p of parts) appendPcm(out, p)
    return out
  }
  let total = 0
  for (const p of parts) total += p.length
  const out = new Int16Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * The audio fields of a frame: int16 engine output rides the wire as base64
 * `pcm`; anything else (test doubles, non-int16 engines) stays a `buffer`.
 */
export function pcmFrame(samples: ArrayLike<number>): { buffer: number[]; pcm?: string } {
  if (samples instanceof Int16Array) return { buffer: [], pcm: encodeTtsPcm(samples) }
  return { buffer: Array.from(samples) }
}

/**
 * The addon stats that keep their name on the wire. `audioDurationMs` is the
 * one rename (`audioDuration`, the name the SDK has always exposed) and is
 * handled on its own below.
 *
 * Two compile-time checks keep this table honest. `satisfies` requires every
 * entry to be a key of both the addon's stats and `ttsStatsSchema`, and
 * `UnforwardedTtsStats` below requires every key of either type to be an
 * entry. A stat added to one side only, or to both without a line here, fails
 * to compile rather than being dropped silently.
 */
const TTS_FORWARDED_STATS = [
  'totalTime',
  'realTimeFactor',
  'tokensPerSecond',
  'totalSamples',
  'generatedFrames',
  'firstAudioMs',
  'backendDevice',
  'backendId',
  'gpuUnsupported',
  'enhancerBackendDevice',
  'enhancerBackendId',
  'denoiserBackendDevice',
  'denoiserBackendId',
  'codecSidecarLoaded',
  'codecOnCoreml',
  // Parler Core ML sidecars
  'decoderSidecarLoaded',
  'dacSidecarLoaded',
  'decoderOnCoreml',
  'dacOnCoreml',
  // Chatterbox
  't3Ms',
  's3genMs',
  't3Tokens',
  // CosyVoice3 / Audio8
  'stageTotalMs',
  // CosyVoice3
  'lmPrefillMs',
  'lmDecodeMs',
  'flowFrontendMs',
  'ditEulerMs',
  'hiftF0Ms',
  'hiftSourceMs',
  'hiftStftMs',
  'hiftDecodeMs',
  'decodeSteps',
  'speechTokens',
  'flowFrames',
  'melFrames',
  'textIds',
  'promptSpeechTokens',
  // Audio8
  'voiceEncodeMs',
  'promptMs',
  'prefillMs',
  'sampleMs',
  'fastDecodeMs',
  'slowDecodeMs',
  'codecLatentMs',
  'codecSynthMs',
  'resampleMs'
] as const satisfies readonly (keyof AddonTtsStats & keyof TtsStats)[]

type ForwardedTtsStat = (typeof TTS_FORWARDED_STATS)[number]

// The stats either side declares that the table does not cover, apart from the
// renamed pair. Anything left here is a field `collectTtsStats` would drop.
type UnforwardedTtsStats =
  | Exclude<keyof AddonTtsStats, ForwardedTtsStat | 'audioDurationMs'>
  | Exclude<keyof TtsStats, ForwardedTtsStat | 'audioDuration'>

// Fails with the missing field's name: "Type '"newStat"' does not satisfy the
// constraint 'never'".
type AssertNoUnforwardedTtsStats<T extends never> = T
export type TtsStatsTableIsExhaustive = AssertNoUnforwardedTtsStats<UnforwardedTtsStats>

// Presence, not truthiness: `backendDevice: 0` (CPU) and a zero stage time are
// real reports, so only `undefined` is dropped.
export function collectTtsStats(response: { stats?: AddonTtsStats }): TtsStats {
  const stats = response.stats
  if (!stats) return {}

  const out: TtsStats = {}
  if (stats.audioDurationMs !== undefined) out.audioDuration = stats.audioDurationMs
  for (const key of TTS_FORWARDED_STATS) {
    const value = stats[key]
    if (value !== undefined) out[key] = value
  }
  return out
}
