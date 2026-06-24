import test from "brittle";
import {
  completionEventSchema,
  completionStatsSchema,
  doneEventSchema,
  seqSchema,
} from "@/schemas/completion-event";
import { completionStreamResponseSchema } from "@/schemas/completion-stream";

test("seqSchema: accepts valid, rejects invalid", (t) => {
  t.is(seqSchema.safeParse(0).success, true);
  t.is(seqSchema.safeParse(42).success, true);
  t.is(seqSchema.safeParse(-1).success, false);
  t.is(seqSchema.safeParse(1.5).success, false);
  t.is(seqSchema.safeParse(NaN).success, false);
});

test("completionDone: enforces error/stopReason invariant", (t) => {
  const ok = (v: unknown) => t.is(doneEventSchema.safeParse(v).success, true);
  const bad = (v: unknown) => t.is(doneEventSchema.safeParse(v).success, false);

  ok({ type: "completionDone", seq: 0 });
  ok({ type: "completionDone", seq: 0, stopReason: "eos" });
  ok({ type: "completionDone", seq: 0, stopReason: "error", error: { message: "crash" } });

  bad({ type: "completionDone", seq: 0, stopReason: "error" });
  bad({ type: "completionDone", seq: 0, stopReason: "eos", error: { message: "x" } });
  bad({ type: "completionDone", seq: 0, error: { message: "orphan" } });
});

test("completionDone: accepts the 'cancelled' stopReason on the success path", (t) => {
  // A cancelled completion is a *clean* termination, not an error. The
  // event must validate against the `successDoneSchema` discriminant —
  // same shape as `"eos"` — so stream-first consumers see the cancel
  // as a typed `stopReason` rather than a thrown error. The companion
  // `errorDoneSchema`'s `stopReason: "error"` is reserved for genuine
  // mid-stream failures where the partial state is unsafe to use.
  const ok = (v: unknown) => t.is(doneEventSchema.safeParse(v).success, true);
  const bad = (v: unknown) => t.is(doneEventSchema.safeParse(v).success, false);

  ok({ type: "completionDone", seq: 5, stopReason: "cancelled" });
  ok({
    type: "completionDone",
    seq: 5,
    stopReason: "cancelled",
    raw: { fullText: "partial..." },
  });

  // Cancelled is NOT a valid error-done discriminant — the error
  // payload is forbidden because the stream-end carries no error.
  bad({
    type: "completionDone",
    seq: 5,
    stopReason: "cancelled",
    error: { message: "spurious" },
  });
});

test("completionStatsSchema: all fields optional, promptTokens carries a number", (t) => {
  const ok = (v: unknown) => t.is(completionStatsSchema.safeParse(v).success, true);
  const bad = (v: unknown) => t.is(completionStatsSchema.safeParse(v).success, false);

  // Empty stats are valid — every field is optional (older addons may
  // emit nothing).
  ok({});

  // promptTokens is the new field — must round-trip a number and
  // coexist with the rest of the stats fields.
  ok({ promptTokens: 1234 });
  ok({
    timeToFirstToken: 12.5,
    tokensPerSecond: 42,
    cacheTokens: 100,
    promptTokens: 1234,
    generatedTokens: 56,
    backendDevice: "gpu",
  });

  // Non-numeric values are rejected — the schema must enforce the type
  // so workbench can rely on `stats.promptTokens` being `number |
  // undefined` after parsing.
  bad({ promptTokens: "1234" });
  bad({ promptTokens: null });
});

test("statsEvent: promptTokens flows through the wire event shape", (t) => {
  const ok = (v: unknown) =>
    t.is(completionEventSchema.safeParse(v).success, true);

  ok({
    type: "completionStats",
    seq: 7,
    stats: { promptTokens: 2048, generatedTokens: 64 },
  });
});

test("completionEventSchema: routes event types and rejects unknown", (t) => {
  const ok = (v: unknown) => t.is(completionEventSchema.safeParse(v).success, true);

  ok({ type: "contentDelta", seq: 0, text: "hi" });
  ok({ type: "toolCall", seq: 1, call: { id: "c1", name: "fn", arguments: {} } });
  ok({ type: "toolError", seq: 2, error: { code: "PARSE_ERROR", message: "bad" } });
  ok({ type: "completionStats", seq: 3, stats: { tokensPerSecond: 45 } });
  ok({ type: "completionDone", seq: 4, stopReason: "error", error: { message: "timeout" } });
  ok({ type: "completionDone", seq: 5 });
  ok({ type: "completionDone", seq: 6, stopReason: "cancelled" });

  t.is(completionEventSchema.safeParse({ type: "unknown", seq: 0 }).success, false);
  t.is(completionEventSchema.safeParse({ type: "contentDelta", seq: -1, text: "x" }).success, false);
});

test("completionDone: accepts optional raw field", (t) => {
  const ok = (v: unknown) => t.is(doneEventSchema.safeParse(v).success, true);

  ok({ type: "completionDone", seq: 0, raw: { fullText: "raw output" } });
  ok({ type: "completionDone", seq: 0, stopReason: "eos", raw: { fullText: "" } });
  ok({ type: "completionDone", seq: 0, stopReason: "error", error: { message: "crash" }, raw: { fullText: "partial" } });
});

test("wire response: events required, no legacy fields", (t) => {
  const ok = (v: unknown) => t.is(completionStreamResponseSchema.safeParse(v).success, true);
  const bad = (v: unknown) => t.is(completionStreamResponseSchema.safeParse(v).success, false);

  ok({ type: "completionStream", events: [{ type: "contentDelta", seq: 0, text: "Hi" }] });
  ok({ type: "completionStream", done: true, events: [{ type: "completionDone", seq: 0 }] });
  ok({ type: "completionStream", events: [] });

  bad({ type: "completionStream" });
  bad({ type: "completionStream", events: [{ type: "contentDelta", seq: -1, text: "x" }] });

  bad({ type: "completionStream", events: [], token: "old" });
  bad({ type: "completionStream", events: [], stats: { tokensPerSecond: 1 } });
  bad({ type: "completionStream", events: [], toolCalls: [] });
});
