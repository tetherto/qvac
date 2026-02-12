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
  llamacppEmbedding: "llamacpp-embedding",
  nmtcppTranslation: "nmtcpp-translation",
  onnxTts: "onnx-tts",
  onnxOcr: "onnx-ocr",
} as const;

// === INTERNAL: Alias keys (backward compat names) ===
const AliasKeys = {
  llm: "llm",
  whisper: "whisper",
  embeddings: "embeddings",
  nmt: "nmt",
  tts: "tts",
  ocr: "ocr",
} as const;

// === INTERNAL: Aliases (backward compat mapping) ===
/**
 * Alias mappings for backward compatibility.
 * Maps old names to canonical values.
 */
export const ModelTypeAliases = {
  [AliasKeys.llm]: ModelType.llamacppCompletion,
  [AliasKeys.whisper]: ModelType.whispercppTranscription,
  [AliasKeys.embeddings]: ModelType.llamacppEmbedding,
  [AliasKeys.nmt]: ModelType.nmtcppTranslation,
  [AliasKeys.tts]: ModelType.onnxTts,
  [AliasKeys.ocr]: ModelType.onnxOcr,
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
 * // Using alias (backward compatible)
 * loadModel({ modelSrc: "...", modelType: MODEL_TYPES.nmt });
 * // MODEL_TYPES.nmt resolves to "nmtcpp-translation"
 *
 * // Using canonical name directly
 * loadModel({ modelSrc: "...", modelType: MODEL_TYPES.nmtcppTranslation });
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

/** Normalize model type input to canonical form */
export function normalizeModelType(input: ModelTypeInput): CanonicalModelType {
  // If already canonical, return as-is
  if (canonicalValuesSet.has(input)) {
    return input as CanonicalModelType;
  }
  // Otherwise, look up in aliases
  return ModelTypeAliases[input as AliasKey];
}

/** Check if input is an alias (not canonical) */
export function isModelTypeAlias(input: ModelTypeInput): boolean {
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
 * - Alias: `"tts"` → resolves to `"onnx-tts"`
 * - Canonical: `"onnx-tts"`
 */
export const ttsModelTypeSchema = modelTypeInputSchema
  .extract([AliasKeys.tts, ModelType.onnxTts])
  .describe('TTS model type: "tts" (alias) or "onnx-tts" (canonical)');
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
