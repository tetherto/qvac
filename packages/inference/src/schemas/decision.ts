import { z } from 'zod'

/**
 * How deep a state, instruction or description may nest. The native decision
 * engines walk these values recursively in-process, where a stack overflow
 * cannot be caught; upstream llama.cpp applies the same limit (#30242).
 */
export const DECISION_MAX_JSON_DEPTH = 128

const NESTED_TOO_DEEP = `JSON is nested more than ${DECISION_MAX_JSON_DEPTH} levels deep`

type JsonCheck = 'ok' | 'invalid' | 'too-deep'

// Nested JSON stays inline in the wire contract. The check rejects values that
// JSON serialization would discard or change before reaching the model, and
// stops at DECISION_MAX_JSON_DEPTH, so a hostile value cannot exhaust the stack
// here or in the engine.
function checkJson(value: unknown, depth = 1, ancestors = new Set<object>()): JsonCheck {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return 'ok'
  if (typeof value === 'number') return Number.isFinite(value) ? 'ok' : 'invalid'
  if (typeof value !== 'object' || ancestors.has(value)) return 'invalid'
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return 'invalid'
  if (depth > DECISION_MAX_JSON_DEPTH) return 'too-deep'
  ancestors.add(value)
  let result: JsonCheck = 'ok'
  for (const child of Object.values(value)) {
    result = checkJson(child, depth + 1, ancestors)
    if (result !== 'ok') break
  }
  ancestors.delete(value)
  return result
}

function refineJson(value: unknown, ctx: z.RefinementCtx): void {
  const result = checkJson(value)
  if (result === 'too-deep') ctx.addIssue({ code: 'custom', message: NESTED_TOO_DEEP })
  else if (result === 'invalid') ctx.addIssue({ code: 'custom', message: 'Expected JSON values' })
}

export const decisionStateSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.unknown()).superRefine(refineJson),
  z.array(z.unknown()).superRefine(refineJson)
])

const questionBase = {
  instructions: decisionStateSchema.refine((value) => value !== '', 'Instructions cannot be empty')
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
      requireProbability: z
        .boolean()
        .optional()
        .describe(
          'Require the answer to be the probability that the statement holds. A model whose noul answer means something else (for example an expected rating) rejects the request.'
        )
    })
    .strict()
])

const decisionFields = {
  questions: z
    .record(z.string(), decisionQuestionSchema)
    .describe('Question ID to decision question.')
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

export const decisionAnswerSchema = z.discriminatedUnion('type', [
  z.object({
    confidence: z.number(),
    type: z.literal('choice'),
    choice: z.union([z.string(), z.number(), z.boolean()]),
    probabilities: z.record(z.string(), z.number())
  }),
  z.object({
    confidence: z.number(),
    type: z.literal('score'),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number())
  }),
  z.object({
    confidence: z
      .number()
      .optional()
      .describe('Only some models report a confidence for noul answers; none is derived.'),
    type: z.literal('noul'),
    noul: z.number()
  })
])

export const decisionResultSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), decisionAnswerSchema),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number()
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
      .describe('Layers to offload on the GPU. Unset lets the engine fit the model.'),
    batch_size: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Tokens per forward pass. Unset uses the engine's default."),
    threads: z
      .number()
      .int()
      .optional()
      .describe('CPU threads, at most the CPU count. Zero or below uses all logical CPUs.'),
    verbosity: z
      .number()
      .int()
      .min(0)
      .max(3)
      .optional()
      .describe('Native log level: 0 error, 1 warn, 2 info, 3 debug.'),
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
