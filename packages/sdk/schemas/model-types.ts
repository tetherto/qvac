import { z } from "zod";

// === INTERNAL: Canonical types (used in SDK code) ===
/**
 * Canonical model type values for internal SDK use.
 * Format: `engine-usecase` (e.g., "llamacpp-completion")
 * Use dot-accessor syntax: `ModelType.llamacppCompletion`
 */
export const ModelType = {
  llamacppCompletion: "llamacpp-completion",
  whispercppTranscription: "whispercpp-transcription",
  bciWhispercppTranscription: "bci-whispercpp-transcription",
  llamacppEmbedding: "llamacpp-embedding",
  nmtcppTranslation: "nmtcpp-translation",
  onnxTts: "onnx-tts",
  ttsGgml: "tts-ggml",
  parakeetTranscription: "parakeet-transcription",
  onnxOcr: "onnx-ocr",
  sdcppGeneration: "sdcpp-generation",
  ggmlVla: "ggml-vla",
  ggmlClassification: "ggml-classification",
} as const;

// === INTERNAL: Alias keys (backward compat names) ===
const AliasKeys = {
  llm: "llm",
  whisper: "whisper",
  bci: "bci",
  embeddings: "embeddings",
  nmt: "nmt",
  parakeet: "parakeet",
  tts: "tts",
  ocr: "ocr",
  diffusion: "diffusion",
  vla: "vla",
  classification: "classification",
} as const;

// === INTERNAL: Aliases (backward compat mapping) ===
/**
 * Alias mappings for backward compatibility.
 * Maps old names to canonical values.
 */
export const ModelTypeAliases = {
  [AliasKeys.llm]: ModelType.llamacppCompletion,
  [AliasKeys.whisper]: ModelType.whispercppTranscription,
  [AliasKeys.bci]: ModelType.bciWhispercppTranscription,
  [AliasKeys.embeddings]: ModelType.llamacppEmbedding,
  [AliasKeys.nmt]: ModelType.nmtcppTranslation,
  [AliasKeys.parakeet]: ModelType.parakeetTranscription,
  [AliasKeys.tts]: ModelType.ttsGgml,
  [AliasKeys.ocr]: ModelType.onnxOcr,
  [AliasKeys.diffusion]: ModelType.sdcppGeneration,
  [AliasKeys.vla]: ModelType.ggmlVla,
  [AliasKeys.classification]: ModelType.ggmlClassification,
} as const;

// === TYPES ===
export type CanonicalModelType = (typeof ModelType)[keyof typeof ModelType];
export type AliasKey = keyof typeof ModelTypeAliases;
export type ModelTypeInput = CanonicalModelType | AliasKey;

// Set of canonical values for quick lookup
const canonicalValuesSet = new Set<string>(Object.values(ModelType));

// === PUBLIC: Combined (exported via index.ts as MODEL_TYPES) ===
/**
 * All valid model types: canonical names + aliases.
 *
 * Canonical names follow `engine-usecase` format (e.g., "llamacpp-completion").
 * Aliases resolve to canonical names for backward compatibility.
 *
 * @example
 * ```typescript
 * // Preferred: canonical name
 * loadModel({ modelSrc: "...", modelType: MODEL_TYPES.nmtcppTranslation });
 *
 * // Deprecated: alias (still resolves to "nmtcpp-translation")
 * loadModel({ modelSrc: "...", modelType: MODEL_TYPES.nmt });
 * ```
 */
export const PUBLIC_MODEL_TYPES = {
  ...ModelType,
  ...ModelTypeAliases,
} as const;

// === ZOD SCHEMAS ===
// Derive input values from objects - no string repetition
const inputValues = [
  ...Object.values(ModelType),
  ...(Object.keys(ModelTypeAliases) as AliasKey[]),
] as [ModelTypeInput, ...ModelTypeInput[]];

/** Schema accepting both canonical and alias model type inputs */
export const modelTypeInputSchema = z.enum(inputValues);

/** Schema that transforms input to canonical model type */
export const modelTypeSchema = modelTypeInputSchema.transform(
  (val): CanonicalModelType => {
    // If already canonical, return as-is
    if (canonicalValuesSet.has(val)) {
      return val as CanonicalModelType;
    }
    // Otherwise, look up in aliases
    return ModelTypeAliases[val as AliasKey];
  },
);

/**
 * Normalize model type input to canonical form.
 * Custom plugin types (not in built-ins) are returned as-is.
 */
export function normalizeModelType(input: string): string {
  // If already canonical, return as-is
  if (canonicalValuesSet.has(input)) {
    return input;
  }
  // If it's an alias, normalize to canonical
  if (input in ModelTypeAliases) {
    return ModelTypeAliases[input as AliasKey];
  }
  // Custom plugin type - return as-is
  return input;
}

/**
 * Type guard to check if a string is a canonical (built-in) model type.
 * Returns false for custom plugin types.
 */
export function isCanonicalModelType(
  input: string,
): input is CanonicalModelType {
  return canonicalValuesSet.has(input);
}

/**
 * Check if input is a built-in alias (not canonical or custom).
 * Returns false for custom plugin types.
 */
export function isModelTypeAlias(input: string): boolean {
  return input in ModelTypeAliases;
}

// === PER-MODEL-TYPE SCHEMAS (for discriminated unions) ===
// Extracted from root enum - no value duplication

/**
 * LLM/Completion model type schema.
 * - Alias: `"llm"` → resolves to `"llamacpp-completion"`
 * - Canonical: `"llamacpp-completion"`
 */
export const llmModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.llm, ModelType.llamacppCompletion])
  .describe(
    'LLM model type: "llm" (alias) or "llamacpp-completion" (canonical)',
  );
export type LlmModelTypeInput = z.infer<typeof llmModelTypeSchema>;

/**
 * Whisper/Transcription model type schema.
 * - Alias: `"whisper"` → resolves to `"whispercpp-transcription"`
 * - Canonical: `"whispercpp-transcription"`
 */
export const whisperModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.whisper, ModelType.whispercppTranscription])
  .describe(
    'Whisper model type: "whisper" (alias) or "whispercpp-transcription" (canonical)',
  );
export type WhisperModelTypeInput = z.infer<typeof whisperModelTypeSchema>;

/**
 * BCI/Transcription model type schema.
 * - Alias: `"bci"` → resolves to `"bci-whispercpp-transcription"`
 * - Canonical: `"bci-whispercpp-transcription"`
 */
export const bciModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.bci, ModelType.bciWhispercppTranscription])
  .describe(
    'BCI model type: "bci" (alias) or "bci-whispercpp-transcription" (canonical)',
  );
export type BciModelTypeInput = z.infer<typeof bciModelTypeSchema>;

/**
 * Parakeet/Transcription model type schema.
 * - Alias: `"parakeet"` → resolves to `"parakeet-transcription"`
 * - Canonical: `"parakeet-transcription"`
 */
export const parakeetModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.parakeet, ModelType.parakeetTranscription])
  .describe(
    'Parakeet model type: "parakeet" (alias) or "parakeet-transcription" (canonical)',
  );
export type ParakeetModelTypeInput = z.infer<typeof parakeetModelTypeSchema>;

/**
 * Embeddings model type schema.
 * - Alias: `"embeddings"` → resolves to `"llamacpp-embedding"`
 * - Canonical: `"llamacpp-embedding"`
 */
export const embeddingsModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.embeddings, ModelType.llamacppEmbedding])
  .describe(
    'Embeddings model type: "embeddings" (alias) or "llamacpp-embedding" (canonical)',
  );
export type EmbeddingsModelTypeInput = z.infer<
  typeof embeddingsModelTypeSchema
>;

/**
 * NMT/Translation model type schema.
 * - Alias: `"nmt"` → resolves to `"nmtcpp-translation"`
 * - Canonical: `"nmtcpp-translation"`
 */
export const nmtModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.nmt, ModelType.nmtcppTranslation])
  .describe(
    'NMT model type: "nmt" (alias) or "nmtcpp-translation" (canonical)',
  );
export type NmtModelTypeInput = z.infer<typeof nmtModelTypeSchema>;

/**
 * TTS model type schema.
 * - Alias: `"tts"` → resolves to `"tts-ggml"`
 * - Canonical: `"tts-ggml"`
 */
export const ttsModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.tts, ModelType.ttsGgml])
  .describe('TTS model type: "tts" (alias) or "tts-ggml" (canonical)');
export type TtsModelTypeInput = z.infer<typeof ttsModelTypeSchema>;

/**
 * OCR model type schema.
 * - Alias: `"ocr"` → resolves to `"onnx-ocr"`
 * - Canonical: `"onnx-ocr"`
 */
export const ocrModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.ocr, ModelType.onnxOcr])
  .describe('OCR model type: "ocr" (alias) or "onnx-ocr" (canonical)');
export type OcrModelTypeInput = z.infer<typeof ocrModelTypeSchema>;

/**
 * Diffusion/Image Generation model type schema.
 * - Alias: `"diffusion"` → resolves to `"sdcpp-generation"`
 * - Canonical: `"sdcpp-generation"`
 */
export const diffusionModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.diffusion, ModelType.sdcppGeneration])
  .describe(
    'Diffusion model type: "diffusion" (alias) or "sdcpp-generation" (canonical)',
  );
export type DiffusionModelTypeInput = z.infer<
  typeof diffusionModelTypeSchema
>;

/**
 * VLA (vision-language-action) model type schema.
 * - Alias: `"vla"` → resolves to `"ggml-vla"`
 * - Canonical: `"ggml-vla"`
 */
export const vlaModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.vla, ModelType.ggmlVla])
  .describe('VLA model type: "vla" (alias) or "ggml-vla" (canonical)');
export type VlaModelTypeInput = z.infer<typeof vlaModelTypeSchema>;

/**
 * Image Classification model type schema.
 * - Alias: `"classification"` → resolves to `"ggml-classification"`
 * - Canonical: `"ggml-classification"`
 */
export const classificationModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.classification, ModelType.ggmlClassification])
  .describe(
    'Classification model type: "classification" (alias) or "ggml-classification" (canonical)',
  );
export type ClassificationModelTypeInput = z.infer<
  typeof classificationModelTypeSchema
>;
