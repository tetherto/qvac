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
  sampleRate?: number
  chunkIndex?: number
  sentenceChunk?: string
  isLast?: boolean
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
    ...(chunk.isLast !== undefined ? { isLast: chunk.isLast } : {})
  }
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
 * The addon stats that keep their name on the wire. `audioDurationMs` is the
 * one rename (`audioDuration`, the name the SDK has always exposed) and is
 * handled on its own below. Every entry is a key of both the addon's stats and
 * `ttsStatsSchema`, so a field added to one side without the other fails to
 * compile here rather than being dropped silently.
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
