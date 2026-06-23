import test from "brittle";
import { completionStatsSchema } from "@/schemas";
import { normalizeCompletionStats } from "@/server/bare/plugins/llamacpp-completion/ops/completion-stats";
import type { LlmStats } from "@/server/bare/types/addon-responses";

test("normalizeCompletionStats: drops non-finite addon numbers", (t) => {
  const stats: LlmStats = {
    TTFT: Number.NaN,
    TPS: Number.POSITIVE_INFINITY,
    CacheTokens: 12,
    promptTokens: Number.NEGATIVE_INFINITY,
    generatedTokens: 40,
    backendDevice: "gpu",
  };

  const normalized = normalizeCompletionStats(stats);

  t.alike(normalized, {
    cacheTokens: 12,
    generatedTokens: 40,
    backendDevice: "gpu",
  });
  t.is(completionStatsSchema.safeParse(normalized).success, true);
});

test("normalizeCompletionStats: returns undefined when no finite stats remain", (t) => {
  const normalized = normalizeCompletionStats({
    TTFT: Number.NaN,
    TPS: Number.POSITIVE_INFINITY,
  });

  t.is(normalized, undefined);
});
