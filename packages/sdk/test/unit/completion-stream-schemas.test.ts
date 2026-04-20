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

test("completionStreamResponseSchema: round-trips backendDevice through stats", (t) => {
  const result = completionStreamResponseSchema.safeParse({
    type: "completionStream",
    token: "",
    done: true,
    stats: {
      timeToFirstToken: 80,
      tokensPerSecond: 75,
      cacheTokens: 12,
      backendDevice: "cpu",
    },
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.stats?.backendDevice, "cpu");
  }
});
