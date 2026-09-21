import { z } from 'zod'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'

// === BCI (whisper.cpp) engine config ===
//
// Mirrors `BCIWhispercppConfig` from `@qvac/bci-whispercpp`. Unlike the
// flat `whisperConfigSchema`, the BCI addon nests its inference knobs
// under `whisperConfig` and exposes a separate `bciConfig` for
// session-level (neural-signal) parameters.

// Reduced whisper inference field set exposed by the BCI addon (see the
// `WhisperConfig` interface in `@qvac/bci-whispercpp`).
const bciWhisperConfigSchema = z
  .object({
    language: z.string().optional().describe('Transcription language (ISO 639-1). Default `en`.'),
    n_threads: z.number().int().optional().describe('Number of CPU threads. `0` = auto.'),
    temperature: z.number().optional().describe('Sampling temperature. Default 0.0.'),
    suppress_nst: z.boolean().optional().describe('Suppress non-speech tokens (NST).'),
    suppress_blank: z
      .boolean()
      .optional()
      .describe('Suppress the blank / leading-space token at the start of sampling.'),
    duration_ms: z
      .number()
      .int()
      .optional()
      .describe('Maximum duration of audio to transcribe, in milliseconds.'),
    translate: z.boolean().optional().describe('Translate the transcribed audio into English.'),
    no_timestamps: z
      .boolean()
      .optional()
      .describe('Omit timestamps from the transcription output.'),
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
      .describe(
        'Prefix each `print_realtime` line with `[t0 --> t1]`; no effect on returned data.'
      ),
    detect_language: z
      .boolean()
      .optional()
      .describe(
        "Not supported natively (rejected by the addon); use `language: 'auto'` to auto-detect the spoken language."
      ),
    greedy_best_of: z
      .number()
      .int()
      .optional()
      .describe('Greedy decoding: number of candidate completions; `-1` = default.'),
    beam_search_beam_size: z
      .number()
      .int()
      .optional()
      .describe('Beam size for beam-search decoding; `-1` = default.')
  })
  .optional()

const bciSessionConfigSchema = z
  .object({
    day_idx: z
      .number()
      .int()
      .optional()
      .describe(
        'Session day index selecting day-specific projection matrices; `-1` enables mel passthrough (parity testing only).'
      )
  })
  .optional()

const bciContextParamsSchema = z
  .object({
    model: z
      .string()
      .optional()
      .describe('Optional whisper model path override (usually set via the loaded model files).'),
    use_gpu: z
      .boolean()
      .optional()
      .describe('Enable GPU acceleration. Enabled by default; set false to force CPU.'),
    flash_attn: z.boolean().optional().describe('Enable flash attention.'),
    gpu_device: z.number().optional().describe('GPU device index to use.')
  })
  .optional()

const bciMiscConfigSchema = z
  .object({
    caption_enabled: z
      .boolean()
      .optional()
      .describe('Format output segments with caption markers. Default false.')
  })
  .optional()

export const bciConfigSchema = z.object({
  whisperConfig: bciWhisperConfigSchema,
  bciConfig: bciSessionConfigSchema,
  contextParams: bciContextParamsSchema,
  miscConfig: bciMiscConfigSchema,
  backendsDir: z
    .string()
    .optional()
    .describe(
      'Android only: override the default ggml backend prebuilds directory. Defaults to `<addon>/prebuilds`.'
    ),
  embedderModelSrc: modelSrcInputSchema
    .optional()
    .describe('BCI embedder model source (neural-signal embedder weights).')
})

export type BciConfig = z.infer<typeof bciConfigSchema>
