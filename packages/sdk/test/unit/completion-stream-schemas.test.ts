import test from "brittle";
import {
  completionStreamResponseSchema,
  completionStatsSchema,
  generationParamsSchema,
  toolDialectSchema,
} from "@/schemas/completion-stream";
import { REASONING_BUDGET_MAX } from "@/schemas/llamacpp-config";

test("completionStatsSchema: accepts backendDevice 'cpu' and 'gpu'", (t) => {
  t.is(
    completionStatsSchema.safeParse({ backendDevice: "cpu" }).success,
    true,
  );
  t.is(
    completionStatsSchema.safeParse({ backendDevice: "gpu" }).success,
    true,
  );
});

test("completionStatsSchema: rejects unknown backendDevice values", (t) => {
  const result = completionStatsSchema.safeParse({ backendDevice: "npu" });
  t.is(result.success, false);
});

test("completionStatsSchema: backendDevice is optional", (t) => {
  const result = completionStatsSchema.safeParse({
    timeToFirstToken: 100,
    tokensPerSecond: 50,
  });
  t.is(result.success, true);
});

test("generationParamsSchema: accepts reasoning_budget -1 and 0", (t) => {
  t.is(generationParamsSchema.safeParse({ reasoning_budget: -1 }).success, true);
  t.is(generationParamsSchema.safeParse({ reasoning_budget: 0 }).success, true);
});

test("generationParamsSchema: accepts positive reasoning_budget (token cap)", (t) => {
  t.is(generationParamsSchema.safeParse({ reasoning_budget: 1 }).success, true);
  t.is(generationParamsSchema.safeParse({ reasoning_budget: 128 }).success, true);
});

test("generationParamsSchema: rejects reasoning_budget other values", (t) => {
  t.is(generationParamsSchema.safeParse({ reasoning_budget: -2 }).success, false);
  t.is(generationParamsSchema.safeParse({ reasoning_budget: 0.5 }).success, false);
  t.is(
    generationParamsSchema.safeParse({
      reasoning_budget: REASONING_BUDGET_MAX + 1,
    }).success,
    false,
  );
});

test("generationParamsSchema: accepts remove_thinking_from_context boolean", (t) => {
  t.is(
    generationParamsSchema.safeParse({ remove_thinking_from_context: true })
      .success,
    true,
  );
  t.is(
    generationParamsSchema.safeParse({ remove_thinking_from_context: false })
      .success,
    true,
  );
});

test("generationParamsSchema: rejects non-boolean remove_thinking_from_context", (t) => {
  t.is(
    generationParamsSchema.safeParse({ remove_thinking_from_context: 1 })
      .success,
    false,
  );
});

test("toolDialectSchema: accepts qwen35 and gemma4", (t) => {
  t.is(toolDialectSchema.safeParse("qwen35").success, true);
  t.is(toolDialectSchema.safeParse("gemma4").success, true);
});

test("toolDialectSchema: rejects unknown dialects", (t) => {
  t.is(toolDialectSchema.safeParse("unknown").success, false);
});

test("completionStreamResponseSchema: round-trips backendDevice through completionStats event", (t) => {
  const result = completionStreamResponseSchema.safeParse({
    type: "completionStream",
    done: true,
    events: [
      {
        type: "completionStats",
        seq: 0,
        stats: {
          timeToFirstToken: 80,
          tokensPerSecond: 75,
          cacheTokens: 12,
          backendDevice: "cpu",
        },
      },
      { type: "completionDone", seq: 1 },
    ],
  });
  t.is(result.success, true);
  if (result.success) {
    const statsEvent = result.data.events.find((e) => e.type === "completionStats");
    t.ok(statsEvent);
    if (statsEvent && "stats" in statsEvent) {
      t.is(statsEvent.stats.backendDevice, "cpu");
    }
  }
});
