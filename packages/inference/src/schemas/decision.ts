import { z } from 'zod'

// Nested JSON stays inline in the wire contract. The refinement rejects values
// that JSON serialization would discard or change before reaching Laya.
function isJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false
  ancestors.add(value)
  const valid = Object.values(value).every((child) => isJson(child, ancestors))
  ancestors.delete(value)
  return valid
}

export const layaStateSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.unknown()).refine(isJson, 'Expected JSON values'),
  z.array(z.unknown()).refine(isJson, 'Expected JSON values')
])

const questionBase = {
  instructions: layaStateSchema.refine((value) => value !== '', 'Instructions cannot be empty'),
  option_order: z.array(z.number().int().nonnegative()).optional()
}

export const layaQuestionSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...questionBase,
      type: z.literal('choice'),
      criteria: z.union([
        z.array(z.union([z.string(), z.number(), z.boolean()])),
        z.record(z.string(), layaStateSchema.nullable())
      ])
    })
    .strict(),
  z
    .object({
      ...questionBase,
      type: z.literal('score'),
      criteria: z.array(layaStateSchema)
    })
    .strict(),
  z
    .object({
      ...questionBase,
      type: z.literal('noul'),
      criteria: z
        .object({
          true: layaStateSchema.nullable().optional(),
          false: layaStateSchema.nullable().optional()
        })
        .strict()
        .nullable()
        .optional(),
      labels: z.object({ false: z.string(), true: z.string() }).strict().optional()
    })
    .strict()
])

const decisionFields = {
  questions: z.record(z.string(), layaQuestionSchema).describe('Question ID to Laya question.'),
  max_len: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Token budget per sequence; unset uses the checkpoint budget.'),
  head_max_len: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Token budget for each question and its options; unset uses the checkpoint budget.')
}

export const layaSingleRequestSchema = z
  .object({ ...decisionFields, state: layaStateSchema })
  .strict()
export const layaBatchRequestSchema = z
  .object({ ...decisionFields, states: z.array(layaStateSchema) })
  .strict()
export const layaRequestSchema = z.union([layaSingleRequestSchema, layaBatchRequestSchema])

const envelope = { modelId: z.string().min(1) }
export const decideParamsSchema = z.union([
  layaSingleRequestSchema.extend(envelope),
  layaBatchRequestSchema.extend(envelope)
])
const wireEnvelope = {
  ...envelope,
  type: z.literal('decide'),
  requestId: z.string().min(1).optional()
}
export const decideRequestSchema = z.union([
  layaSingleRequestSchema.extend(wireEnvelope).meta({ title: 'DecideSingleRequest' }),
  layaBatchRequestSchema.extend(wireEnvelope).meta({ title: 'DecideBatchRequest' })
])

const answerBase = {
  answer_confidence: z.number(),
  confidence: z.number(),
  action: z.object({ act_probability: z.number() })
}
export const layaAnswerSchema = z.discriminatedUnion('type', [
  z.object({
    ...answerBase,
    type: z.literal('choice'),
    choice: z.union([z.string(), z.number(), z.boolean()]),
    probabilities: z.record(z.string(), z.number())
  }),
  z.object({
    ...answerBase,
    type: z.literal('score'),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number())
  }),
  z.object({ ...answerBase, type: z.literal('noul'), noul: z.number() })
])

export const layaResultSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), layaAnswerSchema),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    state_tokens: z.number(),
    state_tokens_dropped: z.number(),
    truncated: z.boolean(),
    truncated_questions: z.array(z.string()),
    options: z
      .record(
        z.string(),
        z.object({
          total: z.number(),
          distinct: z.number(),
          tokens_per_option: z.number().nullable()
        })
      )
      .optional()
  })
})
export const layaResponseSchema = z.union([layaResultSchema, z.array(layaResultSchema)])
export const decideResponseSchema = z.object({
  type: z.literal('decide'),
  result: layaResponseSchema
})

export const decisionConfigBaseSchema = z
  .object({
    device: z.enum(['cpu', 'gpu']).optional().describe("Compute device. Default 'gpu'."),
    gpu_layers: z
      .number()
      .int()
      .optional()
      .describe('Layers to offload. Unset lets the addon choose placement.'),
    batch_size: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Tokens per forward pass. Default 2048; each sequence must fit.'),
    threads: z
      .number()
      .int()
      .optional()
      .describe('CPU threads, at most the CPU count. Zero or below uses all logical CPUs.'),
    'threads-batch': z
      .number()
      .int()
      .optional()
      .describe('Batch CPU threads. Unset uses threads; zero or below uses all logical CPUs.'),
    flash_attn: z
      .enum(['on', 'off', 'auto'])
      .optional()
      .describe('Flash attention mode. Default auto.'),
    verbosity: z
      .number()
      .int()
      .min(0)
      .max(3)
      .optional()
      .describe('Native log level: 0 error, 1 warn, 2 info, 3 debug.'),
    'main-gpu': z
      .union([z.number().int().nonnegative(), z.enum(['integrated', 'dedicated'])])
      .optional()
      .describe('GPU index or device class.'),
    'split-mode': z.enum(['none', 'layer']).optional().describe('Multi-GPU split mode.'),
    'tensor-split': z.string().optional().describe('Per-GPU tensor split proportions.'),
    openclCacheDir: z
      .string()
      .optional()
      .describe('Writable OpenCL kernel cache directory, required on Android.')
  })
  .strict()

export type DecisionConfigInput = z.infer<typeof decisionConfigBaseSchema>

export const DECISION_CONFIG_DEFAULTS = {
  device: 'gpu'
} as const satisfies Partial<DecisionConfigInput>

export const decisionConfigSchema = decisionConfigBaseSchema.transform((data) => ({
  ...DECISION_CONFIG_DEFAULTS,
  ...data,
  device: data.device ?? DECISION_CONFIG_DEFAULTS.device
}))

export type LayaState = z.infer<typeof layaStateSchema>
export type LayaQuestion = z.infer<typeof layaQuestionSchema>
export type LayaAnswer = z.infer<typeof layaAnswerSchema>
export type LayaResult = z.infer<typeof layaResultSchema>
export type LayaResponse = z.infer<typeof layaResponseSchema>
export type LayaRequest = z.infer<typeof layaRequestSchema>
type InferredDecideParams = z.infer<typeof decideParamsSchema>
export type DecideParams =
  | (Extract<InferredDecideParams, { state: unknown }> & { states?: never })
  | (Extract<InferredDecideParams, { states: unknown }> & { state?: never })
export type DecideRequest = z.infer<typeof decideRequestSchema>
export type DecisionConfig = z.infer<typeof decisionConfigSchema>
