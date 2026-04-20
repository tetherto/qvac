// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  lavaSREnhancerConfigSchema,
  ttsEnhancerConfigSchema,
  ttsChatterboxRuntimeConfigSchema,
  ttsSupertonicRuntimeConfigSchema,
  ttsChatterboxConfigSchema,
  ttsSupertonicConfigSchema,
} from "@/schemas/text-to-speech";

// --- lavaSREnhancerConfigSchema (load-time) ---

test("lavaSREnhancerConfigSchema: accepts valid config with required model sources", (t) => {
  const result = lavaSREnhancerConfigSchema.safeParse({
    type: "lavasr",
    enhance: true,
    backboneSrc: "backbone.onnx",
    specHeadSrc: "spechead.onnx",
  });
  t.is(result.success, true);
});

test("lavaSREnhancerConfigSchema: accepts config with optional denoiserSrc", (t) => {
  const result = lavaSREnhancerConfigSchema.safeParse({
    type: "lavasr",
    enhance: true,
    denoise: true,
    backboneSrc: "backbone.onnx",
    specHeadSrc: "spechead.onnx",
    denoiserSrc: "denoiser.onnx",
  });
  t.is(result.success, true);
});

test("lavaSREnhancerConfigSchema: rejects missing backboneSrc", (t) => {
  const result = lavaSREnhancerConfigSchema.safeParse({
    type: "lavasr",
    enhance: true,
    specHeadSrc: "spechead.onnx",
  });
  t.is(result.success, false);
});

test("lavaSREnhancerConfigSchema: rejects missing specHeadSrc", (t) => {
  const result = lavaSREnhancerConfigSchema.safeParse({
    type: "lavasr",
    enhance: true,
    backboneSrc: "backbone.onnx",
  });
  t.is(result.success, false);
});

test("lavaSREnhancerConfigSchema: rejects wrong type discriminator", (t) => {
  const result = lavaSREnhancerConfigSchema.safeParse({
    type: "unknown",
    backboneSrc: "backbone.onnx",
    specHeadSrc: "spechead.onnx",
  });
  t.is(result.success, false);
});

// --- ttsEnhancerConfigSchema (discriminated union) ---

test("ttsEnhancerConfigSchema: accepts valid lavasr config", (t) => {
  const result = ttsEnhancerConfigSchema.safeParse({
    type: "lavasr",
    enhance: true,
    backboneSrc: "backbone.onnx",
    specHeadSrc: "spechead.onnx",
  });
  t.is(result.success, true);
});

test("ttsEnhancerConfigSchema: rejects unknown enhancer type", (t) => {
  const result = ttsEnhancerConfigSchema.safeParse({
    type: "unknown-enhancer",
    backboneSrc: "backbone.onnx",
    specHeadSrc: "spechead.onnx",
  });
  t.is(result.success, false);
});

// --- Runtime config schemas (enhancer without model sources) ---

test("ttsChatterboxRuntimeConfigSchema: accepts config with runtime enhancer", (t) => {
  const result = ttsChatterboxRuntimeConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    enhancer: { type: "lavasr", enhance: true, denoise: false },
  });
  t.is(result.success, true);
});

test("ttsChatterboxRuntimeConfigSchema: accepts config without enhancer", (t) => {
  const result = ttsChatterboxRuntimeConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
  });
  t.is(result.success, true);
});

test("ttsSupertonicRuntimeConfigSchema: accepts config with runtime enhancer", (t) => {
  const result = ttsSupertonicRuntimeConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "en",
    enhancer: { type: "lavasr", enhance: true },
  });
  t.is(result.success, true);
});

// --- Load-time config: enhancer overrides runtime schema ---

test("ttsChatterboxConfigSchema: requires model sources in enhancer at load time", (t) => {
  const withSources = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsTokenizerSrc: "tok.bin",
    ttsSpeechEncoderSrc: "enc.onnx",
    ttsEmbedTokensSrc: "emb.onnx",
    ttsConditionalDecoderSrc: "dec.onnx",
    ttsLanguageModelSrc: "lm.onnx",
    referenceAudioSrc: "ref.wav",
    enhancer: {
      type: "lavasr",
      enhance: true,
      backboneSrc: "backbone.onnx",
      specHeadSrc: "spechead.onnx",
    },
  });
  t.is(withSources.success, true);

  const withoutSources = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsTokenizerSrc: "tok.bin",
    ttsSpeechEncoderSrc: "enc.onnx",
    ttsEmbedTokensSrc: "emb.onnx",
    ttsConditionalDecoderSrc: "dec.onnx",
    ttsLanguageModelSrc: "lm.onnx",
    referenceAudioSrc: "ref.wav",
    enhancer: {
      type: "lavasr",
      enhance: true,
    },
  });
  t.is(withoutSources.success, false);
});

test("ttsSupertonicConfigSchema: requires model sources in enhancer at load time", (t) => {
  const withSources = ttsSupertonicConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "en",
    ttsTokenizerSrc: "tok.bin",
    ttsTextEncoderSrc: "enc.onnx",
    ttsLatentDenoiserSrc: "den.onnx",
    ttsVoiceDecoderSrc: "vdec.onnx",
    ttsVoiceSrc: "voice.bin",
    enhancer: {
      type: "lavasr",
      enhance: true,
      backboneSrc: "backbone.onnx",
      specHeadSrc: "spechead.onnx",
    },
  });
  t.is(withSources.success, true);
});

test("ttsChatterboxConfigSchema: accepts config without enhancer", (t) => {
  const result = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsTokenizerSrc: "tok.bin",
    ttsSpeechEncoderSrc: "enc.onnx",
    ttsEmbedTokensSrc: "emb.onnx",
    ttsConditionalDecoderSrc: "dec.onnx",
    ttsLanguageModelSrc: "lm.onnx",
    referenceAudioSrc: "ref.wav",
  });
  t.is(result.success, true);
});

test("ttsSupertonicConfigSchema: accepts config without enhancer", (t) => {
  const result = ttsSupertonicConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "en",
    ttsTokenizerSrc: "tok.bin",
    ttsTextEncoderSrc: "enc.onnx",
    ttsLatentDenoiserSrc: "den.onnx",
    ttsVoiceDecoderSrc: "vdec.onnx",
    ttsVoiceSrc: "voice.bin",
  });
  t.is(result.success, true);
});

// --- Runtime schemas reject load-time model source fields ---

test("ttsChatterboxRuntimeConfigSchema: strips load-time model source fields from enhancer", (t) => {
  const result = ttsChatterboxRuntimeConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    enhancer: {
      type: "lavasr",
      enhance: true,
      backboneSrc: "backbone.onnx",
      specHeadSrc: "spechead.onnx",
    },
  });
  t.is(result.success, true);
  const keys = Object.keys(result.data?.enhancer ?? {});
  t.ok(!keys.includes("backboneSrc"), "backboneSrc should be stripped from runtime config");
  t.ok(!keys.includes("specHeadSrc"), "specHeadSrc should be stripped from runtime config");
});

test("ttsSupertonicRuntimeConfigSchema: strips load-time model source fields from enhancer", (t) => {
  const result = ttsSupertonicRuntimeConfigSchema.safeParse({
    ttsEngine: "supertonic",
    language: "en",
    enhancer: {
      type: "lavasr",
      enhance: true,
      backboneSrc: "backbone.onnx",
      specHeadSrc: "spechead.onnx",
    },
  });
  t.is(result.success, true);
  const keys = Object.keys(result.data?.enhancer ?? {});
  t.ok(!keys.includes("backboneSrc"), "backboneSrc should be stripped from runtime config");
  t.ok(!keys.includes("specHeadSrc"), "specHeadSrc should be stripped from runtime config");
});

// --- ttsEnhancerConfigSchema: denoise/denoiserSrc refinement ---

test("ttsEnhancerConfigSchema: rejects denoise true without denoiserSrc", (t) => {
  const result = ttsEnhancerConfigSchema.safeParse({
    type: "lavasr",
    enhance: true,
    denoise: true,
    backboneSrc: "backbone.onnx",
    specHeadSrc: "spechead.onnx",
  });
  t.is(result.success, false);
});

test("ttsEnhancerConfigSchema: accepts denoise true with denoiserSrc", (t) => {
  const result = ttsEnhancerConfigSchema.safeParse({
    type: "lavasr",
    enhance: true,
    denoise: true,
    backboneSrc: "backbone.onnx",
    specHeadSrc: "spechead.onnx",
    denoiserSrc: "denoiser.onnx",
  });
  t.is(result.success, true);
});

test("ttsEnhancerConfigSchema: accepts denoise false without denoiserSrc", (t) => {
  const result = ttsEnhancerConfigSchema.safeParse({
    type: "lavasr",
    enhance: true,
    denoise: false,
    backboneSrc: "backbone.onnx",
    specHeadSrc: "spechead.onnx",
  });
  t.is(result.success, true);
});

test("ttsEnhancerConfigSchema: rejects empty object", (t) => {
  const result = ttsEnhancerConfigSchema.safeParse({});
  t.is(result.success, false);
});

test("ttsEnhancerConfigSchema: rejects object without type discriminator", (t) => {
  const result = ttsEnhancerConfigSchema.safeParse({
    enhance: true,
    backboneSrc: "backbone.onnx",
    specHeadSrc: "spechead.onnx",
  });
  t.is(result.success, false);
});

// --- Load-time config: denoise refinement propagates through parent schemas ---

test("ttsChatterboxConfigSchema: rejects enhancer with denoise true but no denoiserSrc", (t) => {
  const result = ttsChatterboxConfigSchema.safeParse({
    ttsEngine: "chatterbox",
    language: "en",
    ttsTokenizerSrc: "tok.bin",
    ttsSpeechEncoderSrc: "enc.onnx",
    ttsEmbedTokensSrc: "emb.onnx",
    ttsConditionalDecoderSrc: "dec.onnx",
    ttsLanguageModelSrc: "lm.onnx",
    referenceAudioSrc: "ref.wav",
    enhancer: {
      type: "lavasr",
      enhance: true,
      denoise: true,
      backboneSrc: "backbone.onnx",
      specHeadSrc: "spechead.onnx",
    },
  });
  t.is(result.success, false);
});
