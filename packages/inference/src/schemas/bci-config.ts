import { z } from 'zod'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'

// === BCI (whisper.cpp) engine config ===
//
// The camelCase form of `BCIWhispercppConfig` from `@qvac/bci-whispercpp`. Unlike the
// flat `whisperConfigSchema`, the BCI addon nests its inference knobs
// under `whisperConfig` and exposes a separate `bciConfig` for
// session-level (neural-signal) parameters.

// Reduced whisper inference field set exposed by the BCI addon (see the
// `WhisperConfig` interface in `@qvac/bci-whispercpp`).
const bciWhisperConfigSchema = z
  .object({
    language: z.string().optional().describe('Transcription language (ISO 639-1). Default `en`.'),
    threads: z.number().int().optional().describe('Number of CPU threads. `0` = auto.'),
    temperature: z.number().optional().describe('Sampling temperature. Default 0.0.'),
    suppressNst: z.boolean().optional().describe('Suppress non-speech tokens (NST).'),
    suppressBlank: z
      .boolean()
      .optional()
      .describe('Suppress the blank / leading-space token at the start of sampling.'),
    durationMs: z
      .number()
      .int()
      .optional()
      .describe('Maximum duration of audio to transcribe, in milliseconds.'),
    translate: z.boolean().optional().describe('Translate the transcribed audio into English.'),
    noTimestamps: z.boolean().optional().describe('Omit timestamps from the transcription output.'),
    singleSegment: z
      .boolean()
      .optional()
      .describe('Force the whole audio into one output segment (for streaming or short clips).'),
    printSpecial: z.boolean().optional().describe('Print special tokens in the output.'),
    printProgress: z.boolean().optional().describe('Print progress updates during transcription.'),
    printRealtime: z
      .boolean()
      .optional()
      .describe(
        'whisper.cpp prints results to stderr as it decodes; diagnostic only (prefer the segment callback).'
      ),
    printTimestamps: z
      .boolean()
      .optional()
      .describe('Prefix each `printRealtime` line with `[t0 --> t1]`; no effect on returned data.'),
    detectLanguage: z
      .boolean()
      .optional()
      .describe(
        "Detect the spoken language and stop: whisper.cpp returns straight after detection, so the transcript comes back empty. Use `language: 'auto'` to detect and transcribe in one call."
      ),
    greedyBestOf: z
      .number()
      .int()
      .optional()
      .describe('Greedy decoding: number of candidate completions; `-1` = default.'),
    beamSize: z
      .number()
      .int()
      .optional()
      .describe('Beam size for beam-search decoding; `-1` = default.')
  })
  .optional()

const bciSessionConfigSchema = z
  .object({
    dayIdx: z
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
    useGpu: z
      .boolean()
      .optional()
      .describe('Enable GPU acceleration. Enabled by default; set false to force CPU.'),
    flashAttention: z.boolean().optional().describe('Enable flash attention.'),
    gpuDevice: z.number().optional().describe('GPU device index to use.')
  })
  .optional()

const bciMiscConfigSchema = z
  .object({
    captionEnabled: z
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
      'Android and Linux: the directory scanned, as given, for the ggml backend modules. Defaults to the directory next to the loaded addon module.'
    ),
  embedderModelSrc: modelSrcInputSchema
    .optional()
    .describe('BCI embedder model source (neural-signal embedder weights).')
})

export type BciConfig = z.infer<typeof bciConfigSchema>
