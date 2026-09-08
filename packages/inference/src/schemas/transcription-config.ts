import { z } from 'zod'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'

// === Shared ===

export const audioFormatSchema = z.enum(['f32le', 's16le'])
export type AudioFormat = z.infer<typeof audioFormatSchema>

// === Whisper (whisper.cpp) engine config ===

const vadParamsSchema = z
  .object({
    threshold: z
      .number()
      .optional()
      .describe('VAD probability threshold for classifying a segment as speech.'),
    min_speech_duration_ms: z
      .number()
      .optional()
      .describe('Minimum duration for a segment to count as speech (ms).'),
    min_silence_duration_ms: z
      .number()
      .optional()
      .describe('Minimum silence duration required to split speech segments (ms).'),
    max_speech_duration_s: z
      .number()
      .optional()
      .describe('Maximum duration of a single speech segment (s).'),
    speech_pad_ms: z
      .number()
      .optional()
      .describe('Padding added before and after each speech segment (ms).'),
    samples_overlap: z
      .number()
      .optional()
      .describe(
        'Overlap between consecutive speech segments (0 < x ≤ 1); an explicit `0` falls back to the engine default.'
      )
  })
  .optional()

const contextParamsSchema = z
  .object({
    model: z.string().optional().describe('Path to the whisper model file (context override).'),
    use_gpu: z.boolean().optional().describe('Enable GPU acceleration. Default false.'),
    flash_attn: z.boolean().optional().describe('Enable flash attention.'),
    gpu_device: z.number().optional().describe('GPU device index to use.')
  })
  .optional()

const miscConfigSchema = z
  .object({
    caption_enabled: z.boolean().optional().describe('Format output segments as captions.')
  })
  .optional()

export const whisperConfigSchema = z.object({
  strategy: z
    .enum(['greedy', 'beam_search'])
    .optional()
    .describe("Decoding strategy: `'greedy'` or `'beam_search'`."),
  n_threads: z
    .number()
    .int()
    .optional()
    .describe('CPU threads for transcription; `0` = auto (half of hardware cores).'),
  n_max_text_ctx: z
    .number()
    .int()
    .optional()
    .describe('Maximum text tokens from previous segments used as context.'),
  offset_ms: z
    .number()
    .int()
    .optional()
    .describe('Milliseconds to skip at the start of the audio.'),
  duration_ms: z
    .number()
    .int()
    .optional()
    .describe('Maximum duration of audio to transcribe, in milliseconds.'),
  audio_ctx: z
    .number()
    .int()
    .optional()
    .describe('Audio context window size in samples; `0` = model default.'),
  translate: z.boolean().optional().describe('Translate the transcribed audio into English.'),
  no_context: z
    .boolean()
    .optional()
    .describe(
      "Do not carry past transcription forward as the decoder's initial prompt; each window is decoded independently."
    ),
  no_timestamps: z.boolean().optional().describe('Omit timestamps from the transcription output.'),
  single_segment: z
    .boolean()
    .optional()
    .describe('Force the whole audio into one output segment (for streaming or short clips).'),
  print_special: z.boolean().optional().describe('Print special tokens in the output.'),
  print_progress: z.boolean().optional().describe('Print progress updates during transcription.'),
  print_realtime: z
    .boolean()
    .optional()
    .describe(
      'whisper.cpp prints results to stderr as it decodes; diagnostic only (prefer the segment callback).'
    ),
  print_timestamps: z
    .boolean()
    .optional()
    .describe('Prefix each `print_realtime` line with `[t0 --> t1]`; no effect on returned data.'),
  token_timestamps: z
    .boolean()
    .optional()
    .describe('Experimental: compute per-token timestamps (populates `t0`/`t1`).'),
  thold_pt: z
    .number()
    .optional()
    .describe('Word-timestamp probability threshold for accepting a word (0–1).'),
  thold_ptsum: z
    .number()
    .optional()
    .describe(
      'Timestamp-token sum-probability threshold used when deriving token-level timestamps (0–1).'
    ),
  max_len: z.number().int().optional().describe('Maximum tokens per transcription segment.'),
  split_on_word: z
    .boolean()
    .optional()
    .describe('When `max_len > 0`, split segments on word boundaries instead of mid-token.'),
  max_tokens: z.number().int().optional().describe('Maximum tokens per segment; `0` = no limit.'),
  debug_mode: z
    .boolean()
    .optional()
    .describe('Experimental: emit extra debug output (e.g. the computed log-mel).'),
  tdrz_enable: z
    .boolean()
    .optional()
    .describe('Enable tinydiarize (lightweight speaker-turn detection).'),
  suppress_regex: z
    .string()
    .optional()
    .describe('Regular-expression pattern for tokens to suppress.'),
  initial_prompt: z
    .string()
    .optional()
    .describe('Initial prompt (context) prepended to the transcription.'),
  language: z
    .string()
    .optional()
    .describe("Transcription language (ISO 639-1) or `'auto'` to detect."),
  detect_language: z
    .boolean()
    .optional()
    .describe(
      "Not supported natively (rejected by the addon); use `language: 'auto'` to auto-detect the spoken language."
    ),
  suppress_blank: z
    .boolean()
    .optional()
    .describe('Suppress the blank / leading-space token at the start of sampling.'),
  suppress_nst: z.boolean().optional().describe('Suppress non-speech tokens (NST).'),
  temperature: z.number().optional().describe('Sampling temperature (0–1). Default 0.0.'),
  length_penalty: z
    .number()
    .optional()
    .describe(
      "Beam-search length penalty. Must be ≥ 0, so the upstream `-1` 'disabled' sentinel cannot be set via config."
    ),
  temperature_inc: z
    .number()
    .optional()
    .describe('Temperature increment applied when sampling fails.'),
  entropy_thold: z.number().optional().describe('Entropy threshold for filtering uncertain words.'),
  logprob_thold: z
    .number()
    .optional()
    .describe('Log-probability threshold for filtering words; `-1` disables.'),
  greedy_best_of: z
    .number()
    .int()
    .optional()
    .describe('Greedy decoding: number of candidate completions; `-1` = default.'),
  beam_search_beam_size: z
    .number()
    .int()
    .optional()
    .describe('Beam size for beam-search decoding; `-1` = default.'),
  vad_params: vadParamsSchema,
  audio_format: audioFormatSchema
    .optional()
    .describe("Interpretation of raw audio bytes: `'f32le'` or `'s16le'`."),
  contextParams: contextParamsSchema,
  miscConfig: miscConfigSchema,
  vadModelSrc: modelSrcInputSchema
    .optional()
    .describe('Voice-activity-detection (VAD) model source; enables VAD when set.')
})

export type WhisperConfig = z.infer<typeof whisperConfigSchema>

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
  maxThreads: z
    .number()
    .int()
    .optional()
    .describe('CPU threads; `0` defers to hardware concurrency. Default 4.'),
  useGPU: z.boolean().optional().describe('Enable the ggml GPU backend. Default false.'),
  sampleRate: z.number().int().optional().describe('Input audio sample rate in Hz. Default 16000.'),
  channels: z.number().int().optional().describe('Input audio channel count. Default 1 (mono).'),
  captionEnabled: z
    .boolean()
    .optional()
    .describe('Format output segments as captions. Default false.'),
  timestampsEnabled: z.boolean().optional().describe('Emit per-segment timestamps. Default true.'),
  seed: z
    .number()
    .int()
    .optional()
    .describe('Sampling RNG seed; `-1` picks a random seed. Default -1.'),
  streaming: z.boolean().optional().describe('Open a long-lived streaming session. Default false.'),
  streamingChunkMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Streaming chunk cadence in ms. Default 2000.'),
  streamingHistoryMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Sortformer rolling-history window in ms. Default 30000.'),
  streamingEmitPartials: z
    .boolean()
    .optional()
    .describe('Emit partial results before chunk boundaries. Default true.'),
  streamingEnergyVad: z
    .boolean()
    .optional()
    .describe(
      'CTC/TDT-only energy-based voice-activity hint; affects speech segmentation but adds no new event types. For standalone VAD `speaking`/`probability` events, use the whisper engine. Default false.'
    ),
  streamingLeftContextMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('ASR encoder left-context window in ms; omit to keep the model default (10000).'),
  streamingRightLookaheadMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('ASR encoder right-lookahead window in ms; omit to keep the model default (2000).'),
  language: z
    .string()
    .optional()
    .describe(
      'Multilingual CTC language id (e.g. `hi`, `ta`); required for Indic Conformer GGUFs, ignored on monolingual CTC.'
    ),

  // === AOSC (Audio-Online Speaker Cache; v2.1+ Sortformer only) =========
  // Auto-enabled when the loaded GGUF carries
  // `parakeet.model_variant == "sortformer-streaming-v2.1-aosc"`. Ignored
  // by v1/v2 Sortformer and by non-Sortformer engines.
  streamingSpkCacheEnable: z
    .boolean()
    .optional()
    .describe('AOSC (Sortformer v2.1): enable speaker-cache streaming. Default true.'),
  streamingSpkCacheLen: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('AOSC: long-term speaker-cache rows (~15 s). Default 188.'),
  streamingFifoLen: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('AOSC: FIFO warmup buffer rows. Default 188.'),
  streamingChunkLeftContextMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('AOSC: encoder left-context window in ms. Default 80.'),
  streamingChunkRightContextMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('AOSC: encoder right-context window in ms. Default 560.'),
  streamingSpkCacheUpdatePeriod: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('AOSC: FIFO-overflow pop-out count. Default 144.'),
  backendsDir: z
    .string()
    .optional()
    .describe(
      'Root directory for dynamically-loaded ggml backend `.so` files. Defaults to `prebuilds/`.'
    ),
  openclCacheDir: z
    .string()
    .optional()
    .describe("Persistent directory for ggml-opencl's compiled-program cache (Android only).")
})

// Parakeet's load-time config currently has no fields beyond the
// runtime knobs (single GGUF model is supplied via the top-level
// `modelSrc` of `loadModel`). The alias is retained so consumers can
// keep importing `ParakeetConfig` / `parakeetConfigSchema`.
export const parakeetConfigSchema = parakeetRuntimeConfigSchema

export type ParakeetRuntimeConfig = z.infer<typeof parakeetRuntimeConfigSchema>
export type ParakeetConfig = z.infer<typeof parakeetConfigSchema>

// === Parakeet legacy ONNX modelConfig fields (deprecated) ===
//
// As of @qvac/transcription-parakeet 0.6.0 the addon ships as a single
// GGUF that auto-detects TDT / CTC / EOU / Sortformer from GGUF
// metadata. The pre-0.4 multi-file ONNX `modelConfig` fields below are
// kept ONLY so callers migrating from earlier @qvac/sdk versions hit a
// structured `LegacyParakeetModelDeprecatedError` (with a migration
// message) raised from the parakeet plugin's `resolveConfig`, rather
// than a generic Zod `Unrecognized key` error.
export const LEGACY_PARAKEET_ONNX_MODEL_CONFIG_FIELDS = [
  'parakeetEncoderSrc',
  'parakeetDecoderSrc',
  'parakeetVocabSrc',
  'parakeetPreprocessorSrc',
  'parakeetCtcModelSrc',
  'parakeetTokenizerSrc',
  'parakeetSortformerSrc',
  'parakeetModelSrc',
  'modelType'
] as const

const legacyParakeetOnnxFieldsShape = LEGACY_PARAKEET_ONNX_MODEL_CONFIG_FIELDS.reduce<
  Record<string, z.ZodOptional<z.ZodUnknown>>
>((acc, name) => {
  acc[name] = z.unknown().optional()
  return acc
}, {})

// Strict schema used by `loadModel` and the parakeet plugin's
// `loadConfigSchema`. Permits the deprecated ONNX field names so the
// plugin's `resolveConfig` can raise a structured
// `LegacyParakeetModelDeprecatedError` instead of a generic Zod error;
// other unknown keys are still rejected by `.strict()`.
export const parakeetLoadConfigSchema = parakeetRuntimeConfigSchema
  .extend(legacyParakeetOnnxFieldsShape)
  .strict()
