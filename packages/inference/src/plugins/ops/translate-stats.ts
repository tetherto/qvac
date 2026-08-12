import type { TranslationStats } from '@/schemas/index'
import type { NmtStats } from '@/utils/addon-responses'

export const NMT_SECONDS_TO_MS = 1000

export function buildNmtTranslationStats(stats: NmtStats | undefined): TranslationStats {
  return {
    ...(stats?.totalTime !== undefined && { totalTime: stats.totalTime * NMT_SECONDS_TO_MS }),
    ...(stats?.totalTokens !== undefined && { totalTokens: stats.totalTokens }),
    ...(stats?.decodeTime !== undefined && { decodeTime: stats.decodeTime * NMT_SECONDS_TO_MS }),
    ...(stats?.encodeTime !== undefined && { encodeTime: stats.encodeTime * NMT_SECONDS_TO_MS }),
    ...(stats?.TPS !== undefined && { tokensPerSecond: stats.TPS }),
    ...(stats?.TTFT !== undefined && { timeToFirstToken: stats.TTFT })
  }
}
