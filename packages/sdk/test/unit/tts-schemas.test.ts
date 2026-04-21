// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  ttsRequestSchema,
  ttsResponseSchema,
  textToSpeechStreamResponseSchema,
} from "@/schemas/text-to-speech";

test("ttsRequestSchema: accepts sentenceStream options", (t) => {
  const r = ttsRequestSchema.safeParse({
    type: "textToSpeech",
    modelId: "m1",
    text: "Hello. World.",
    stream: true,
    sentenceStream: true,
    sentenceStreamLocale: "en-US",
    sentenceStreamMaxChunkScalars: 200,
  });
  t.is(r.success, true);
  if (r.success) {
    t.is(r.data.sentenceStream, true);
    t.is(r.data.sentenceStreamLocale, "en-US");
    t.is(r.data.sentenceStreamMaxChunkScalars, 200);
  }
});

test("ttsResponseSchema: accepts optional chunk metadata", (t) => {
  const r = ttsResponseSchema.safeParse({
    type: "textToSpeech",
    buffer: [1, 2, 3],
    done: false,
    chunkIndex: 0,
    sentenceChunk: "Hello.",
  });
  t.is(r.success, true);
  if (r.success) {
    t.is(r.data.chunkIndex, 0);
    t.is(r.data.sentenceChunk, "Hello.");
  }
});

// =============================================================================
// textToSpeechStreamResponseSchema
// =============================================================================

test("textToSpeechStreamResponseSchema: accepts minimal valid response", (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: "textToSpeechStream",
    buffer: [1, 2, 3],
  });
  t.is(r.success, true);
  if (r.success) {
    t.is(r.data.type, "textToSpeechStream");
    t.alike(r.data.buffer, [1, 2, 3]);
    t.is(r.data.done, false, "done defaults to false");
  }
});

test("textToSpeechStreamResponseSchema: accepts done response with stats", (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: "textToSpeechStream",
    buffer: [],
    done: true,
    stats: { audioDuration: 1200, totalSamples: 48000 },
  });
  t.is(r.success, true);
  if (r.success) {
    t.is(r.data.done, true);
    t.is(r.data.stats?.audioDuration, 1200);
    t.is(r.data.stats?.totalSamples, 48000);
  }
});

test("textToSpeechStreamResponseSchema: accepts optional chunk metadata", (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: "textToSpeechStream",
    buffer: [10, 20],
    chunkIndex: 3,
    sentenceChunk: "World.",
  });
  t.is(r.success, true);
  if (r.success) {
    t.is(r.data.chunkIndex, 3);
    t.is(r.data.sentenceChunk, "World.");
  }
});

test("textToSpeechStreamResponseSchema: rejects wrong type literal", (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: "textToSpeech",
    buffer: [1, 2, 3],
  });
  t.is(r.success, false, "wrong type literal is rejected");
});

test("textToSpeechStreamResponseSchema: rejects missing buffer", (t) => {
  const r = textToSpeechStreamResponseSchema.safeParse({
    type: "textToSpeechStream",
  });
  t.is(r.success, false, "missing buffer is rejected");
});
