// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  completionEventSchema,
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

test("completionEventSchema: routes event types and rejects unknown", (t) => {
  const ok = (v: unknown) => t.is(completionEventSchema.safeParse(v).success, true);

  ok({ type: "contentDelta", seq: 0, text: "hi" });
  ok({ type: "toolCall", seq: 1, call: { id: "c1", name: "fn", arguments: {} } });
  ok({ type: "toolError", seq: 2, error: { code: "PARSE_ERROR", message: "bad" } });
  ok({ type: "completionStats", seq: 3, stats: { tokensPerSecond: 45 } });
  ok({ type: "completionDone", seq: 4, stopReason: "error", error: { message: "timeout" } });
  ok({ type: "completionDone", seq: 5 });

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
