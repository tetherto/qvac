// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  embedRequestSchema,
  embedResponseSchema,
  embedStatsSchema,
} from "@/schemas/embed";

test("embedStatsSchema: accepts backendDevice 'cpu' and 'gpu'", (t) => {
  t.is(embedStatsSchema.safeParse({ backendDevice: "cpu" }).success, true);
  t.is(embedStatsSchema.safeParse({ backendDevice: "gpu" }).success, true);
});

test("embedStatsSchema: rejects unknown backendDevice values", (t) => {
  const result = embedStatsSchema.safeParse({ backendDevice: "tpu" });
  t.is(result.success, false);
});

test("embedStatsSchema: backendDevice is optional", (t) => {
  const result = embedStatsSchema.safeParse({
    totalTime: 12,
    tokensPerSecond: 100,
    totalTokens: 1200,
  });
  t.is(result.success, true);
});

test("embedResponseSchema: round-trips backendDevice through stats", (t) => {
  const result = embedResponseSchema.safeParse({
    type: "embed",
    success: true,
    embedding: [0.1, 0.2, 0.3],
    stats: {
      totalTime: 5,
      tokensPerSecond: 200,
      totalTokens: 1000,
      backendDevice: "gpu",
    },
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.stats?.backendDevice, "gpu");
  }
});

test("embedRequestSchema: accepts an optional requestId", (t) => {
  const result = embedRequestSchema.safeParse({
    type: "embed",
    modelId: "m1",
    text: "hello",
    requestId: "req-1",
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.requestId, "req-1");
  }
});

test("embedRequestSchema: requestId is optional (server falls back to a generated id for older clients)", (t) => {
  const result = embedRequestSchema.safeParse({
    type: "embed",
    modelId: "m1",
    text: "hello",
  });
  t.is(result.success, true);
});

test("embedRequestSchema: rejects empty-string requestId", (t) => {
  const result = embedRequestSchema.safeParse({
    type: "embed",
    modelId: "m1",
    text: "hello",
    requestId: "",
  });
  t.is(result.success, false);
});
