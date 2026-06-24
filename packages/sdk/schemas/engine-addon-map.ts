import { ModelType } from "./model-types";
import {
  ADDON_BCI,
  ADDON_CLASSIFICATION,
  ADDON_DIFFUSION,
  ADDON_EMBEDDING,
  ADDON_LLM,
  ADDON_NMT,
  ADDON_OCR,
  ADDON_PARAKEET,
  ADDON_TTS,
  ADDON_VLA,
  ADDON_WHISPER,
} from "./plugin";
import {
  modelRegistryEngineSchema,
  type ModelRegistryEngine,
  type ModelRegistryEntryAddon,
} from "./registry";

// Canonical engine → addon mapping (exhaustive). `as const` preserves
// per-key literals so the addon can be derived from the engine at the type level.
export const ENGINE_TO_ADDON = {
  [ModelType.llamacppCompletion]: "llm",
  [ModelType.whispercppTranscription]: "whisper",
  [ModelType.bciWhispercppTranscription]: "bci",
  [ModelType.llamacppEmbedding]: "embeddings",
  [ModelType.nmtcppTranslation]: "nmt",
  [ModelType.onnxTts]: "tts",
  [ModelType.ttsGgml]: "tts",
  [ModelType.ggmlOcr]: "ocr",
  [ModelType.parakeetTranscription]: "parakeet",
  [ModelType.sdcppGeneration]: "diffusion",
  [ModelType.ggmlVla]: "vla",
  [ModelType.ggmlClassification]: "classification",
  "onnx-vad": "vad",
} as const satisfies Record<ModelRegistryEngine, ModelRegistryEntryAddon>;

// Legacy engine names → canonical engine.
// Used for backward compatibility with old registry data that uses @qvac/* package names.
const LEGACY_ENGINE_TO_CANONICAL: Record<string, ModelRegistryEngine> = {
  [ADDON_LLM]: ModelType.llamacppCompletion,
  [ADDON_WHISPER]: ModelType.whispercppTranscription,
  [ADDON_BCI]: ModelType.bciWhispercppTranscription,
  [ADDON_EMBEDDING]: ModelType.llamacppEmbedding,
  [ADDON_NMT]: ModelType.nmtcppTranslation,
  [ADDON_TTS]: ModelType.ttsGgml,
  [ADDON_OCR]: ModelType.ggmlOcr,
  // Pre-GGML package / tag names from the ONNX era — resolve to the GGML engine.
  "@qvac/ocr-onnx": ModelType.ggmlOcr,
  "onnx-ocr": ModelType.ggmlOcr,
  [ADDON_PARAKEET]: ModelType.parakeetTranscription,
  "@qvac/translation-llamacpp": ModelType.nmtcppTranslation,
  "@qvac/vad-silero": "onnx-vad",
  // Legacy package / tag names from the ONNX era — resolve to the GGML engine.
  "@qvac/tts": ModelType.ttsGgml,
  "@qvac/tts-onnx": ModelType.ttsGgml,
  // Tag-style names (used by some older registry entries)
  generation: ModelType.llamacppCompletion,
  transcription: ModelType.whispercppTranscription,
  bci: ModelType.bciWhispercppTranscription,
  embedding: ModelType.llamacppEmbedding,
  translation: ModelType.nmtcppTranslation,
  vad: "onnx-vad",
  tts: ModelType.ttsGgml,
  ocr: ModelType.ggmlOcr,
  [ADDON_DIFFUSION]: ModelType.sdcppGeneration,
  diffusion: ModelType.sdcppGeneration,
  [ADDON_VLA]: ModelType.ggmlVla,
  vla: ModelType.ggmlVla,
  [ADDON_CLASSIFICATION]: ModelType.ggmlClassification,
  classification: ModelType.ggmlClassification,
};

// Resolves any engine string (legacy or canonical) to a validated canonical engine.
// Returns null if the engine is not recognized.
export function resolveCanonicalEngine(
  engine: string,
): ModelRegistryEngine | null {
  const direct = modelRegistryEngineSchema.safeParse(engine);
  if (direct.success) {
    // Registry rows and cached metadata may still say "onnx-tts"; route to GGML.
    if (direct.data === ModelType.onnxTts) return ModelType.ttsGgml;
    return direct.data;
  }

  const canonical = LEGACY_ENGINE_TO_CANONICAL[engine];
  if (canonical) return canonical;

  return null;
}

// Returns the addon type for a validated canonical engine.
export function getAddonFromEngine(
  engine: ModelRegistryEngine,
): ModelRegistryEntryAddon {
  return ENGINE_TO_ADDON[engine];
}
