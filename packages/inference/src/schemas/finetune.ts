import { z } from 'zod'
import { trackedRequestSchema } from '@/schemas/request-base'

const lrSchedulerValues = ['constant', 'cosine', 'linear'] as const
const finetuneStatusValues = ['IDLE', 'RUNNING', 'PAUSED', 'CANCELLED', 'COMPLETED'] as const

export const finetuneValidationSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('none')
      })
      .strict(),
    z
      .object({
        type: z.literal('split'),
        fraction: z.number().min(0).max(1).optional()
      })
      .strict(),
    z
      .object({
        type: z.literal('dataset'),
        path: z.string().min(1, 'Validation dataset path cannot be empty')
      })
      .strict()
  ])
  .transform((validation) =>
    validation.type === 'split'
      ? {
          ...validation,
          fraction: validation.fraction ?? 0.05
        }
      : validation
  )

const finetuneOptionsPayloadSchema = z
  .object({
    trainDatasetDir: z.string().min(1, 'Training dataset path cannot be empty'),
    validation: finetuneValidationSchema,
    outputParametersDir: z.string().min(1, 'Output parameters path cannot be empty'),
    numberOfEpochs: z.number().int().positive().optional(),
    learningRate: z.number().positive().optional(),
    contextLength: z.number().int().positive().optional(),
    batchSize: z.number().int().positive().optional(),
    microBatchSize: z.number().int().positive().optional(),
    assistantLossOnly: z.boolean().optional(),
    loraRank: z.number().int().positive().optional(),
    loraAlpha: z.number().positive().optional(),
    loraInitStd: z.number().positive().optional(),
    loraSeed: z.number().int().optional(),
    loraModules: z.string().min(1).optional(),
    checkpointSaveDir: z.string().min(1).optional(),
    checkpointSaveSteps: z.number().int().min(0).optional(),
    chatTemplatePath: z.string().min(1).optional(),
    lrScheduler: z.enum(lrSchedulerValues).optional(),
    lrMin: z.number().min(0).optional(),
    warmupRatio: z.number().min(0).max(1).optional(),
    warmupRatioSet: z.boolean().optional(),
    warmupSteps: z.number().int().min(0).optional(),
    warmupStepsSet: z.boolean().optional(),
    weightDecay: z.number().min(0).optional()
  })
  .strict()

const finetuneModelParamsSchema = z
  .object({
    modelId: z.string()
  })
  .strict()

const finetuneRunParamsSchemaBase = finetuneModelParamsSchema
  .extend({
    options: finetuneOptionsPayloadSchema
  })
  .strict()

export const finetuneRunParamsSchema = finetuneRunParamsSchemaBase
  .extend({
    operation: z.enum(['start', 'resume']).optional()
  })
  .strict()

export const finetuneGetStateParamsSchema = finetuneRunParamsSchemaBase
  .extend({
    operation: z.literal('getState')
  })
  .strict()

export const finetuneStopParamsSchema = finetuneModelParamsSchema
  .extend({
    operation: z.enum(['pause', 'cancel'])
  })
  .strict()

export const finetuneParamsSchema = z.union([
  finetuneRunParamsSchema,
  finetuneGetStateParamsSchema,
  finetuneStopParamsSchema
])

export const finetuneRunRequestSchema = finetuneRunParamsSchemaBase
  .extend({
    type: z.literal('finetune'),
    operation: z.enum(['start', 'resume']).optional(),
    withProgress: z.boolean().optional()
  })
  .extend(trackedRequestSchema.shape)
  .strict()
  .meta({ title: 'FinetuneRunRequest' })

export const finetuneGetStateRequestSchema = finetuneRunParamsSchemaBase
  .extend({
    type: z.literal('finetune'),
    operation: z.literal('getState')
  })
  .extend(trackedRequestSchema.shape)
  .strict()
  .meta({ title: 'FinetuneGetStateRequest' })

export const finetuneStopRequestSchema = finetuneModelParamsSchema
  .extend({
    type: z.literal('finetune'),
    operation: z.enum(['pause', 'cancel'])
  })
  .extend(trackedRequestSchema.shape)
  .strict()
  .meta({ title: 'FinetuneStopRequest' })

export const finetuneRequestSchema = z.union([
  finetuneRunRequestSchema,
  finetuneGetStateRequestSchema,
  finetuneStopRequestSchema
])

export const finetuneStatusSchema = z.enum(finetuneStatusValues)

export const finetuneProgressSchema = z
  .object({
    isTrain: z.boolean(),
    loss: z.union([z.number(), z.nan()]).nullable(),
    lossUncertainty: z.union([z.number(), z.nan()]).nullable(),
    accuracy: z.union([z.number(), z.nan()]).nullable(),
    accuracyUncertainty: z.union([z.number(), z.nan()]).nullable(),
    globalSteps: z.number().int().min(0),
    currentEpoch: z.number().int().min(0),
    currentBatch: z.number().int().min(0),
    totalBatches: z.number().int().min(0),
    elapsedMs: z.number().min(0),
    etaMs: z.number().min(0)
  })
  .strict()

export const finetuneStatsSchema = z
  .object({
    trainLoss: z.number().optional(),
    trainLossUncertainty: z.union([z.number(), z.nan()]).nullable().optional(),
    valLoss: z.number().optional(),
    valLossUncertainty: z.union([z.number(), z.nan()]).nullable().optional(),
    trainAccuracy: z.number().optional(),
    trainAccuracyUncertainty: z.union([z.number(), z.nan()]).nullable().optional(),
    valAccuracy: z.number().optional(),
    valAccuracyUncertainty: z.union([z.number(), z.nan()]).nullable().optional(),
    learningRate: z.number().optional(),
    globalSteps: z.number().int().min(0),
    epochsCompleted: z.number().int().min(0)
  })
  .strict()

export const finetuneResponseSchema = z
  .object({
    type: z.literal('finetune'),
    status: finetuneStatusSchema,
    stats: finetuneStatsSchema.optional()
  })
  .strict()

export const finetuneProgressResponseSchema = finetuneProgressSchema
  .extend({
    type: z.literal('finetune:progress'),
    modelId: z.string()
  })
  .strict()

export type FinetuneValidation = z.input<typeof finetuneValidationSchema>
export type FinetuneRunParams = z.input<typeof finetuneRunParamsSchema>
export type FinetuneGetStateParams = z.input<typeof finetuneGetStateParamsSchema>
export type FinetuneStopParams = z.infer<typeof finetuneStopParamsSchema>
export type FinetuneParams = z.input<typeof finetuneParamsSchema>
export type FinetuneRunRequest = z.infer<typeof finetuneRunRequestSchema>
export type FinetuneGetStateRequest = z.infer<typeof finetuneGetStateRequestSchema>
export type FinetuneStopRequest = z.infer<typeof finetuneStopRequestSchema>
export type FinetuneRequest = z.infer<typeof finetuneRequestSchema>
export type FinetuneStatus = z.infer<typeof finetuneStatusSchema>
export type FinetuneProgress = z.infer<typeof finetuneProgressSchema>
export type FinetuneStats = z.infer<typeof finetuneStatsSchema>
export type FinetuneResult = z.infer<typeof finetuneResponseSchema>
export type FinetuneProgressResponse = z.infer<typeof finetuneProgressResponseSchema>
