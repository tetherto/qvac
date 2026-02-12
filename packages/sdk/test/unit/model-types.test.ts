// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  ModelType,
  ModelTypeAliases,
  PUBLIC_MODEL_TYPES,
  modelTypeInputSchema,
  modelTypeSchema,
  normalizeModelType,
  isModelTypeAlias,
} from "@/schemas/model-types";

test("ModelType contains all canonical values", (t) => {
  t.is(ModelType.llamacppCompletion, "llamacpp-completion");
  t.is(ModelType.whispercppTranscription, "whispercpp-transcription");
  t.is(ModelType.llamacppEmbedding, "llamacpp-embedding");
  t.is(ModelType.nmtcppTranslation, "nmtcpp-translation");
  t.is(ModelType.onnxTts, "onnx-tts");
  t.is(ModelType.onnxOcr, "onnx-ocr");
});

test("ModelTypeAliases maps to correct canonical values", (t) => {
  t.is(ModelTypeAliases.llm, ModelType.llamacppCompletion);
  t.is(ModelTypeAliases.whisper, ModelType.whispercppTranscription);
  t.is(ModelTypeAliases.embeddings, ModelType.llamacppEmbedding);
  t.is(ModelTypeAliases.nmt, ModelType.nmtcppTranslation);
  t.is(ModelTypeAliases.tts, ModelType.onnxTts);
  t.is(ModelTypeAliases.ocr, ModelType.onnxOcr);
});

test("PUBLIC_MODEL_TYPES contains both canonical and alias keys", (t) => {
  // Canonical keys
  t.is(PUBLIC_MODEL_TYPES.llamacppCompletion, "llamacpp-completion");
  t.is(PUBLIC_MODEL_TYPES.whispercppTranscription, "whispercpp-transcription");
  t.is(PUBLIC_MODEL_TYPES.llamacppEmbedding, "llamacpp-embedding");
  t.is(PUBLIC_MODEL_TYPES.nmtcppTranslation, "nmtcpp-translation");
  t.is(PUBLIC_MODEL_TYPES.onnxTts, "onnx-tts");
  t.is(PUBLIC_MODEL_TYPES.onnxOcr, "onnx-ocr");

  // Alias keys
  t.is(PUBLIC_MODEL_TYPES.llm, "llamacpp-completion");
  t.is(PUBLIC_MODEL_TYPES.whisper, "whispercpp-transcription");
  t.is(PUBLIC_MODEL_TYPES.embeddings, "llamacpp-embedding");
  t.is(PUBLIC_MODEL_TYPES.nmt, "nmtcpp-translation");
  t.is(PUBLIC_MODEL_TYPES.tts, "onnx-tts");
  t.is(PUBLIC_MODEL_TYPES.ocr, "onnx-ocr");
});

test("normalizeModelType converts aliases to canonical", (t) => {
  // Aliases should normalize to canonical
  t.is(normalizeModelType("llm"), "llamacpp-completion");
  t.is(normalizeModelType("whisper"), "whispercpp-transcription");
  t.is(normalizeModelType("embeddings"), "llamacpp-embedding");
  t.is(normalizeModelType("nmt"), "nmtcpp-translation");
  t.is(normalizeModelType("tts"), "onnx-tts");
  t.is(normalizeModelType("ocr"), "onnx-ocr");
});

test("normalizeModelType passes through canonical values unchanged", (t) => {
  t.is(normalizeModelType("llamacpp-completion"), "llamacpp-completion");
  t.is(
    normalizeModelType("whispercpp-transcription"),
    "whispercpp-transcription",
  );
  t.is(normalizeModelType("llamacpp-embedding"), "llamacpp-embedding");
  t.is(normalizeModelType("nmtcpp-translation"), "nmtcpp-translation");
  t.is(normalizeModelType("onnx-tts"), "onnx-tts");
  t.is(normalizeModelType("onnx-ocr"), "onnx-ocr");
});

test("isModelTypeAlias correctly identifies aliases", (t) => {
  // Aliases
  t.is(isModelTypeAlias("llm"), true);
  t.is(isModelTypeAlias("whisper"), true);
  t.is(isModelTypeAlias("embeddings"), true);
  t.is(isModelTypeAlias("nmt"), true);
  t.is(isModelTypeAlias("tts"), true);
  t.is(isModelTypeAlias("ocr"), true);

  // Canonical values are not aliases
  t.is(isModelTypeAlias("llamacpp-completion"), false);
  t.is(isModelTypeAlias("whispercpp-transcription"), false);
  t.is(isModelTypeAlias("llamacpp-embedding"), false);
  t.is(isModelTypeAlias("nmtcpp-translation"), false);
  t.is(isModelTypeAlias("onnx-tts"), false);
  t.is(isModelTypeAlias("onnx-ocr"), false);
});

test("modelTypeInputSchema accepts aliases", (t) => {
  t.is(modelTypeInputSchema.parse("llm"), "llm");
  t.is(modelTypeInputSchema.parse("whisper"), "whisper");
  t.is(modelTypeInputSchema.parse("embeddings"), "embeddings");
  t.is(modelTypeInputSchema.parse("nmt"), "nmt");
  t.is(modelTypeInputSchema.parse("tts"), "tts");
  t.is(modelTypeInputSchema.parse("ocr"), "ocr");
});

test("modelTypeInputSchema accepts canonical values", (t) => {
  t.is(
    modelTypeInputSchema.parse("llamacpp-completion"),
    "llamacpp-completion",
  );
  t.is(
    modelTypeInputSchema.parse("whispercpp-transcription"),
    "whispercpp-transcription",
  );
  t.is(modelTypeInputSchema.parse("llamacpp-embedding"), "llamacpp-embedding");
  t.is(modelTypeInputSchema.parse("nmtcpp-translation"), "nmtcpp-translation");
  t.is(modelTypeInputSchema.parse("onnx-tts"), "onnx-tts");
  t.is(modelTypeInputSchema.parse("onnx-ocr"), "onnx-ocr");
});

test("modelTypeInputSchema rejects invalid values", (t) => {
  t.exception(() => modelTypeInputSchema.parse("invalid"));
  t.exception(() => modelTypeInputSchema.parse(""));
  t.exception(() => modelTypeInputSchema.parse("LLM")); // case sensitive
  t.exception(() => modelTypeInputSchema.parse("completion")); // partial match
});

test("modelTypeSchema transforms aliases to canonical", (t) => {
  t.is(modelTypeSchema.parse("llm"), "llamacpp-completion");
  t.is(modelTypeSchema.parse("whisper"), "whispercpp-transcription");
  t.is(modelTypeSchema.parse("embeddings"), "llamacpp-embedding");
  t.is(modelTypeSchema.parse("nmt"), "nmtcpp-translation");
  t.is(modelTypeSchema.parse("tts"), "onnx-tts");
  t.is(modelTypeSchema.parse("ocr"), "onnx-ocr");
});

test("modelTypeSchema passes through canonical values", (t) => {
  t.is(modelTypeSchema.parse("llamacpp-completion"), "llamacpp-completion");
  t.is(
    modelTypeSchema.parse("whispercpp-transcription"),
    "whispercpp-transcription",
  );
  t.is(modelTypeSchema.parse("llamacpp-embedding"), "llamacpp-embedding");
  t.is(modelTypeSchema.parse("nmtcpp-translation"), "nmtcpp-translation");
  t.is(modelTypeSchema.parse("onnx-tts"), "onnx-tts");
  t.is(modelTypeSchema.parse("onnx-ocr"), "onnx-ocr");
});

test("modelTypeSchema rejects invalid values", (t) => {
  t.exception(() => modelTypeSchema.parse("invalid"));
  t.exception(() => modelTypeSchema.parse(""));
});
