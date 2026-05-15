// @ts-ignore brittle has no type declarations
import test from "brittle";
import {
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  vadStateEventSchema,
  endOfTurnEventSchema,
  type TranscribeStreamEvent,
} from "@/schemas/transcription";

type BrittleT = {
  is: Function;
  ok: Function;
  exception: Function;
  execution: Function;
  not: Function;
  alike: Function;
  teardown: Function;
};

// =============================================================================
// vadStateEventSchema / endOfTurnEventSchema round-trip
// =============================================================================

test("vadStateEventSchema: accepts a well-formed VAD payload", (t: BrittleT) => {
  const result = vadStateEventSchema.safeParse({
    speaking: true,
    probability: 0.87,
  });
  t.ok(result.success, "vad payload is valid");
});

test("vadStateEventSchema: rejects missing fields", (t: BrittleT) => {
  const noProbability = vadStateEventSchema.safeParse({ speaking: false });
  t.ok(!noProbability.success, "vad without probability is rejected");

  const noSpeaking = vadStateEventSchema.safeParse({ probability: 0.1 });
  t.ok(!noSpeaking.success, "vad without speaking is rejected");
});

test("endOfTurnEventSchema: accepts a well-formed payload", (t: BrittleT) => {
  const result = endOfTurnEventSchema.safeParse({ silenceDurationMs: 750 });
  t.ok(result.success, "endOfTurn payload is valid");
});

test("endOfTurnEventSchema: rejects missing fields", (t: BrittleT) => {
  const empty = endOfTurnEventSchema.safeParse({});
  t.ok(!empty.success, "endOfTurn without silenceDurationMs is rejected");
});

// =============================================================================
// transcribeStreamRequestSchema — conversation opt-in fields
// =============================================================================

test("transcribeStreamRequestSchema: accepts emitVadEvents: true", (t: BrittleT) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "m",
    emitVadEvents: true,
  });
  t.ok(result.success, "request with emitVadEvents parses");
  if (result.success) t.is(result.data.emitVadEvents, true, "flag preserved");
});

test("transcribeStreamRequestSchema: accepts endOfTurnSilenceMs and vadRunIntervalMs", (t: BrittleT) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "m",
    emitVadEvents: true,
    endOfTurnSilenceMs: 800,
    vadRunIntervalMs: 100,
  });
  t.ok(result.success, "request with full conversation opts parses");
  if (result.success) {
    t.is(result.data.endOfTurnSilenceMs, 800);
    t.is(result.data.vadRunIntervalMs, 100);
  }
});

test("transcribeStreamRequestSchema: rejects negative endOfTurnSilenceMs", (t: BrittleT) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "m",
    endOfTurnSilenceMs: -1,
  });
  t.ok(!result.success, "negative silence is rejected");
});

test("transcribeStreamRequestSchema: rejects non-positive vadRunIntervalMs", (t: BrittleT) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "m",
    vadRunIntervalMs: 0,
  });
  t.ok(!result.success, "zero interval is rejected");
});

test("transcribeStreamRequestSchema: conversation opts are optional", (t: BrittleT) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "m",
  });
  t.ok(result.success, "request without conversation opts still parses");
  if (result.success) {
    t.is(result.data.emitVadEvents, undefined);
    t.is(result.data.endOfTurnSilenceMs, undefined);
    t.is(result.data.vadRunIntervalMs, undefined);
  }
});

// =============================================================================
// transcribeStreamResponseSchema — vad / endOfTurn frames
// =============================================================================

test("transcribeStreamResponseSchema: round-trips a vad frame", (t: BrittleT) => {
  const wire = {
    type: "transcribeStream" as const,
    vad: { speaking: true, probability: 0.92 },
  };
  const parsed = transcribeStreamResponseSchema.safeParse(wire);
  t.ok(parsed.success, "vad frame is valid");
  if (parsed.success) t.alike(parsed.data.vad, wire.vad, "vad preserved");
});

test("transcribeStreamResponseSchema: round-trips an endOfTurn frame", (t: BrittleT) => {
  const wire = {
    type: "transcribeStream" as const,
    endOfTurn: { silenceDurationMs: 1200 },
  };
  const parsed = transcribeStreamResponseSchema.safeParse(wire);
  t.ok(parsed.success, "endOfTurn frame is valid");
  if (parsed.success) {
    t.alike(parsed.data.endOfTurn, wire.endOfTurn, "endOfTurn preserved");
  }
});

test("transcribeStreamResponseSchema: text frames remain valid alongside event fields", (t: BrittleT) => {
  const parsed = transcribeStreamResponseSchema.safeParse({
    type: "transcribeStream",
    text: "hello",
  });
  t.ok(parsed.success, "plain text frame still parses (additive change)");
  if (parsed.success) {
    t.is(parsed.data.text, "hello");
    t.is(parsed.data.vad, undefined);
    t.is(parsed.data.endOfTurn, undefined);
  }
});

// =============================================================================
// TranscribeStreamEvent discriminated union — exhaustiveness sanity check
// =============================================================================

test("TranscribeStreamEvent: discriminated union narrows correctly", (t: BrittleT) => {
  const events: TranscribeStreamEvent[] = [
    { type: "text", text: "hi" },
    {
      type: "segment",
      segment: { text: "s", startMs: 0, endMs: 100, append: false, id: 0 },
    },
    { type: "vad", speaking: true, probability: 0.5 },
    { type: "endOfTurn", silenceDurationMs: 500 },
  ];

  const seen: Record<string, number> = {};
  for (const ev of events) {
    seen[ev.type] = (seen[ev.type] ?? 0) + 1;
    switch (ev.type) {
      case "text":
        t.is(typeof ev.text, "string");
        break;
      case "segment":
        t.is(typeof ev.segment.text, "string");
        break;
      case "vad":
        t.is(typeof ev.speaking, "boolean");
        t.is(typeof ev.probability, "number");
        break;
      case "endOfTurn":
        t.is(typeof ev.silenceDurationMs, "number");
        break;
    }
  }
  t.is(Object.keys(seen).length, 4, "all four event variants exercised");
});
