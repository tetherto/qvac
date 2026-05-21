// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  resolveCanonicalEngine,
  getAddonFromEngine,
  ENGINE_TO_ADDON,
} from "@/schemas/engine-addon-map";
import { ModelType } from "@/schemas/model-types";

// Canonical engines pass through unchanged.
test("resolveCanonicalEngine: canonical engines pass through", (t) => {
  t.is(resolveCanonicalEngine("ggml-tts"), ModelType.ggmlTts);
  t.is(
    resolveCanonicalEngine("llamacpp-completion"),
    ModelType.llamacppCompletion,
  );
  t.is(
    resolveCanonicalEngine("whispercpp-transcription"),
    ModelType.whispercppTranscription,
  );
  t.is(
    resolveCanonicalEngine("nmtcpp-translation"),
    ModelType.nmtcppTranslation,
  );
  t.is(resolveCanonicalEngine("onnx-ocr"), ModelType.onnxOcr);
  t.is(
    resolveCanonicalEngine("parakeet-transcription"),
    ModelType.parakeetTranscription,
  );
  t.is(resolveCanonicalEngine("sdcpp-generation"), ModelType.sdcppGeneration);
});

// Legacy `@qvac/*` package names map onto their canonical engine.
test("resolveCanonicalEngine: legacy @qvac/tts-onnx maps to ggml-tts", (t) => {
  t.is(resolveCanonicalEngine("@qvac/tts-onnx"), ModelType.ggmlTts);
});

test("resolveCanonicalEngine: legacy @qvac/tts maps to ggml-tts", (t) => {
  t.is(resolveCanonicalEngine("@qvac/tts"), ModelType.ggmlTts);
});

test("resolveCanonicalEngine: new @qvac/tts-ggml addon also resolves to ggml-tts", (t) => {
  t.is(resolveCanonicalEngine("@qvac/tts-ggml"), ModelType.ggmlTts);
});

// Tag-style aliases (used by older registry entries) keep working.
test("resolveCanonicalEngine: 'tts' tag alias maps to ggml-tts", (t) => {
  t.is(resolveCanonicalEngine("tts"), ModelType.ggmlTts);
});

test("resolveCanonicalEngine: tag aliases for other engines still resolve", (t) => {
  t.is(resolveCanonicalEngine("generation"), ModelType.llamacppCompletion);
  t.is(
    resolveCanonicalEngine("transcription"),
    ModelType.whispercppTranscription,
  );
  t.is(resolveCanonicalEngine("embedding"), ModelType.llamacppEmbedding);
  t.is(resolveCanonicalEngine("translation"), ModelType.nmtcppTranslation);
  t.is(resolveCanonicalEngine("vad"), "onnx-vad");
  t.is(resolveCanonicalEngine("ocr"), ModelType.onnxOcr);
  t.is(resolveCanonicalEngine("diffusion"), ModelType.sdcppGeneration);
});

// `"onnx-tts"` is recognised at the registry-schema level so dead ONNX TTS
// entries (registry rows whose `registryPath` is still an `.onnx` file) stay
// schema-valid, but it is intentionally NOT aliased to `ggml-tts` in
// `LEGACY_ENGINE_TO_CANONICAL`. The new addon cannot load the old ONNX files,
// so a constant whose `engine` is `"onnx-tts"` flows back through
// `inferModelTypeFromModelSrc` as `"onnx-tts"` (not as `"ggml-tts"` via the
// `addon: "tts"` fallback), which then fails at `loadModel`'s modelType
// schema validation — explicit, actionable, no silent C++ parse failure.
test("resolveCanonicalEngine: legacy 'onnx-tts' canonical literal is recognised, not remapped", (t) => {
  t.is(
    resolveCanonicalEngine("onnx-tts"),
    "onnx-tts",
    "onnx-tts must round-trip as itself so dead ONNX TTS entries fail loud at modelType validation instead of silently routing to ggml-tts",
  );
});

test("getAddonFromEngine: 'onnx-tts' maps to the 'tts' addon bucket for getModelInfo reporting", (t) => {
  // Even though no plugin is registered for `onnx-tts`, the engine still
  // belongs to the TTS addon family so model-info responses surface the
  // correct addon classification.
  t.is(getAddonFromEngine("onnx-tts"), "tts");
});

test("resolveCanonicalEngine: unknown engines return null", (t) => {
  t.is(resolveCanonicalEngine("piper"), null);
  t.is(resolveCanonicalEngine(""), null);
  t.is(resolveCanonicalEngine("not-a-real-engine"), null);
});

test("getAddonFromEngine: ggml-tts maps to the 'tts' addon bucket", (t) => {
  t.is(getAddonFromEngine(ModelType.ggmlTts), "tts");
});

test("ENGINE_TO_ADDON: every canonical engine has an addon mapping", (t) => {
  t.is(ENGINE_TO_ADDON[ModelType.llamacppCompletion], "llm");
  t.is(ENGINE_TO_ADDON[ModelType.whispercppTranscription], "whisper");
  t.is(ENGINE_TO_ADDON[ModelType.llamacppEmbedding], "embeddings");
  t.is(ENGINE_TO_ADDON[ModelType.nmtcppTranslation], "nmt");
  t.is(ENGINE_TO_ADDON[ModelType.ggmlTts], "tts");
  t.is(ENGINE_TO_ADDON[ModelType.onnxOcr], "ocr");
  t.is(ENGINE_TO_ADDON[ModelType.parakeetTranscription], "parakeet");
  t.is(ENGINE_TO_ADDON[ModelType.sdcppGeneration], "diffusion");
});
