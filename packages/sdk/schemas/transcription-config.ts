import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";

// === Shared ===

export const audioFormatSchema = z.enum(["f32le", "s16le"]);
export type AudioFormat = z.infer<typeof audioFormatSchema>;

// === Whisper (whisper.cpp) engine config ===

const vadParamsSchema = z
  .object({
    threshold: z.number().optional(),
    min_speech_duration_ms: z.number().optional(),
    min_silence_duration_ms: z.number().optional(),
    max_speech_duration_s: z.number().optional(),
    speech_pad_ms: z.number().optional(),
    samples_overlap: z.number().optional(),
  })
  .optional();

const contextParamsSchema = z
  .object({
    model: z.string().optional(),
    use_gpu: z.boolean().optional(),
    flash_attn: z.boolean().optional(),
    gpu_device: z.number().optional(),
  })
  .optional();

const miscConfigSchema = z
  .object({
    caption_enabled: z.boolean().optional(),
  })
  .optional();

export const whisperConfigSchema = z.object({
  strategy: z.enum(["greedy", "beam_search"]).optional(),
  n_threads: z.number().int().optional(),
  n_max_text_ctx: z.number().int().optional(),
  offset_ms: z.number().int().optional(),
  duration_ms: z.number().int().optional(),
  audio_ctx: z.number().int().optional(),
  translate: z.boolean().optional(),
  no_context: z.boolean().optional(),
  no_timestamps: z.boolean().optional(),
  single_segment: z.boolean().optional(),
  print_special: z.boolean().optional(),
  print_progress: z.boolean().optional(),
  print_realtime: z.boolean().optional(),
  print_timestamps: z.boolean().optional(),
  token_timestamps: z.boolean().optional(),
  thold_pt: z.number().optional(),
  thold_ptsum: z.number().optional(),
  max_len: z.number().int().optional(),
  split_on_word: z.boolean().optional(),
  max_tokens: z.number().int().optional(),
  debug_mode: z.boolean().optional(),
  tdrz_enable: z.boolean().optional(),
  suppress_regex: z.string().optional(),
  initial_prompt: z.string().optional(),
  language: z.string().optional(),
  detect_language: z.boolean().optional(),
  suppress_blank: z.boolean().optional(),
  suppress_nst: z.boolean().optional(),
  temperature: z.number().optional(),
  length_penalty: z.number().optional(),
  temperature_inc: z.number().optional(),
  entropy_thold: z.number().optional(),
  logprob_thold: z.number().optional(),
  greedy_best_of: z.number().int().optional(),
  beam_search_beam_size: z.number().int().optional(),
  vad_params: vadParamsSchema,
  audio_format: audioFormatSchema.optional(),
  contextParams: contextParamsSchema,
  miscConfig: miscConfigSchema,
  vadModelSrc: modelSrcInputSchema.optional(),
});

export type WhisperConfig = z.infer<typeof whisperConfigSchema>;

// === Parakeet (NVIDIA NeMo GGML) engine config ===
//
// Backed by the ggml-based qvac-parakeet.cpp engine. A single GGUF
// checkpoint covers every variant (TDT, CTC, EOU, Sortformer); the
// addon auto-detects the model type from `parakeet.model.type` GGUF
// metadata, so callers no longer pass a `modelType` discriminator and
// only ever supply a single `modelSrc` at `loadModel` time.
//
// The `streaming*` knobs below configure the addon at load time. To
// override any of them per `transcribeStream` call, see
// `parakeetStreamingRunConfigSchema` in `./transcription.ts` — the
// per-call schema intentionally drops the `streaming` prefix because
// every field on it is already namespaced under `parakeetStreamingConfig`.

export const parakeetRuntimeConfigSchema = z.object({
  maxThreads: z.number().int().optional(),
  useGPU: z.boolean().optional(),
  sampleRate: z.number().int().optional(),
  channels: z.number().int().optional(),
  captionEnabled: z.boolean().optional(),
  timestampsEnabled: z.boolean().optional(),
  seed: z.number().int().optional(),
  streaming: z.boolean().optional(),
  streamingChunkMs: z.number().int().optional(),
  streamingHistoryMs: z.number().int().optional(),
  streamingEmitPartials: z.boolean().optional(),
  /**
   * CTC/TDT-only energy-based voice-activity hint. Forwarded to
   * parakeet-cpp's `StreamingOptions::enable_energy_vad`. Influences
   * how the engine segments speech (segment cadence, partial vs final
   * emission) but does NOT add new event types to the transcribeStream
   * output. Use the whisper engine if you need standalone VAD
   * `speaking`/`probability` events.
   */
  streamingEnergyVad: z.boolean().optional(),
  streamingLeftContextMs: z.number().int().optional(),
  streamingRightLookaheadMs: z.number().int().optional(),
});

// Parakeet's load-time config currently has no fields beyond the
// runtime knobs (single GGUF model is supplied via the top-level
// `modelSrc` of `loadModel`). The alias is retained so consumers can
// keep importing `ParakeetConfig` / `parakeetConfigSchema`.
export const parakeetConfigSchema = parakeetRuntimeConfigSchema;

export type ParakeetRuntimeConfig = z.infer<typeof parakeetRuntimeConfigSchema>;
export type ParakeetConfig = z.infer<typeof parakeetConfigSchema>;

// === Parakeet legacy ONNX modelConfig fields (deprecated) ===
//
// As of @qvac/transcription-parakeet 0.4.0 the addon ships as a single
// GGUF that auto-detects TDT / CTC / EOU / Sortformer from GGUF
// metadata. The pre-0.4 multi-file ONNX `modelConfig` fields below are
// kept ONLY so callers migrating from earlier SDK versions hit a
// structured `LegacyParakeetModelDeprecatedError` (with a migration
// message) raised from the parakeet plugin's `resolveConfig`, rather
// than a generic Zod `Unrecognized key` error.
//
// This deprecation alias will be removed in the next minor release.
export const LEGACY_PARAKEET_ONNX_MODEL_CONFIG_FIELDS = [
  "parakeetEncoderSrc",
  "parakeetDecoderSrc",
  "parakeetVocabSrc",
  "parakeetPreprocessorSrc",
  "parakeetCtcModelSrc",
  "parakeetTokenizerSrc",
  "parakeetSortformerSrc",
  "parakeetModelSrc",
  "modelType",
] as const;

const legacyParakeetOnnxFieldsShape =
  LEGACY_PARAKEET_ONNX_MODEL_CONFIG_FIELDS.reduce<
    Record<string, z.ZodOptional<z.ZodUnknown>>
  >((acc, name) => {
    acc[name] = z.unknown().optional();
    return acc;
  }, {});

// Strict schema used by `loadModel` and the parakeet plugin's
// `loadConfigSchema`. Permits the deprecated ONNX field names so the
// plugin's `resolveConfig` can raise a structured
// `LegacyParakeetModelDeprecatedError` instead of a generic Zod error;
// other unknown keys are still rejected by `.strict()`.
export const parakeetLoadConfigSchema = parakeetRuntimeConfigSchema
  .extend(legacyParakeetOnnxFieldsShape)
  .strict();
