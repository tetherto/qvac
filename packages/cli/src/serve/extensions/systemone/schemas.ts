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

const stateSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.unknown()).refine(isJson, 'Expected JSON values'),
  z.array(z.unknown()).refine(isJson, 'Expected JSON values')
])

const questionBase = {
  instructions: stateSchema.refine((value) => value !== '', 'Instructions cannot be empty'),
  option_order: z.array(z.number().int().nonnegative()).optional()
}

const questionSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...questionBase,
      type: z.literal('choice'),
      criteria: z.union([
        z.array(z.union([z.string(), z.number(), z.boolean()])),
        z.record(z.string(), stateSchema.nullable())
      ])
    })
    .strict(),
  z
    .object({
      ...questionBase,
      type: z.literal('score'),
      criteria: z.array(stateSchema)
    })
    .strict(),
  z
    .object({
      ...questionBase,
      type: z.literal('noul'),
      criteria: z
        .object({
          true: stateSchema.nullable().optional(),
          false: stateSchema.nullable().optional()
        })
        .strict()
        .nullable()
        .optional(),
      labels: z.object({ false: z.string(), true: z.string() }).strict().optional()
    })
    .strict()
])

export const systemOneBody = z
  .object({
    model: z.string().trim().min(1),
    state: stateSchema,
    questions: z.record(z.string(), questionSchema).describe('Question ID to Laya question.'),
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
  })
  .strict()

const answerBase = {
  answer_confidence: z.number(),
  confidence: z.number(),
  action: z.object({ act_probability: z.number() })
}
const answerSchema = z.discriminatedUnion('type', [
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

export const systemOneResult = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
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
export type SystemOneBody = z.infer<typeof systemOneBody>
export type SystemOneResult = z.infer<typeof systemOneResult>
