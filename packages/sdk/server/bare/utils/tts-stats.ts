import type { TtsStats } from '@/schemas'

/**
 * Shared types and utilities for TTS operations.
 * Used by both text-to-speech.ts and text-to-speech-stream.ts.
 */

export type TtsStreamChunk = {
  outputArray: ArrayLike<number>
  chunkIndex?: number
  sentenceChunk?: string
}

export type TtsOpYield = {
  buffer: number[]
  chunkIndex?: number
  sentenceChunk?: string
}

type AddonTtsStats = {
  audioDurationMs?: number
  totalSamples?: number
  enhancerBackendDevice?: number
  enhancerBackendId?: number
}

export function collectTtsStats(response: { stats?: AddonTtsStats }): TtsStats {
  return {
    ...(response.stats?.audioDurationMs !== undefined && {
      audioDuration: response.stats.audioDurationMs
    }),
    ...(response.stats?.totalSamples !== undefined && {
      totalSamples: response.stats.totalSamples
    }),
    ...(response.stats?.enhancerBackendDevice !== undefined && {
      enhancerBackendDevice: response.stats.enhancerBackendDevice
    }),
    ...(response.stats?.enhancerBackendId !== undefined && {
      enhancerBackendId: response.stats.enhancerBackendId
    })
  }
}
