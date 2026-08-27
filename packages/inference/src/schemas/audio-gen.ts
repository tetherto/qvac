import { z } from 'zod'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'
import { audioInputSchema, type AudioInput } from '@/schemas/transcription'
import { encodeBase64 } from '@/utils/encoding'

const base64Schema = z.string().min(1)
const MINIMAX_MAX_INFERENCE_STEPS = 1000
const FLOAT32_MAX = 3.4028234663852886e38
const FLOAT32_MIN_POSITIVE = 1.401298464324817e-45

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
 * ACE-Step task discriminators reachable through the SDK. `text2music` is the
 * default caption-driven generation; `cover-nofsq` re-renders `sourceAudio`
 * with a new caption while keeping its structure. The engine also reserves an
 * FSQ-roundtrip `cover` task that is not implemented yet, so it is not offered
 * here.
 */
export const AUDIOGEN_TASK_TYPES = ['text2music', 'cover-nofsq'] as const
export const audioGenTaskTypeSchema = z.enum(AUDIOGEN_TASK_TYPES)

const commonAudioGenRuntimeConfigShape = {
  useGPU: z.boolean().optional(),
  threads: z.number().int().nonnegative().optional(),
  backendsDir: z.string().min(1).optional()
}

const acestepRuntimeConfigShape = {
  ...commonAudioGenRuntimeConfigShape,
  inferenceSteps: z.number().int().nonnegative().optional(),
  shift: z.number().nonnegative().optional(),
  nGpuLayers: z.number().int().nonnegative().optional()
}

const minimaxCfgScaleSchema = z
  .number()
  .min(0)
  .max(FLOAT32_MAX)
  .refine((value) => value === 0 || value >= FLOAT32_MIN_POSITIVE, {
    message: 'cfgScale must be 0 or a positive float32 value'
  })

const minimaxRuntimeConfigShape = {
  ...commonAudioGenRuntimeConfigShape,
  inferenceSteps: z.number().int().min(0).max(MINIMAX_MAX_INFERENCE_STEPS).optional(),
  cfgScale: minimaxCfgScaleSchema.optional()
}

export const audioGenRuntimeConfigSchema = z
  .object({
    engine: audioGenEngineSchema.optional(),
    ...acestepRuntimeConfigShape,
    cfgScale: minimaxCfgScaleSchema.optional()
  })
  .strict()

const acestepAudioGenConfigSchema = z
  .object({
    engine: z.literal('acestep').optional(),
    ...acestepRuntimeConfigShape,
    textEncModelSrc: modelSrcInputSchema,
    lmModelSrc: modelSrcInputSchema,
    ditModelSrc: modelSrcInputSchema,
    vaeModelSrc: modelSrcInputSchema
  })
  .strict()

const minimaxAudioGenConfigSchema = z
  .object({
    engine: z.literal('minimax'),
    ...minimaxRuntimeConfigShape,
    lmModelSrc: modelSrcInputSchema,
    synthModelSrc: modelSrcInputSchema
  })
  .strict()

export const audioGenConfigSchema = z.union([
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

const audioGenGenerationShape = {
  modelId: z.string().min(1),
  caption: z.string().trim().min(1, 'caption must not be empty or whitespace-only'),
  lyrics: z.string().optional(),
  seed: z.number().int().optional(),
  vocalLanguage: z.string().min(1).optional(),
  bpm: z.number().int().positive().optional(),
  keyscale: z.string().min(1).optional(),
  timesignature: z.string().min(1).optional(),
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
    .describe('MiniMax semantic-frame cap. Cannot be combined with duration.'),
  inferenceSteps: z
    .number()
    .int()
    .min(0)
    .max(MINIMAX_MAX_INFERENCE_STEPS)
    .optional()
    .describe('MiniMax flow steps for this generation; 0 uses the model default.'),
  cfgScale: minimaxCfgScaleSchema
    .optional()
    .describe('MiniMax flow classifier-free guidance scale for this generation.'),
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
      message: 'MiniMax accepts either maxFrames or duration, not both'
    })
  }
}

export const audioGenClientParamsSchema = z
  .object({
    ...audioGenGenerationShape,
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

export const audioGenProgressSchema = z.object({
  stage: z.string(),
  step: z.number().int().nonnegative(),
  total: z.number().int().nonnegative()
})

export const audioGenStatsSchema = z.object({
  audioDurationMs: z.number().optional(),
  totalTimeMs: z.number().optional(),
  realTimeFactor: z.number().optional(),
  backendDevice: z.number().optional(),
  backendId: z.number().optional()
})

export const audioGenStreamResponseSchema = z
  .object({
    type: z.literal('audioGenStream'),
    progress: audioGenProgressSchema.optional(),
    data: base64Schema.optional(),
    sampleRate: z.number().int().positive().optional(),
    channels: z.number().int().positive().optional(),
    bitsPerSample: z.number().int().positive().optional(),
    done: z.boolean().default(false),
    stopReason: z.enum(['completed', 'cancelled']).optional(),
    stats: audioGenStatsSchema.optional()
  })
  .strict()

export type AudioGenTaskType = z.infer<typeof audioGenTaskTypeSchema>
export type AudioGenEngine = z.infer<typeof audioGenEngineSchema>
export type AudioGenAudioInput = z.infer<typeof audioGenAudioInputSchema>
export type AudioGenRuntimeConfig = z.infer<typeof audioGenRuntimeConfigSchema>
export type AudioGenConfig = z.infer<typeof audioGenConfigSchema>
export type AudioGenClientParams = z.input<typeof audioGenClientParamsSchema>
export type AudioGenStreamRequest = z.infer<typeof audioGenStreamRequestSchema>
export type AudioGenProgress = z.infer<typeof audioGenProgressSchema>
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
}
