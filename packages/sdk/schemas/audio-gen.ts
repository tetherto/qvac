import { z } from 'zod'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'

const base64Schema = z.string().min(1)

export const audioGenRuntimeConfigSchema = z
  .object({
    useGPU: z.boolean().optional(),
    inferenceSteps: z.number().int().nonnegative().optional(),
    shift: z.number().nonnegative().optional(),
    nGpuLayers: z.number().int().nonnegative().optional(),
    threads: z.number().int().nonnegative().optional(),
    backendsDir: z.string().min(1).optional()
  })
  .strict()

export const audioGenConfigSchema = audioGenRuntimeConfigSchema
  .extend({
    textEncModelSrc: modelSrcInputSchema,
    lmModelSrc: modelSrcInputSchema,
    ditModelSrc: modelSrcInputSchema,
    vaeModelSrc: modelSrcInputSchema
  })
  .strict()

const audioGenParamsShape = {
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
      'Approximate requested duration in seconds. ACE-Step rounds to its latent frame grid; use output frames or stats.audioDurationMs as authoritative.'
    )
}

export const audioGenClientParamsSchema = z.object(audioGenParamsShape).strict()

export const audioGenStreamRequestSchema = z
  .object({
    ...audioGenParamsShape,
    type: z.literal('audioGenStream'),
    requestId: z.string().min(1).optional()
  })
  .strict()

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
