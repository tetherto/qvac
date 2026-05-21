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

// === Parakeet (NVIDIA NeMo ONNX) engine config ===

export const parakeetModelTypeEnumSchema = z.enum(["tdt", "ctc", "sortformer"]);
export type ParakeetModelVariant = z.infer<typeof parakeetModelTypeEnumSchema>;

export const parakeetRuntimeConfigSchema = z.object({
  modelType: parakeetModelTypeEnumSchema.default("tdt"),
  maxThreads: z.number().int().optional(),
  useGPU: z.boolean().optional(),
  sampleRate: z.number().int().optional(),
  channels: z.number().int().optional(),
  captionEnabled: z.boolean().optional(),
  timestampsEnabled: z.boolean().optional(),

  // Streaming session. When true, opens a long-lived StreamSession
  // (ASR) or SortformerStreamSession (diarization) at model load so
  // cross-chunk state (speaker IDs, EOU window, KV cache) is preserved
  // within a single run() call. Required for v2.1 Sortformer AOSC.
  streaming: z.boolean().optional(),
  streamingChunkMs: z.number().int().positive().optional(),
  /** Sortformer rolling-history window (ms). Ignored by v2.1 AOSC sessions. */
  streamingHistoryMs: z.number().int().positive().optional(),
  streamingEmitPartials: z.boolean().optional(),
  /** CTC/TDT-only energy-VAD events. */
  streamingEnergyVad: z.boolean().optional(),
  /** ASR encoder left-context window (ms). Sortformer ignores this. */
  streamingLeftContextMs: z.number().int().optional(),
  /** ASR encoder right-lookahead window (ms). Sortformer ignores this. */
  streamingRightLookaheadMs: z.number().int().optional(),

  // === AOSC (Audio-Online Speaker Cache; v2.1+ Sortformer only) =========
  // Auto-enabled when the loaded GGUF carries
  // `parakeet.model_variant == "sortformer-streaming-v2.1-aosc"`. Ignored
  // by v1/v2 Sortformer and by non-Sortformer engines.
  /** Disable to force v2.1 onto the v1 sliding-window path (A/B test). Default: true. */
  streamingSpkCacheEnable: z.boolean().optional(),
  /** Long-term speaker-cache rows (~15 s of encoder frames). Default: 188. */
  streamingSpkCacheLen: z.number().int().positive().optional(),
  /** FIFO warmup buffer rows. Default: 188. */
  streamingFifoLen: z.number().int().positive().optional(),
  /** Encoder left-context window (ms; ~1 encoder frame). Default: 80. */
  streamingChunkLeftContextMs: z.number().int().nonnegative().optional(),
  /** Encoder right-context window (ms; ~7 encoder frames). Default: 560. */
  streamingChunkRightContextMs: z.number().int().nonnegative().optional(),
  /** FIFO-overflow pop-out count. Default: 144. */
  streamingSpkCacheUpdatePeriod: z.number().int().positive().optional(),
});

export const parakeetConfigSchema = parakeetRuntimeConfigSchema.extend({
  // TDT sources
  parakeetEncoderSrc: modelSrcInputSchema.optional(),
  parakeetDecoderSrc: modelSrcInputSchema.optional(),
  parakeetVocabSrc: modelSrcInputSchema.optional(),
  parakeetPreprocessorSrc: modelSrcInputSchema.optional(),
  // CTC sources
  parakeetCtcModelSrc: modelSrcInputSchema.optional(),
  parakeetTokenizerSrc: modelSrcInputSchema.optional(),
  // Sortformer source
  parakeetSortformerSrc: modelSrcInputSchema.optional(),
});

export type ParakeetRuntimeConfig = z.infer<typeof parakeetRuntimeConfigSchema>;
export type ParakeetConfig = z.infer<typeof parakeetConfigSchema>;
