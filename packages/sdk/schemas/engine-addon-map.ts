import { ModelType } from "./model-types";
import {
  ADDON_DIFFUSION,
  ADDON_EMBEDDING,
  ADDON_LLM,
  ADDON_NMT,
  ADDON_OCR,
  ADDON_PARAKEET,
  ADDON_TTS,
  ADDON_WHISPER,
} from "./plugin";
import {
  modelRegistryEngineSchema,
  type ModelRegistryEngine,
  type ModelRegistryEntryAddon,
} from "./registry";

// Canonical engine → addon mapping (exhaustive). `as const` preserves
// per-key literals so the addon can be derived from the engine at the type level.
//
// `"onnx-tts"` is the prior-canonical literal for TTS. It maps to the `tts`
// addon bucket for `getModelInfo` reporting, but it is intentionally NOT
// reachable through `LEGACY_ENGINE_TO_CANONICAL` and `inferModelTypeFromModelSrc`
// short-circuits before falling through to the `addon` field — the new GGML
// plugin can't load ONNX files, so consumers picking constants stamped with
// this engine get an explicit error instead of a silent native failure.
export const ENGINE_TO_ADDON = {
  [ModelType.llamacppCompletion]: "llm",
  [ModelType.whispercppTranscription]: "whisper",
  [ModelType.llamacppEmbedding]: "embeddings",
  [ModelType.nmtcppTranslation]: "nmt",
  [ModelType.ggmlTts]: "tts",
  [ModelType.onnxOcr]: "ocr",
  [ModelType.parakeetTranscription]: "parakeet",
  [ModelType.sdcppGeneration]: "diffusion",
  "onnx-vad": "vad",
  "onnx-tts": "tts",
} as const satisfies Record<ModelRegistryEngine, ModelRegistryEntryAddon>;

// Legacy engine names → canonical engine.
// Used for backward compatibility with old registry data that uses @qvac/* package names.
const LEGACY_ENGINE_TO_CANONICAL: Record<string, ModelRegistryEngine> = {
  [ADDON_LLM]: ModelType.llamacppCompletion,
  [ADDON_WHISPER]: ModelType.whispercppTranscription,
  [ADDON_EMBEDDING]: ModelType.llamacppEmbedding,
  [ADDON_NMT]: ModelType.nmtcppTranslation,
  [ADDON_TTS]: ModelType.ggmlTts,
  [ADDON_OCR]: ModelType.onnxOcr,
  [ADDON_PARAKEET]: ModelType.parakeetTranscription,
  "@qvac/translation-llamacpp": ModelType.nmtcppTranslation,
  "@qvac/vad-silero": "onnx-vad",
  "@qvac/tts": ModelType.ggmlTts,
  "@qvac/tts-onnx": ModelType.ggmlTts,
  // Note: the prior canonical literal `"onnx-tts"` is intentionally NOT
  // aliased here. Routing it to ggml-tts would be misleading because the
  // new addon cannot load the old ONNX TTS files; persisted configs that
  // still carry that engine string should fail loud at registry lookup so
  // callers migrate to ggml-tts (or one of the package-name aliases) and
  // pick GGUF model sources.
  // Tag-style names (used by some older registry entries)
  generation: ModelType.llamacppCompletion,
  transcription: ModelType.whispercppTranscription,
  embedding: ModelType.llamacppEmbedding,
  translation: ModelType.nmtcppTranslation,
  vad: "onnx-vad",
  tts: ModelType.ggmlTts,
  ocr: ModelType.onnxOcr,
  [ADDON_DIFFUSION]: ModelType.sdcppGeneration,
  diffusion: ModelType.sdcppGeneration,
};

// Resolves any engine string (legacy or canonical) to a validated canonical engine.
// Returns null if the engine is not recognized.
export function resolveCanonicalEngine(
  engine: string,
): ModelRegistryEngine | null {
  const direct = modelRegistryEngineSchema.safeParse(engine);
  if (direct.success) return direct.data;

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
