import test from "brittle";
import {
  ttsRequestSchema,
  ttsResponseSchema,
  textToSpeechStreamResponseSchema,
  ttsConfigSchema,
  ttsSupertonicRuntimeConfigSchema,
  LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS,
} from "@/schemas/text-to-speech";

test("ttsConfigSchema: accepts GGML chatterbox load config", (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    s3genModelSrc: "s3:///qvac_models_compiled/chatterbox/2026-05-08/chatterbox-s3gen.gguf",
  });
  t.is(r.success, true);
});

test("ttsConfigSchema: accepts GGML supertonic load config", (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "en",
    voice: "F1",
  });
  t.is(r.success, true);
});

test("ttsSupertonicRuntimeConfigSchema: strips removed ttsSupertonicMultilingual", (t) => {
  const r = ttsSupertonicRuntimeConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "es",
    ttsSupertonicMultilingual: true,
  });
  t.is(r.success, true);
  if (r.success) {
    t.is("ttsSupertonicMultilingual" in r.data, false);
  }
});

test("ttsConfigSchema: accepts real legacy ONNX Chatterbox shape without s3genModelSrc", (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsSpeechEncoderSrc: "s3:///legacy/speech_encoder.onnx",
    ttsEmbedTokensSrc: "s3:///legacy/embed_tokens.onnx",
    ttsConditionalDecoderSrc: "s3:///legacy/conditional_decoder.onnx",
    ttsLanguageModelSrc: "s3:///legacy/language_model.onnx",
  });
  t.is(
    r.success,
    true,
    "legacy ONNX Chatterbox config must pass schema (plugin rejects at resolveConfig)",
  );
});

test("ttsConfigSchema: accepts legacy ONNX field names for migration errors", (t) => {
  for (const name of LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS) {
    const r = ttsConfigSchema.safeParse({
      ttsEngine: "chatterbox",
      language: "en",
      s3genModelSrc: "s3:///example/s3gen.gguf",
      [name]: "legacy-value",
    });
    t.is(r.success, true, `${name} should parse (plugin rejects at resolveConfig)`);
  }
});

test("ttsConfigSchema: rejects truly unknown fields under .strict()", (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    s3genModelSrc: "s3:///example/s3gen.gguf",
    notATtsField: "anything",
  });
  t.is(r.success, false, "non-legacy unknown fields remain strictly rejected");
});

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
