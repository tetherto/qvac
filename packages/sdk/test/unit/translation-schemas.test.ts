import test from "brittle";
import {
  nmtConfigBaseSchema,
  nmtConfigSchema,
} from "@/schemas/translation-config";
import {
  translateRequestSchema,
  translateServerParamsSchema,
} from "@/schemas/translate";
import { ModelType } from "@/schemas";

// === nmtConfigSchema defaults transform ===

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

// === nmtConfigBaseSchema discriminated union ===

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

// === NMT-specific translate schema behavior ===

test("translateRequestSchema: accepts NMT batch (array text)", (t) => {
  const result = translateRequestSchema.safeParse({
    type: "translate",
    modelId: "model-123",
    text: ["Hello", "World"],
    stream: true,
    modelType: "nmt",
  });
  t.is(result.success, true);
});

test("translateServerParamsSchema: normalizes 'nmt' to canonical modelType", (t) => {
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
