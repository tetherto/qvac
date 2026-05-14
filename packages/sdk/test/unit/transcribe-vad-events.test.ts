// @ts-ignore brittle has no type declarations
import test from "brittle";
import {
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  vadStateEventSchema,
  endOfTurnEventSchema,
  whisperEndOfTurnEventSchema,
  parakeetEndOfTurnEventSchema,
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

test("endOfTurnEventSchema: accepts a well-formed whisper payload", (t: BrittleT) => {
  const result = endOfTurnEventSchema.safeParse({
    source: "whisper",
    silenceDurationMs: 750,
  });
  t.ok(result.success, "whisper endOfTurn payload is valid");
});

test("endOfTurnEventSchema: accepts a well-formed parakeet payload (no silence window)", (t: BrittleT) => {
  // Parakeet's EOU is token-driven and surfaces the event without a
  // measured silence window.
  const result = endOfTurnEventSchema.safeParse({ source: "parakeet" });
  t.ok(result.success, "parakeet endOfTurn payload is valid");
});

test("whisperEndOfTurnEventSchema: rejects payload missing silenceDurationMs", (t: BrittleT) => {
  // Whisper's silence window is the load-bearing field for downstream
  // consumers (UI captions, end-of-utterance detection, latency
  // metrics). Making it non-optional on the whisper variant catches
  // any upstream regression that would silently drop the field.
  const result = whisperEndOfTurnEventSchema.safeParse({ source: "whisper" });
  t.ok(
    !result.success,
    "whisper endOfTurn without silenceDurationMs is rejected",
  );
});

test("endOfTurnEventSchema: rejects whisper payload missing silenceDurationMs", (t: BrittleT) => {
  // Same invariant exercised through the union — the whisper branch
  // must reject a missing silence window even when reached via the
  // discriminator.
  const result = endOfTurnEventSchema.safeParse({ source: "whisper" });
  t.ok(
    !result.success,
    "discriminated whisper endOfTurn without silenceDurationMs is rejected",
  );
});

test("endOfTurnEventSchema: rejects payload without a source discriminator", (t: BrittleT) => {
  // `source` is the discriminator; payloads missing it (i.e. the
  // pre-discriminated-union wire shape) must not parse — that
  // catches old senders forwarding the legacy `{ silenceDurationMs }`
  // object without tagging which engine produced it.
  const result = endOfTurnEventSchema.safeParse({ silenceDurationMs: 500 });
  t.ok(
    !result.success,
    "endOfTurn without `source` discriminator is rejected",
  );
});

test("parakeetEndOfTurnEventSchema: rejects extraneous silenceDurationMs in strict mode", (t: BrittleT) => {
  const result = parakeetEndOfTurnEventSchema.strict().safeParse({
    source: "parakeet",
    silenceDurationMs: 500,
  });
  t.ok(
    !result.success,
    "parakeet endOfTurn with silenceDurationMs is rejected (whisper-only field)",
  );
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

test("transcribeStreamResponseSchema: round-trips a whisper endOfTurn frame", (t: BrittleT) => {
  const wire = {
    type: "transcribeStream" as const,
    endOfTurn: { source: "whisper" as const, silenceDurationMs: 1200 },
  };
  const parsed = transcribeStreamResponseSchema.safeParse(wire);
  t.ok(parsed.success, "whisper endOfTurn frame is valid");
  if (parsed.success) {
    t.alike(parsed.data.endOfTurn, wire.endOfTurn, "endOfTurn preserved");
  }
});

test("transcribeStreamResponseSchema: round-trips a parakeet endOfTurn frame", (t: BrittleT) => {
  const wire = {
    type: "transcribeStream" as const,
    endOfTurn: { source: "parakeet" as const },
  };
  const parsed = transcribeStreamResponseSchema.safeParse(wire);
  t.ok(parsed.success, "parakeet endOfTurn frame is valid");
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
    { type: "endOfTurn", source: "whisper", silenceDurationMs: 500 },
    { type: "endOfTurn", source: "parakeet" },
  ];

  const seen: Record<string, number> = {};
  let whisperEot = 0;
  let parakeetEot = 0;
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
        if (ev.source === "whisper") {
          t.is(typeof ev.silenceDurationMs, "number");
          whisperEot++;
        } else {
          t.is(ev.source, "parakeet");
          parakeetEot++;
        }
        break;
    }
  }
  t.is(Object.keys(seen).length, 4, "all four event variants exercised");
  t.is(whisperEot, 1, "whisper endOfTurn variant covered");
  t.is(parakeetEot, 1, "parakeet endOfTurn variant covered");
});
