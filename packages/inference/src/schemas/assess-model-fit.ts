import { z } from 'zod'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'
import { modelTypeInputSchema } from '@/schemas/model-types'
import { transcribeParamsSchema } from '@/schemas/transcription'
import { sessionScopedRequestSchema } from '@/schemas/request-base'

export const transcriptionFitWorkloadSchema = transcribeParamsSchema
  .pick({ prompt: true, hotwords: true, maxNewTokens: true })
  .extend({ audioSeconds: z.number().positive().describe('Longest whole recording to project.') })
  .strict()
  .refine((value) => value.prompt === undefined || !value.hotwords?.length, {
    message: 'MOSS prompt cannot be combined with hotwords'
  })

export type TranscriptionFitWorkload = z.infer<typeof transcriptionFitWorkloadSchema>

/**
 * `unknown` is the answer for a load that would start but cannot be sized: the
 * engine has no fitter, cannot project this load, has no registry description
 * of a model that is not on disk, or a device reported no free memory.
 */
export const modelFitVerdictSchema = z.enum(['fits', 'does-not-fit', 'unknown'])

/** Fit-only workload used to estimate MOSS text-to-speech memory requirements. */
export const ttsFitWorkloadSchema = z.union([
  z
    .strictObject({
      promptRows: z
        .number()
        .int()
        .positive()
        .max(2147483647)
        .describe('Complete native prompt rows, including dialogue and references.'),
      referenceSamples: z
        .number()
        .int()
        .nonnegative()
        .max(2147483647)
        .describe('Total mono reference audio samples.'),
      streaming: z.boolean().describe('Whether the MOSS workload uses native streaming.')
    })
    .meta({ title: 'MossTtsFitWorkload' }),
  z
    .strictObject({
      prompt: z.string().min(1).describe('Sound-effect description.'),
      seconds: z.number().positive().max(30).describe('Sound-effect duration in seconds, up to 30.')
    })
    .meta({ title: 'MossSoundEffectFitWorkload' })
])

export type TtsFitWorkload = z.infer<typeof ttsFitWorkloadSchema>

/**
 * A load to assess, in `loadModel`'s own parameters. The engine's plugin
 * resolves it, so the config and the artifact keys the fitter reads are the
 * ones the load would run with.
 *
 * Each source resolves to the registry's weightless description of the
 * artifact, or to the file itself where it is already on disk.
 */
export const modelFitCandidateSchema = z.object({
  transcriptionWorkload: transcriptionFitWorkloadSchema
    .optional()
    .describe('MOSS fit-only workload. Required for a MOSS verdict; does not configure loading.'),
  modelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'The model to assess, as `loadModel` takes it. Optional for the loads `loadModel` also takes without one, where every source is a config field.'
    ),
  modelType: modelTypeInputSchema
    .optional()
    .describe(
      'Engine that would run the load. Inferred from `modelSrc` when omitted, as `loadModel` infers it; required only where the source does not name one.'
    ),
  ttsWorkload: ttsFitWorkloadSchema
    .optional()
    .describe(
      'Fit-only MOSS-TTS/TTSD or MOSS-SoundEffect workload; never passed to model loading.'
    ),
  modelConfig: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The config `loadModel` would be given, including any companion model sources.')
})

export const assessModelFitInputSchema = z.object({
  models: z
    .array(modelFitCandidateSchema)
    .min(1)
    .describe('Models to assess as if loaded at the same time.')
})

export const llamaFitStatsSchema = z
  .object({
    ctxSize: z.number().int().describe('The context size the load resolves to.'),
    gpuLayers: z.number().int().describe('The number of layers the load offloads to the GPU.')
  })
  .meta({ title: 'LlamaFitStats' })

export const modelFitStatsSchema = z
  .union([llamaFitStatsSchema, z.object({}).strict().meta({ title: 'EmptyFitStats' })])
  .describe('The resolved load of a llama.cpp verdict. Empty otherwise.')

export const modelFitDeviceSchema = z
  .object({
    id: z
      .string()
      .describe("The device's PCI bus ID when the backend reports one, its name otherwise."),
    name: z.string().describe("The backend's device name, such as `CPU`, `CUDA0` or `MTL0`."),
    unified: z
      .boolean()
      .describe("Memory the host owns: the CPU, and a GPU that shares the host's memory."),
    usedBytes: z.number().describe('The memory the load takes on this device.'),
    freeBytes: z.number().optional().describe('The free memory the device reported.'),
    totalBytes: z.number().optional().describe('The total memory the device reported.')
  })
  .meta({ title: 'ModelFitDevice' })

/** The result the engine's addon returns from `assessFit`, unchanged. */
export const modelFitModelResultSchema = z
  .object({
    status: modelFitVerdictSchema.describe("The engine fitter's verdict for this model alone."),
    devices: z
      .array(modelFitDeviceSchema)
      .describe('One row per device the load uses, the host last. Empty when unknown.'),
    stats: modelFitStatsSchema
  })
  .meta({ title: 'ModelFitModelResult' })

export const modelFitPoolSchema = z
  .object({
    id: z
      .string()
      .describe("`host` for the host's memory, the device's `id` for a GPU with its own memory."),
    unified: z.boolean().describe('Whether this is the host pool.'),
    usedBytes: z.number().describe("The sum of every model's rows in this pool."),
    freeBytes: z.number().optional().describe('The lowest free figure reported for the pool.'),
    totalBytes: z.number().optional().describe('The lowest total figure reported for the pool.')
  })
  .meta({ title: 'ModelFitPool' })

export const assessModelFitResultSchema = z.object({
  verdict: modelFitVerdictSchema.describe('The verdict for every model loaded together.'),
  pools: z
    .array(modelFitPoolSchema)
    .describe('The memory pools the verdict was judged on, with what the set takes from each.'),
  models: z.array(modelFitModelResultSchema).describe('One entry per model, in input order.')
})

/**
 * What `getLoadedModelInfo` reports of the fit check that ran ahead of a load:
 * the assessment of that one load against free memory. It carries its own
 * titles because every title in the contract names one schema.
 */
export const modelFitProbeSchema = z
  .object({
    verdict: modelFitVerdictSchema.describe('The verdict for this load against free memory.'),
    pools: z
      .array(modelFitPoolSchema.meta({ title: 'ModelFitProbePool' }))
      .describe('The memory pools the verdict was judged on, with what the load takes from each.'),
    models: z
      .array(
        modelFitModelResultSchema
          .extend({
            devices: z
              .array(modelFitDeviceSchema.meta({ title: 'ModelFitProbeDevice' }))
              .describe('One row per device the load uses, the host last. Empty when unknown.'),
            stats: z
              .union([
                llamaFitStatsSchema.meta({ title: 'ModelFitProbeLlamaStats' }),
                z.object({}).strict().meta({ title: 'ModelFitProbeEmptyStats' })
              ])
              .describe('The resolved load of a llama.cpp verdict. Empty otherwise.')
          })
          .meta({ title: 'ModelFitProbeModel' })
      )
      .describe("The load's own entry: the engine addon's `assessFit` result.")
  })
  .meta({ title: 'ModelFitProbe' })

export const assessModelFitRequestSchema = assessModelFitInputSchema
  .extend({
    type: z.literal('assessModelFit')
  })
  .extend(sessionScopedRequestSchema.shape)

export const assessModelFitResponseSchema = assessModelFitResultSchema.extend({
  type: z.literal('assessModelFit')
})

export type ModelFitVerdict = z.infer<typeof modelFitVerdictSchema>
export type LlamaFitStats = z.infer<typeof llamaFitStatsSchema>
export type ModelFitStats = z.infer<typeof modelFitStatsSchema>
export type ModelFitDevice = z.infer<typeof modelFitDeviceSchema>
export type ModelFitPool = z.infer<typeof modelFitPoolSchema>
export type ModelFitCandidate = z.infer<typeof modelFitCandidateSchema>
export type ModelFitModelResult = z.infer<typeof modelFitModelResultSchema>
export type ModelFitProbe = z.infer<typeof modelFitProbeSchema>
export type AssessModelFitInput = z.input<typeof assessModelFitInputSchema>
export type AssessModelFitResult = z.infer<typeof assessModelFitResultSchema>
export type AssessModelFitRequest = z.infer<typeof assessModelFitRequestSchema>
export type AssessModelFitResponse = z.infer<typeof assessModelFitResponseSchema>
