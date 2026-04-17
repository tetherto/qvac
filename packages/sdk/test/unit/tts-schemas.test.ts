// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  ttsRequestSchema,
  ttsResponseSchema,
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
