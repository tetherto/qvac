// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  parakeetModelTypeEnumSchema,
  parakeetRuntimeConfigSchema,
  parakeetConfigSchema,
} from "@/schemas/transcription-config";

test("parakeetModelTypeEnumSchema: accepts tdt, ctc, sortformer", (t) => {
  t.is(parakeetModelTypeEnumSchema.parse("tdt"), "tdt");
  t.is(parakeetModelTypeEnumSchema.parse("ctc"), "ctc");
  t.is(parakeetModelTypeEnumSchema.parse("sortformer"), "sortformer");
});

test("parakeetModelTypeEnumSchema: rejects invalid variants", (t) => {
  t.exception(() => parakeetModelTypeEnumSchema.parse("invalid"));
  t.exception(() => parakeetModelTypeEnumSchema.parse(""));
  t.exception(() => parakeetModelTypeEnumSchema.parse("TDT"));
});

test("parakeetRuntimeConfigSchema: defaults modelType to tdt", (t) => {
  const result = parakeetRuntimeConfigSchema.parse({});
  t.is(result.modelType, "tdt");
});

test("parakeetConfigSchema: TDT config", (t) => {
  const result = parakeetConfigSchema.parse({
    modelType: "tdt",
    parakeetEncoderSrc: "pear://abc/encoder.onnx",
    parakeetDecoderSrc: "pear://abc/decoder.onnx",
    parakeetVocabSrc: "pear://abc/vocab.txt",
    parakeetPreprocessorSrc: "pear://abc/preprocessor.onnx",
  });
  t.is(result.modelType, "tdt");
});

test("parakeetConfigSchema: CTC config", (t) => {
  const result = parakeetConfigSchema.parse({
    modelType: "ctc",
    parakeetCtcModelSrc: "pear://abc/model.onnx",
    parakeetTokenizerSrc: "pear://abc/tokenizer.json",
  });
  t.is(result.modelType, "ctc");
});

test("parakeetConfigSchema: Sortformer config", (t) => {
  const result = parakeetConfigSchema.parse({
    modelType: "sortformer",
    parakeetSortformerSrc: "pear://abc/sortformer.onnx",
  });
  t.is(result.modelType, "sortformer");
});
