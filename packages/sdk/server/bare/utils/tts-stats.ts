import type { TtsStats } from "@/schemas";

/**
 * Shared types and utilities for TTS operations.
 * Used by both text-to-speech.ts and text-to-speech-stream.ts.
 */

export type TtsStreamChunk = {
  outputArray: ArrayLike<number>;
  chunkIndex?: number;
  sentenceChunk?: string;
};

export type TtsOpYield = {
  buffer: number[];
  chunkIndex?: number;
  sentenceChunk?: string;
};

export function collectTtsStats(response: {
  stats?: { audioDurationMs?: number; totalSamples?: number };
}): TtsStats {
  return {
    ...(response.stats?.audioDurationMs !== undefined && {
      audioDuration: response.stats.audioDurationMs,
    }),
    ...(response.stats?.totalSamples !== undefined && {
      totalSamples: response.stats.totalSamples,
    }),
  };
}
