import { z } from 'zod'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'
import { audioInputSchema, type AudioInput } from '@/schemas/transcription'
import {
  inferenceBackendDiagnosticsSchema,
  type InferenceBackendDiagnostics
} from '@/schemas/system-resources'
import { encodeBase64 } from '@/utils/encoding'

const base64Schema = z.string().min(1)
// Mirrors requireMinimaxInferenceSteps and requireMinimaxCfgScale in @qvac/audiogen-ggml.
const MINIMAX_MAX_INFERENCE_STEPS = 1000
const MINIMAX_CFG_SCALE_MAX = 3.4028234663852886e38
const MINIMAX_CFG_SCALE_MIN_POSITIVE = 1.401298464324817e-45

export const AUDIOGEN_ENGINES = ['acestep', 'minimax'] as const
export const audioGenEngineSchema = z.enum(AUDIOGEN_ENGINES)

/** Sample rate the ACE-Step engine expects for reference and source audio. */
export const AUDIOGEN_INPUT_SAMPLE_RATE = 48000
/** Channel count (interleaved stereo) the ACE-Step engine expects for input audio. */
export const AUDIOGEN_INPUT_CHANNELS = 2
/**
 * Longest reference/source clip the SDK accepts (10 minutes). Bounds the PCM
 * the server materializes per input — a 48 kHz stereo Float32 clip weighs
 * 384 KB per second — so a request cannot exhaust the inference process.
 */
export const AUDIOGEN_INPUT_MAX_SECONDS = 600
/**
 * Semantic codes the ACE-Step LM emits per second of audio (the 5 Hz LM), so
 * an `audioCodes` payload is bounded the same way PCM inputs are: a request
 * cannot carry more codes than `AUDIOGEN_INPUT_MAX_SECONDS` of audio needs.
 */
const ACESTEP_CODES_PER_SECOND = 5
/** Longest `audioCodes` array the SDK accepts (600 s at 5 codes per second). */
export const AUDIOGEN_MAX_AUDIO_CODES = AUDIOGEN_INPUT_MAX_SECONDS * ACESTEP_CODES_PER_SECOND
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

/**
 * Operations `audioEdit()` chains over a source recording, in the vocabulary
 * of `@qvac/audiogen-ggml`'s `AudioEditOperationType` (ACE-Step only):
 * `flow-edit` re-conditions the whole clip from a source prompt to a target
 * prompt, `repaint` regenerates a time range against a new prompt.
 */
export const AUDIOGEN_EDIT_OPERATIONS = ['flow-edit', 'repaint'] as const
export const audioGenEditOperationTypeSchema = z.enum(AUDIOGEN_EDIT_OPERATIONS)

/** Repaint preservation modes; `balanced` is the default and honours `strength`. */
export const AUDIOGEN_REPAINT_MODES = ['conservative', 'balanced', 'aggressive'] as const
export const audioGenRepaintModeSchema = z.enum(AUDIOGEN_REPAINT_MODES)

/**
 * ACE-Step task discriminators reachable through the SDK. `text2music` is the
 * default caption-driven generation; `cover-nofsq` re-renders `sourceAudio`
 * with a new caption while keeping its structure. The engine also reserves an
 * FSQ-roundtrip `cover` task that is not implemented yet, so it is not offered
 * here.
 */
export const AUDIOGEN_TASK_TYPES = ['text2music', 'cover-nofsq'] as const
export const audioGenTaskTypeSchema = z.enum(AUDIOGEN_TASK_TYPES)

const commonAudioGenRuntimeConfigShape = {
  useGPU: z
    .boolean()
    .optional()
    .describe(
      'Run on a GPU backend (CUDA, Vulkan, Metal, …) when usable; falls back to CPU. `stats.backendDevice` reports the backend actually used.'
    ),
  threads: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('CPU thread count; `0` (default) lets the engine auto-pick.'),
  backendsDir: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Advanced: override the prebuilds root scanned for dlopen’d ggml backend modules. Defaults to `<addon>/prebuilds`; needed on arm64, where the CPU backend ships as per-microarch module `.so` files.'
    )
}

const acestepRuntimeConfigShape = {
  ...commonAudioGenRuntimeConfigShape,
  inferenceSteps: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'DiT sampling steps; `0` (default) lets ACE-Step auto-pick per DiT architecture (turbo 8 / sft 50).'
    ),
  shift: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      'Flow-matching time-shift; `0` (default) lets ACE-Step auto-pick per DiT architecture (turbo 3.0 / sft 1.0).'
    ),
  nGpuLayers: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('ACE-Step GPU layers to offload when `useGPU` is set (99 = all). Ignored on CPU.')
}

const minimaxCfgScaleSchema = z
  .number()
  .min(0)
  .max(MINIMAX_CFG_SCALE_MAX)
  .refine((value) => value === 0 || value >= MINIMAX_CFG_SCALE_MIN_POSITIVE, {
    message: 'cfgScale must be 0 or a positive float32 value'
  })
  .describe('MiniMax flow classifier-free guidance scale; `0` uses the model default.')

const minimaxRuntimeConfigShape = {
  ...commonAudioGenRuntimeConfigShape,
  inferenceSteps: z
    .number()
    .int()
    .min(0)
    .max(MINIMAX_MAX_INFERENCE_STEPS)
    .optional()
    .describe('MiniMax flow sampling steps; `0` uses the model default.'),
  cfgScale: minimaxCfgScaleSchema.optional()
}

const acestepAudioGenRuntimeConfigSchema = z
  .object({
    engine: z.literal('acestep').optional().describe('Use the ACE-Step music-generation engine.'),
    ...acestepRuntimeConfigShape
  })
  .strict()

const minimaxAudioGenRuntimeConfigSchema = z
  .object({
    engine: z.literal('minimax').describe('Use the MiniMax-Music3 generation engine.'),
    ...minimaxRuntimeConfigShape
  })
  .strict()

export const audioGenRuntimeConfigSchema = z.discriminatedUnion('engine', [
  acestepAudioGenRuntimeConfigSchema,
  minimaxAudioGenRuntimeConfigSchema
])

const acestepAudioGenConfigSchema = acestepAudioGenRuntimeConfigSchema
  .extend({
    textEncModelSrc: modelSrcInputSchema.describe(
      'Text-encoder model source; turns the caption and lyrics into embeddings.'
    ),
    lmModelSrc: modelSrcInputSchema.describe('Language-model source; plans the song structure.'),
    ditModelSrc: modelSrcInputSchema.describe(
      'DiT model source; generates the audio latent (the quality-defining stage).'
    ),
    vaeModelSrc: modelSrcInputSchema.describe(
      'VAE model source; decodes the latent into the output waveform.'
    )
  })
  .strict()

const minimaxAudioGenConfigSchema = minimaxAudioGenRuntimeConfigSchema
  .extend({
    lmModelSrc: modelSrcInputSchema.describe(
      'MiniMax language-model source; generates semantic music tokens.'
    ),
    synthModelSrc: modelSrcInputSchema.describe(
      'MiniMax synthesis-model source; converts semantic tokens into the output waveform.'
    )
  })
  .strict()

export const audioGenConfigSchema = z.discriminatedUnion('engine', [
  acestepAudioGenConfigSchema,
  minimaxAudioGenConfigSchema
])

const unitIntervalSchema = z.number().min(0).max(1)

/**
 * Wire form of a reference/source audio input. `filePath` inputs are decoded
 * server-side (any format the SDK's audio decoder supports, plus raw PCM);
 * `base64` inputs must already be interleaved stereo 48 kHz Float32 LE PCM.
 */
export const audioGenAudioInputSchema = audioInputSchema

/**
 * Client form of a reference/source audio input: a file path, or raw
 * interleaved stereo 48 kHz Float32 LE PCM bytes. Normalized to the wire form.
 */
export const audioGenClientAudioInputSchema = z
  .union([z.string().min(1), z.instanceof(Uint8Array)])
  .transform((value): AudioInput => {
    if (typeof value === 'string') return { type: 'filePath', value }
    return { type: 'base64', value: bytesToBase64(value) }
  })

function bytesToBase64(bytes: Uint8Array) {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) {
    return bytes.toString('base64')
  }
  return encodeBase64(bytes)
}

/**
 * Wire form of frozen ACE-Step semantic codes: a plain int32 array, so it
 * survives JSON transport and reaches non-JS clients as a list of integers.
 */
const audioCodesWireSchema = z
  .array(z.number().int().min(INT32_MIN).max(INT32_MAX))
  .min(1)
  .max(AUDIOGEN_MAX_AUDIO_CODES)
  .describe(
    'Frozen ACE-Step semantic codes (int32) to synthesize instead of running the LM, e.g. codes recovered from an earlier run. ACE-Step only; rejected by MiniMax.'
  )

/**
 * Client form of `audioCodes`: the `Int32Array` the addon works with, or a
 * plain number array. Normalized to the wire form.
 */
export const audioGenClientAudioCodesSchema = z
  .union([
    z.instanceof(Int32Array).transform((codes): number[] => Array.from(codes)),
    z.array(z.number())
  ])
  .pipe(audioCodesWireSchema)

const audioGenGenerationShape = {
  modelId: z.string().min(1),
  caption: z.string().trim().min(1, 'caption must not be empty or whitespace-only'),
  lyrics: z.string().optional(),
  seed: z.number().int().optional(),
  vocalLanguage: z.string().min(1).optional(),
  bpm: z.number().int().positive().optional(),
  keyscale: z.string().min(1).optional(),
  timesignature: z.string().min(1).optional(),
  augmentCaptionWithMetadata: z
    .boolean()
    .optional()
    .describe(
      'Append BPM/tempo, time signature, and key guidance to the internal conditioning caption while the result metadata keeps the original caption (default: false). ACE-Step only; rejected by MiniMax.'
    ),
  duration: z
    .number()
    .positive()
    .optional()
    .describe(
      'Approximate requested duration in seconds. Engines round to their frame grid; use output frames or stats.audioDurationMs as authoritative.'
    ),
  maxFrames: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      'MiniMax semantic-frame cap. Cannot be combined with duration. MiniMax only; rejected by ACE-Step.'
    ),
  inferenceSteps: z
    .number()
    .int()
    .min(0)
    .max(MINIMAX_MAX_INFERENCE_STEPS)
    .optional()
    .describe(
      'MiniMax flow steps for this generation; 0 uses the model default. MiniMax only; rejected by ACE-Step.'
    ),
  cfgScale: minimaxCfgScaleSchema
    .optional()
    .describe(
      'MiniMax flow classifier-free guidance scale for this generation. MiniMax only; rejected by ACE-Step.'
    ),
  lmTemperature: z
    .number()
    .nonnegative()
    .optional()
    .describe('LM sampling temperature (ACE-Step default: 0.85).'),
  lmTopP: unitIntervalSchema
    .optional()
    .describe('LM nucleus-sampling probability (ACE-Step default: 0.9).'),
  lmTopK: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('LM top-k cutoff; 0 disables top-k filtering.'),
  lmCfgScale: z
    .number()
    .nonnegative()
    .optional()
    .describe('Classifier-free guidance scale used by the LM.'),
  lmPhase1: z
    .boolean()
    .optional()
    .describe('Allow the LM to infer missing metadata before semantic-code generation.'),
  dcwEnabled: z
    .boolean()
    .optional()
    .describe(
      'Apply the official ACE-Step Haar DCW correction during DiT sampling (default: true).'
    ),
  dcwScaler: z
    .number()
    .nonnegative()
    .optional()
    .describe('DCW low-frequency correction strength (official default: 0.05).'),
  dcwHighScaler: z
    .number()
    .nonnegative()
    .optional()
    .describe('DCW high-frequency correction strength (official default: 0.02).'),
  taskType: audioGenTaskTypeSchema
    .optional()
    .describe('Generation task: text2music (default) or cover-nofsq (requires sourceAudio).'),
  audioCoverStrength: unitIntervalSchema
    .optional()
    .describe(
      'Fraction of DiT steps that keep the source context (0..1, default 1). cover-nofsq currently requires 1.'
    ),
  coverNoiseStrength: unitIntervalSchema
    .optional()
    .describe(
      'Blend of the initial DiT noise toward the clean source latent (0..1). 0 = pure noise, 1 ≈ source latent. Default 0.'
    )
}

const audioGenParamsShape = {
  ...audioGenGenerationShape,
  audioCodes: audioCodesWireSchema.optional(),
  referenceAudio: audioGenAudioInputSchema
    .optional()
    .describe('Optional timbre reference audio; omit to keep the engine default.'),
  sourceAudio: audioGenAudioInputSchema
    .optional()
    .describe('Source audio to re-render; required for cover tasks.')
}

/**
 * Cross-field rules for cover tasks: `sourceAudio` is mandatory, and the engine
 * currently only implements full source context, so an explicit
 * `audioCoverStrength` must be `1` until context switching lands upstream.
 */
function validateCoverTask(
  value: {
    taskType?: string | undefined
    sourceAudio?: unknown
    audioCoverStrength?: number | undefined
  },
  ctx: z.RefinementCtx
) {
  if (value.taskType !== 'cover-nofsq') return
  if (value.sourceAudio === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourceAudio'],
      message: "taskType 'cover-nofsq' requires sourceAudio"
    })
  }
  if (value.audioCoverStrength !== undefined && value.audioCoverStrength !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['audioCoverStrength'],
      message: "taskType 'cover-nofsq' currently requires audioCoverStrength 1"
    })
  }
}

function validateAudioGenRequest(
  value: {
    duration?: number | undefined
    maxFrames?: number | undefined
    taskType?: string | undefined
    sourceAudio?: unknown
    audioCoverStrength?: number | undefined
  },
  ctx: z.RefinementCtx
) {
  validateCoverTask(value, ctx)
  if (value.duration !== undefined && value.maxFrames !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxFrames'],
      message: 'duration and maxFrames cannot be combined'
    })
  }
}

export const audioGenClientParamsSchema = z
  .object({
    ...audioGenGenerationShape,
    audioCodes: audioGenClientAudioCodesSchema.optional(),
    referenceAudio: audioGenClientAudioInputSchema.optional(),
    sourceAudio: audioGenClientAudioInputSchema.optional()
  })
  .strict()
  .superRefine(validateAudioGenRequest)

export const audioGenStreamRequestSchema = z
  .object({
    ...audioGenParamsShape,
    type: z.literal('audioGenStream'),
    requestId: z.string().min(1).optional()
  })
  .strict()
  .superRefine(validateAudioGenRequest)

// ---------------------------------------------------------------------------
// Source-driven editing (`audioEdit()`): the addon's ordered Flow-Edit /
// Repaint pipeline over one source recording. ACE-Step only.
// ---------------------------------------------------------------------------

const audioEditPromptSchema = z
  .object({
    caption: z.string().trim().min(1, 'caption must not be empty or whitespace-only'),
    lyrics: z.string().optional().describe('Lyrics for this prompt; omit for `[Instrumental]`.')
  })
  .strict()

export const audioEditFlowEditOperationSchema = z
  .object({
    type: z.literal('flow-edit'),
    from: audioEditPromptSchema.describe('Description of the unedited source audio.'),
    to: audioEditPromptSchema.describe('Description of the desired audio.'),
    nMin: unitIntervalSchema
      .optional()
      .describe('Start of the Flow-Edit diffusion window (0..1, default 0).'),
    nMax: unitIntervalSchema
      .optional()
      .describe('End of the Flow-Edit diffusion window (0..1, default 1).'),
    nAvg: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Forward-noise samples averaged per active step (default 1).')
  })
  .strict()

export const audioEditRepaintOperationSchema = z
  .object({
    type: z.literal('repaint'),
    caption: z.string().trim().min(1, 'caption must not be empty or whitespace-only'),
    lyrics: z
      .string()
      .optional()
      .describe('Lyrics for the repainted region; omit for `[Instrumental]`.'),
    start: z
      .number()
      .nonnegative()
      .describe('Region start in seconds; must lie inside the source recording.'),
    end: z
      .number()
      .positive()
      .optional()
      .describe(
        'Region end in seconds; omit to repaint through the end of the source. The range must span at least one latent frame (1/25 s).'
      ),
    mode: audioGenRepaintModeSchema
      .optional()
      .describe('Preservation mode outside the repainted region (default balanced).'),
    strength: unitIntervalSchema
      .optional()
      .describe('Balanced-mode preservation strength (0..1, default 0.5).')
  })
  .strict()

export const audioEditOperationSchema = z.discriminatedUnion('type', [
  audioEditFlowEditOperationSchema,
  audioEditRepaintOperationSchema
])

const audioEditShape = {
  modelId: z.string().min(1),
  operations: z
    .array(audioEditOperationSchema)
    .min(1)
    .describe(
      'Ordered edit pipeline: operations run in array order and may repeat or mix. Flow-Edit is supported on turbo DiT variants only.'
    ),
  seed: z
    .number()
    .int()
    .optional()
    .describe('Seeds the first operation; each following operation uses seed + its index.')
}

/**
 * Cross-field rules the addon enforces per operation, checked up front so a
 * bad pipeline fails before any audio is decoded or the model slot is taken.
 */
function validateAudioEditOperations(
  value: { operations: Array<z.output<typeof audioEditOperationSchema>> },
  ctx: z.RefinementCtx
) {
  value.operations.forEach((operation, index) => {
    if (operation.type === 'flow-edit') {
      if ((operation.nMin ?? 0) > (operation.nMax ?? 1)) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index, 'nMin'],
          message: 'flow-edit requires nMin <= nMax'
        })
      }
      return
    }
    if (operation.end !== undefined && operation.end <= operation.start) {
      ctx.addIssue({
        code: 'custom',
        path: ['operations', index, 'end'],
        message: 'repaint requires end > start'
      })
    }
  })
}

export const audioEditClientParamsSchema = z
  .object({
    ...audioEditShape,
    sourceAudio: audioGenClientAudioInputSchema
  })
  .strict()
  .superRefine(validateAudioEditOperations)

export const audioEditStreamRequestSchema = z
  .object({
    ...audioEditShape,
    sourceAudio: audioGenAudioInputSchema.describe(
      'Recording to edit: a file path decoded server-side, or raw interleaved stereo 48 kHz Float32 LE PCM in [-1, 1].'
    ),
    type: z.literal('audioEditStream'),
    requestId: z.string().min(1).optional()
  })
  .strict()
  .superRefine(validateAudioEditOperations)

export type AudioGenProgress = {
  stage: string
  step: number
  /**
   * Total number of steps when greater than zero. Values less than or equal to zero mean
   * indeterminate progress and must not be rendered as a `step / total` determinate progress value.
   */
  total: number
}

export const audioGenProgressSchema = z.object({
  stage: z.string(),
  step: z.number().int().nonnegative(),
  total: z
    .number()
    .int()
    .describe(
      'Total number of steps when greater than zero. Values less than or equal to zero mean indeterminate progress and must not be rendered as a step / total determinate progress value.'
    )
}) satisfies z.ZodType<AudioGenProgress>

export const audioGenStatsSchema = z.object({
  audioDurationMs: z.number().optional(),
  totalTimeMs: z.number().optional(),
  realTimeFactor: z.number().optional(),
  backendDevice: z.number().optional(),
  backendId: z.number().optional()
})

// Generation and editing stream the same frames — progress ticks, PCM chunks,
// one terminal frame — and differ only in the wire `type` that routes them.
const audioGenStreamFrameShape = {
  progress: audioGenProgressSchema.optional(),
  data: base64Schema.optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  bitsPerSample: z.number().int().positive().optional(),
  done: z.boolean().default(false),
  stopReason: z.enum(['completed', 'cancelled']).optional(),
  stats: audioGenStatsSchema.optional(),
  diagnostics: inferenceBackendDiagnosticsSchema
    .optional()
    .describe(
      'Backend selection detail for the completed run. Carries the same payload the engine attaches to the internal diagnostics symbol, so an RPC client can read it.'
    )
}

export const audioGenStreamResponseSchema = z
  .object({
    type: z.literal('audioGenStream'),
    ...audioGenStreamFrameShape
  })
  .strict()

export const audioEditStreamResponseSchema = z
  .object({
    type: z.literal('audioEditStream'),
    ...audioGenStreamFrameShape
  })
  .strict()

export type AudioGenTaskType = z.infer<typeof audioGenTaskTypeSchema>
export type AudioGenEditOperationType = z.infer<typeof audioGenEditOperationTypeSchema>
export type AudioGenRepaintMode = z.infer<typeof audioGenRepaintModeSchema>
export type AudioEditPrompt = z.infer<typeof audioEditPromptSchema>
export type AudioEditFlowEditOperation = z.infer<typeof audioEditFlowEditOperationSchema>
export type AudioEditRepaintOperation = z.infer<typeof audioEditRepaintOperationSchema>
export type AudioEditOperation = z.infer<typeof audioEditOperationSchema>
export type AudioEditClientParams = z.input<typeof audioEditClientParamsSchema>
export type AudioEditStreamRequest = z.infer<typeof audioEditStreamRequestSchema>
export type AudioEditStreamResponse = z.infer<typeof audioEditStreamResponseSchema>
export type AudioGenEngine = z.infer<typeof audioGenEngineSchema>
export type AudioGenAudioInput = z.infer<typeof audioGenAudioInputSchema>
export type AcestepAudioGenRuntimeConfig = z.infer<typeof acestepAudioGenRuntimeConfigSchema>
export type MinimaxAudioGenRuntimeConfig = z.infer<typeof minimaxAudioGenRuntimeConfigSchema>
export type AudioGenRuntimeConfig = z.infer<typeof audioGenRuntimeConfigSchema>
export type AcestepAudioGenConfig = z.infer<typeof acestepAudioGenConfigSchema>
export type MinimaxAudioGenConfig = z.infer<typeof minimaxAudioGenConfigSchema>
export type AudioGenConfig = z.infer<typeof audioGenConfigSchema>
export type AudioGenClientParams = z.input<typeof audioGenClientParamsSchema>
export type AudioGenStreamRequest = z.infer<typeof audioGenStreamRequestSchema>
export type AudioGenStats = z.infer<typeof audioGenStatsSchema>
export type AudioGenStreamResponse = z.infer<typeof audioGenStreamResponseSchema>

export interface AudioGenAudio {
  pcm: Uint8Array
  sampleRate: number
  channels: number
  bitsPerSample: number
}

export interface AudioGenResult {
  requestId: string
  progressStream: AsyncGenerator<AudioGenProgress>
  audio: Promise<AudioGenAudio>
  stats: Promise<AudioGenStats | undefined>
  diagnostics: Promise<InferenceBackendDiagnostics | undefined>
}
