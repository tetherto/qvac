import type { TtsStats } from '@/schemas/index'
import type { TtsStats as AddonTtsStats, TtsOutputChunk } from '@/utils/addon-responses'

/**
 * Shared types and utilities for TTS operations.
 * Used by both text-to-speech.ts and text-to-speech-stream.ts.
 */

export type TtsStreamChunk = TtsOutputChunk

export type TtsOpYield = {
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
    ...(stats.enhancerBackendId !== undefined && { enhancerBackendId: stats.enhancerBackendId })
  }
}
