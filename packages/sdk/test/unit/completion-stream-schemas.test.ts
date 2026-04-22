// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  completionStreamResponseSchema,
  completionStatsSchema,
} from "@/schemas/completion-stream";

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
