import type { CompletionStats } from "@/schemas";
import type { LlmStats } from "@/server/bare/types/addon-responses";

function finiteNumber(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

export function normalizeCompletionStats(stats: LlmStats | undefined) {
  if (!stats) return undefined;

  const timeToFirstToken = finiteNumber(stats.TTFT);
  const tokensPerSecond = finiteNumber(stats.TPS);
  const cacheTokens = finiteNumber(stats.CacheTokens);
  const promptTokens = finiteNumber(stats.promptTokens);
  const generatedTokens = finiteNumber(stats.generatedTokens);

  const normalized: CompletionStats = {
    ...(timeToFirstToken !== undefined && { timeToFirstToken }),
    ...(tokensPerSecond !== undefined && { tokensPerSecond }),
    ...(cacheTokens !== undefined && { cacheTokens }),
    ...(promptTokens !== undefined && { promptTokens }),
    ...(generatedTokens !== undefined && { generatedTokens }),
    ...(stats.backendDevice !== undefined && { backendDevice: stats.backendDevice }),
  };

  if (
    timeToFirstToken === undefined &&
    tokensPerSecond === undefined &&
    cacheTokens === undefined &&
    promptTokens === undefined &&
    generatedTokens === undefined &&
    stats.backendDevice === undefined
  ) {
    return undefined;
  }

  return normalized;
}
