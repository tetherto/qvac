import test from "brittle";
import {
  nmtConfigBaseSchema,
  nmtConfigSchema,
} from "@/schemas/translation-config";
import {
  translateRequestSchema,
  translateResponseSchema,
  translateServerParamsSchema,
  translationStatsSchema,
} from "@/schemas/translate";
import { ModelType } from "@/schemas";
import { loadModelOptionsToRequestSchema } from "@/schemas/load-model";

// === nmtConfigBaseSchema (discriminated union) ===

test("nmtConfigBaseSchema: accepts a minimal Bergamot config", (t) => {
  const result = nmtConfigBaseSchema.safeParse({
    engine: "Bergamot",
    from: "en",
    to: "fr",
  });
  t.is(result.success, true);
});

test("nmtConfigBaseSchema: accepts Bergamot with optional generation params", (t) => {
  const result = nmtConfigBaseSchema.safeParse({
    engine: "Bergamot",
    from: "en",
    to: "es",
    beamsize: 4,
    normalize: 1,
    temperature: 0.3,
  });
  t.is(result.success, true);
});

test("nmtConfigBaseSchema: accepts Bergamot with pivot model", (t) => {
  const result = nmtConfigBaseSchema.safeParse({
    engine: "Bergamot",
    from: "es",
    to: "it",
    pivotModel: {
      modelSrc: "s3:///bergamot/model.enit.intgemm.alphas.bin",
      normalize: 1,
      beamsize: 4,
    },
  });
  t.is(result.success, true);
});

test("nmtConfigBaseSchema: accepts a minimal IndicTrans config", (t) => {
  const result = nmtConfigBaseSchema.safeParse({
    engine: "IndicTrans",
    from: "eng_Latn",
    to: "hin_Deva",
  });
  t.is(result.success, true);
});

test("nmtConfigBaseSchema: accepts IndicTrans with generation params", (t) => {
  const result = nmtConfigBaseSchema.safeParse({
    engine: "IndicTrans",
    from: "hin_Deva",
    to: "eng_Latn",
    beamsize: 1,
    maxlength: 256,
    temperature: 0.5,
    topk: 10,
  });
  t.is(result.success, true);
});

test("nmtConfigBaseSchema: rejects unknown engine", (t) => {
  const result = nmtConfigBaseSchema.safeParse({
    engine: "Opus",
    from: "en",
    to: "fr",
  });
  t.is(result.success, false);
});

test("nmtConfigBaseSchema: rejects Bergamot with IndicTrans language codes", (t) => {
  const result = nmtConfigBaseSchema.safeParse({
    engine: "Bergamot",
    from: "eng_Latn",
    to: "hin_Deva",
  });
  t.is(result.success, false);
});

test("nmtConfigBaseSchema: rejects IndicTrans with Bergamot language codes", (t) => {
  const result = nmtConfigBaseSchema.safeParse({
    engine: "IndicTrans",
    from: "en",
    to: "fr",
  });
  t.is(result.success, false);
});

test("nmtConfigBaseSchema: rejects missing engine", (t) => {
  const result = nmtConfigBaseSchema.safeParse({
    from: "en",
    to: "fr",
  });
  t.is(result.success, false);
});

test("nmtConfigBaseSchema: rejects missing from/to", (t) => {
  const result = nmtConfigBaseSchema.safeParse({
    engine: "Bergamot",
  });
  t.is(result.success, false);
});

// === nmtConfigSchema (defaults transform) ===

test("nmtConfigSchema: applies defaults for Bergamot", (t) => {
  const result = nmtConfigSchema.parse({
    engine: "Bergamot",
    from: "en",
    to: "fr",
  });
  t.is(result.engine, "Bergamot");
  t.is(result.mode, "full");
  t.is(result.beamsize, 4);
  t.is(result.lengthpenalty, 1.0);
  t.is(result.maxlength, 512);
  t.is(result.repetitionpenalty, 1.0);
  t.is(result.norepeatngramsize, 0);
  t.is(result.temperature, 0.3);
  t.is(result.topk, 0);
  t.is(result.topp, 1.0);
});

test("nmtConfigSchema: applies defaults for IndicTrans", (t) => {
  const result = nmtConfigSchema.parse({
    engine: "IndicTrans",
    from: "eng_Latn",
    to: "hin_Deva",
  });
  t.is(result.engine, "IndicTrans");
  t.is(result.beamsize, 4);
  t.is(result.maxlength, 512);
});

test("nmtConfigSchema: preserves user-supplied generation params", (t) => {
  const result = nmtConfigSchema.parse({
    engine: "IndicTrans",
    from: "eng_Latn",
    to: "hin_Deva",
    beamsize: 1,
    maxlength: 256,
    temperature: 0.8,
  });
  t.is(result.beamsize, 1);
  t.is(result.maxlength, 256);
  t.is(result.temperature, 0.8);
});

// === translateRequestSchema ===

test("translateRequestSchema: accepts NMT request with string text", (t) => {
  const result = translateRequestSchema.safeParse({
    type: "translate",
    modelId: "model-123",
    text: "Hello world",
    stream: false,
    modelType: "nmt",
  });
  t.is(result.success, true);
});

test("translateRequestSchema: accepts NMT request with array text", (t) => {
  const result = translateRequestSchema.safeParse({
    type: "translate",
    modelId: "model-123",
    text: ["Hello", "World"],
    stream: true,
    modelType: "nmt",
  });
  t.is(result.success, true);
});

test("translateRequestSchema: accepts NMT request with canonical modelType", (t) => {
  const result = translateRequestSchema.safeParse({
    type: "translate",
    modelId: "model-123",
    text: "Hello",
    stream: false,
    modelType: "nmtcpp-translation",
  });
  t.is(result.success, true);
});

test("translateRequestSchema: accepts NMT request with optional requestId", (t) => {
  const result = translateRequestSchema.safeParse({
    type: "translate",
    modelId: "model-123",
    text: "Hello",
    stream: false,
    modelType: "nmt",
    requestId: "req-abc",
  });
  t.is(result.success, true);
});

test("translateRequestSchema: rejects NMT request with empty string text", (t) => {
  const result = translateRequestSchema.safeParse({
    type: "translate",
    modelId: "model-123",
    text: "",
    stream: false,
    modelType: "nmt",
  });
  t.is(result.success, false);
});

test("translateRequestSchema: rejects NMT request with empty array", (t) => {
  const result = translateRequestSchema.safeParse({
    type: "translate",
    modelId: "model-123",
    text: [],
    stream: false,
    modelType: "nmt",
  });
  t.is(result.success, false);
});

// === translationStatsSchema ===

test("translationStatsSchema: accepts NMT-specific stats fields", (t) => {
  const result = translationStatsSchema.safeParse({
    totalTime: 150,
    totalTokens: 42,
    tokensPerSecond: 280,
    decodeTime: 120,
    encodeTime: 30,
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.decodeTime, 120);
    t.is(result.data.encodeTime, 30);
  }
});

test("translationStatsSchema: accepts an empty stats object", (t) => {
  const result = translationStatsSchema.safeParse({});
  t.is(result.success, true);
});

// === translateResponseSchema ===

test("translateResponseSchema: accepts a streaming token response", (t) => {
  const result = translateResponseSchema.safeParse({
    type: "translate",
    token: "Bonjour",
  });
  t.is(result.success, true);
});

test("translateResponseSchema: accepts a done response with stats", (t) => {
  const result = translateResponseSchema.safeParse({
    type: "translate",
    token: "",
    done: true,
    stats: { totalTime: 100, totalTokens: 10 },
  });
  t.is(result.success, true);
});

test("translateResponseSchema: rejects missing type field", (t) => {
  const result = translateResponseSchema.safeParse({
    token: "hello",
  });
  t.is(result.success, false);
});

// === translateServerParamsSchema ===

test("translateServerParamsSchema: accepts valid NMT params and normalizes modelType", (t) => {
  const result = translateServerParamsSchema.safeParse({
    modelId: "m1",
    text: "Hello",
    stream: false,
    modelType: "nmt",
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.modelType, ModelType.nmtcppTranslation);
  }
});

test("translateServerParamsSchema: rejects unsupported modelType", (t) => {
  const result = translateServerParamsSchema.safeParse({
    modelId: "m1",
    text: "Hello",
    stream: false,
    modelType: "ocr",
  });
  t.is(result.success, false);
});

// === loadModelOptionsToRequestSchema with NMT ===

test("loadModelOptionsToRequestSchema: accepts NMT load with Bergamot config", (t) => {
  const result = loadModelOptionsToRequestSchema.safeParse({
    modelSrc: "s3:///bergamot/model.enfr.intgemm.alphas.bin",
    modelType: "nmt",
    modelConfig: {
      engine: "Bergamot",
      from: "en",
      to: "fr",
    },
  });
  t.is(result.success, true);
});

test("loadModelOptionsToRequestSchema: accepts NMT load with IndicTrans config", (t) => {
  const result = loadModelOptionsToRequestSchema.safeParse({
    modelSrc: "s3:///indictrans/model.bin",
    modelType: "nmt",
    modelConfig: {
      engine: "IndicTrans",
      from: "eng_Latn",
      to: "hin_Deva",
    },
  });
  t.is(result.success, true);
});
