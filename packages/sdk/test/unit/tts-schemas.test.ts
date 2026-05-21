// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  ttsRequestSchema,
  ttsResponseSchema,
  textToSpeechStreamResponseSchema,
  ttsChatterboxConfigSchema,
  ttsSupertonicConfigSchema,
  ttsConfigSchema,
} from "@/schemas/text-to-speech";
import { loadTtsModelRequestSchema } from "@/schemas/load-model";
import { ModelType } from "@/schemas/model-types";

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

// =============================================================================
// ttsChatterboxConfigSchema (ggml-tts disjunction)
// =============================================================================

test("ttsChatterboxConfigSchema: accepts ttsModelDirSrc only", (t) => {
  const r = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsModelDirSrc: "models/chatterbox",
  });
  t.is(r.success, true);
});

test("ttsChatterboxConfigSchema: accepts ttsT3ModelSrc + ttsS3genModelSrc", (t) => {
  const r = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsT3ModelSrc: "models/t3.gguf",
    ttsS3genModelSrc: "models/s3gen.gguf",
  });
  t.is(r.success, true);
});

test("ttsChatterboxConfigSchema: accepts modelDir + referenceAudio + voicesDir + tuning fields", (t) => {
  const r = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsModelDirSrc: "models/chatterbox",
    referenceAudioSrc: "voice.wav",
    voicesDirSrc: "voices/",
    nGpuLayers: 99,
    useGPU: true,
    seed: 42,
    streamChunkTokens: 25,
    streamFirstChunkTokens: 8,
    cfmSteps: 2,
    outputSampleRate: 22050,
  });
  t.is(r.success, true);
});

test("ttsChatterboxConfigSchema: rejects when neither modelDir nor T3+S3GEN are provided", (t) => {
  const r = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
  });
  t.is(
    r.success,
    false,
    "Chatterbox without modelDir or T3+S3GEN must fail validation",
  );
});

test("ttsChatterboxConfigSchema: rejects T3 without S3GEN", (t) => {
  const r = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsT3ModelSrc: "models/t3.gguf",
  });
  t.is(r.success, false, "T3 alone is insufficient without S3GEN");
});

test("ttsChatterboxConfigSchema: rejects S3GEN without T3", (t) => {
  const r = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsS3genModelSrc: "models/s3gen.gguf",
  });
  t.is(r.success, false, "S3GEN alone is insufficient without T3");
});

test("ttsChatterboxConfigSchema: rejects wrong engine literal", (t) => {
  const r = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "en",
    ttsModelDirSrc: "models/chatterbox",
  });
  t.is(r.success, false);
});

// =============================================================================
// ttsSupertonicConfigSchema (ggml-tts disjunction)
// =============================================================================

test("ttsSupertonicConfigSchema: accepts ttsModelDirSrc only", (t) => {
  const r = ttsSupertonicConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "en",
    ttsModelDirSrc: "models/supertonic",
  });
  t.is(r.success, true);
});

test("ttsSupertonicConfigSchema: accepts ttsSupertonicModelSrc only", (t) => {
  const r = ttsSupertonicConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "en",
    ttsSupertonicModelSrc: "models/supertonic.gguf",
  });
  t.is(r.success, true);
});

test("ttsSupertonicConfigSchema: accepts tuning fields", (t) => {
  const r = ttsSupertonicConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "es",
    ttsSupertonicModelSrc: "models/supertonic.gguf",
    ttsSpeed: 1.05,
    ttsNumInferenceSteps: 5,
    voiceName: "F1",
    seed: 7,
    outputSampleRate: 22050,
  });
  t.is(r.success, true);
});

test("ttsSupertonicConfigSchema: rejects when neither modelDir nor supertonicModel is provided", (t) => {
  const r = ttsSupertonicConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "en",
  });
  t.is(
    r.success,
    false,
    "Supertonic without modelDir or supertonicModel must fail validation",
  );
});

// =============================================================================
// ttsConfigSchema (discriminated union)
// =============================================================================

test("ttsConfigSchema: routes to chatterbox arm via ttsEngine literal", (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsT3ModelSrc: "models/t3.gguf",
    ttsS3genModelSrc: "models/s3gen.gguf",
  });
  t.is(r.success, true);
});

test("ttsConfigSchema: routes to supertonic arm via ttsEngine literal", (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "en",
    ttsSupertonicModelSrc: "models/supertonic.gguf",
  });
  t.is(r.success, true);
});

test("ttsConfigSchema: rejects unknown ttsEngine", (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: "piper",
    language: "en",
    ttsModelDirSrc: "models/piper",
  });
  t.is(r.success, false);
});

test("ttsConfigSchema: rejects unknown language code", (t) => {
  const r = ttsConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "ja",
    ttsSupertonicModelSrc: "models/supertonic.gguf",
  });
  t.is(r.success, false);
});

// =============================================================================
// loadTtsModelRequestSchema (canonical type only)
// =============================================================================

test("loadTtsModelRequestSchema: accepts canonical ggml-tts modelType", (t) => {
  const r = loadTtsModelRequestSchema.safeParse({
    type: "loadModel",
    modelSrc: "models/t3.gguf",
    modelType: ModelType.ggmlTts,
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      ttsT3ModelSrc: "models/t3.gguf",
      ttsS3genModelSrc: "models/s3gen.gguf",
    },
  });
  t.is(r.success, true);
});

test("loadTtsModelRequestSchema: rejects when modelConfig fails the disjunction", (t) => {
  const r = loadTtsModelRequestSchema.safeParse({
    type: "loadModel",
    modelSrc: "models/t3.gguf",
    modelType: ModelType.ggmlTts,
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
    },
  });
  t.is(
    r.success,
    false,
    "loadTtsModelRequestSchema must surface the inner config-disjunction failure",
  );
});

test("loadTtsModelRequestSchema: rejects legacy onnx-tts modelType literal", (t) => {
  const r = loadTtsModelRequestSchema.safeParse({
    type: "loadModel",
    modelSrc: "models/t3.gguf",
    modelType: "onnx-tts",
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      ttsT3ModelSrc: "models/t3.gguf",
      ttsS3genModelSrc: "models/s3gen.gguf",
    },
  });
  t.is(r.success, false, "legacy onnx-tts literal is no longer accepted");
});
