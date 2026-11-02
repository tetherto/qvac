import { z } from 'zod'

// Nested JSON stays inline in the wire contract. The refinement rejects values
// that JSON serialization would discard or change before reaching the model.
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

export const decisionStateSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.unknown()).refine(isJson, 'Expected JSON values'),
  z.array(z.unknown()).refine(isJson, 'Expected JSON values')
])

const questionBase = {
  instructions: decisionStateSchema.refine((value) => value !== '', 'Instructions cannot be empty'),
  optionOrder: z.array(z.number().int().nonnegative()).optional()
}

export const decisionQuestionSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...questionBase,
      type: z.literal('choice'),
      criteria: z.union([
        z.array(z.union([z.string(), z.number(), z.boolean()])),
        z.record(z.string(), decisionStateSchema.nullable())
      ])
    })
    .strict(),
  z
    .object({
      ...questionBase,
      type: z.literal('score'),
      criteria: z.array(decisionStateSchema)
    })
    .strict(),
  z
    .object({
      ...questionBase,
      type: z.literal('noul'),
      criteria: z
        .object({
          true: decisionStateSchema.nullable().optional(),
          false: decisionStateSchema.nullable().optional()
        })
        .strict()
        .nullable()
        .optional(),
      labels: z.object({ false: z.string(), true: z.string() }).strict().optional()
    })
    .strict()
])

const decisionFields = {
  questions: z
    .record(z.string(), decisionQuestionSchema)
    .describe('Question ID to decision question.'),
  maxLen: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Token budget per sequence; unset uses the checkpoint budget.'),
  headMaxLen: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Token budget for each question and its options; unset uses the checkpoint budget.')
}

export const decisionSingleRequestSchema = z
  .object({ ...decisionFields, state: decisionStateSchema })
  .strict()
export const decisionBatchRequestSchema = z
  .object({ ...decisionFields, states: z.array(decisionStateSchema) })
  .strict()
export const decisionRequestSchema = z.union([
  decisionSingleRequestSchema,
  decisionBatchRequestSchema
])

const envelope = { modelId: z.string().min(1) }
export const decideParamsSchema = z.union([
  decisionSingleRequestSchema.extend(envelope),
  decisionBatchRequestSchema.extend(envelope)
])
const wireEnvelope = {
  ...envelope,
  type: z.literal('decide'),
  requestId: z.string().min(1).optional()
}
export const decideRequestSchema = z.union([
  decisionSingleRequestSchema.extend(wireEnvelope).meta({ title: 'DecideSingleRequest' }),
  decisionBatchRequestSchema.extend(wireEnvelope).meta({ title: 'DecideBatchRequest' })
])

const answerBase = {
  answerConfidence: z.number(),
  confidence: z.number(),
  action: z.object({
    actProbability: z.number().describe('Currently unreliable; do not use to trigger actions.')
  })
}
export const decisionAnswerSchema = z.discriminatedUnion('type', [
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

export const decisionResultSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), decisionAnswerSchema),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    stateTokens: z.number(),
    stateTokensDropped: z.number(),
    truncated: z.boolean(),
    truncatedQuestions: z.array(z.string()),
    options: z
      .record(
        z.string(),
        z.object({
          total: z.number(),
          distinct: z.number(),
          tokensPerOption: z.number().nullable()
        })
      )
      .optional()
  })
})
export const decisionResponseSchema = z.union([decisionResultSchema, z.array(decisionResultSchema)])
export const decideResponseSchema = z.object({
  type: z.literal('decide'),
  result: decisionResponseSchema
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
    poll: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'CPU polling level, from 0 to 100. If omitted, uses the default native behavior. Higher values may reduce wake latency but consume more CPU during GPU work.'
      ),
    pollBatch: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'CPU polling level for batch processing, from 0 to 100. If omitted, uses the default native behavior.'
      ),
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

export type DecisionState = z.infer<typeof decisionStateSchema>
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>
export type DecisionResult = z.infer<typeof decisionResultSchema>
export type DecisionResponse = z.infer<typeof decisionResponseSchema>
export type DecisionRequest = z.infer<typeof decisionRequestSchema>
type InferredDecideParams = z.infer<typeof decideParamsSchema>
export type DecideParams =
  | (Extract<InferredDecideParams, { state: unknown }> & { states?: never })
  | (Extract<InferredDecideParams, { states: unknown }> & { state?: never })
export type DecideRequest = z.infer<typeof decideRequestSchema>
export type DecisionConfig = z.infer<typeof decisionConfigSchema>
