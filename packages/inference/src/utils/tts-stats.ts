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

// Field-for-field, apart from `audioDurationMs` -> `audioDuration`, which keeps
// the name the SDK has always exposed.
export function collectTtsStats(response: { stats?: AddonTtsStats }): TtsStats {
  const stats = response.stats
  if (!stats) return {}

  return {
    ...(stats.audioDurationMs !== undefined && { audioDuration: stats.audioDurationMs }),
    ...(stats.totalTime !== undefined && { totalTime: stats.totalTime }),
    ...(stats.realTimeFactor !== undefined && { realTimeFactor: stats.realTimeFactor }),
    ...(stats.tokensPerSecond !== undefined && { tokensPerSecond: stats.tokensPerSecond }),
    ...(stats.totalSamples !== undefined && { totalSamples: stats.totalSamples }),
    ...(stats.generatedFrames !== undefined && { generatedFrames: stats.generatedFrames }),
    ...(stats.backendDevice !== undefined && { backendDevice: stats.backendDevice }),
    ...(stats.backendId !== undefined && { backendId: stats.backendId }),
    ...(stats.gpuUnsupported !== undefined && { gpuUnsupported: stats.gpuUnsupported }),
    ...(stats.enhancerBackendDevice !== undefined && {
      enhancerBackendDevice: stats.enhancerBackendDevice
    }),
    ...(stats.enhancerBackendId !== undefined && { enhancerBackendId: stats.enhancerBackendId }),
    ...(stats.codecSidecarLoaded !== undefined && {
      codecSidecarLoaded: stats.codecSidecarLoaded
    }),
    ...(stats.codecOnCoreml !== undefined && { codecOnCoreml: stats.codecOnCoreml })
  }
}
