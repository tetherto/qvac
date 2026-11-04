import { z } from 'zod'

const text = z.string().max(10485760)
const shortText = z.string().max(1048576)
const unsupportedCache = z
  .null()
  .optional()
  .describe('Prompt caching is unavailable for local decisions.')
const inputText = z
  .object({
    type: z.literal('input_text'),
    text,
    prompt_cache_breakpoint: unsupportedCache
  })
  .strict()
const outputText = z.object({ type: z.literal('output_text'), text }).strict()
const refusal = z.object({ type: z.literal('refusal'), refusal: text }).strict()
const inputContent = z.union([text, z.array(inputText)])
const message = z
  .object({
    type: z.literal('message').optional(),
    role: z.enum(['user', 'developer', 'system', 'assistant']),
    content: z.union([text, z.array(z.union([inputText, outputText, refusal]))]),
    phase: z.enum(['commentary', 'final_answer']).nullable().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.phase !== undefined && value.phase !== null && value.role !== 'assistant') {
      ctx.addIssue({
        code: 'custom',
        path: ['phase'],
        message: 'Only assistant messages have a phase.'
      })
    }
    if (Array.isArray(value.content)) {
      value.content.forEach((part, index) => {
        const valid =
          value.role === 'assistant' ? part.type !== 'input_text' : part.type === 'input_text'
        if (!valid) {
          ctx.addIssue({
            code: 'custom',
            path: ['content', index],
            message: 'Content type does not match the message role.'
          })
        }
      })
    }
  })
const callBase = {
  call_id: z.string().min(1).max(64),
  id: shortText.nullable().optional(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).nullable().optional()
}
const callName = {
  namespace: z.string().min(1).max(64).nullable().optional()
}
const inputItem = z.union([
  message,
  z
    .object({
      ...callBase,
      ...callName,
      type: z.literal('function_call'),
      name: z.string().min(1).max(128),
      arguments: shortText
    })
    .strict(),
  z.object({ ...callBase, type: z.literal('function_call_output'), output: inputContent }).strict(),
  z
    .object({
      ...callBase,
      ...callName,
      type: z.literal('custom_tool_call'),
      name: z.string().min(1).max(64),
      input: shortText
    })
    .strict(),
  z
    .object({ ...callBase, type: z.literal('custom_tool_call_output'), output: inputContent })
    .strict()
])
const input = z.union([text, z.array(inputItem).min(1)]).superRefine((value, ctx) => {
  if (typeof value === 'string') return
  const calls = new Map<string, string>()
  value.forEach((item, index) => {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (calls.has(item.call_id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'call_id'],
          message: 'Duplicate tool call ID.'
        })
      }
      calls.set(item.call_id, item.type)
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const expected = item.type === 'function_call_output' ? 'function_call' : 'custom_tool_call'
      if (calls.get(item.call_id) !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'call_id'],
          message: 'Tool output must match an earlier call of the same type.'
        })
      }
    }
  })
})
const questionBase = {
  name: shortText.optional(),
  instructions: shortText.min(1).describe('Local decision models require nonempty instructions.')
}
const choiceValue = z.union([z.string(), z.boolean()])
const question = z.discriminatedUnion('type', [
  z.object({ ...questionBase, type: z.literal('predicate') }).strict(),
  z
    .object({
      ...questionBase,
      type: z.literal('choice'),
      choices: z
        .array(z.object({ value: choiceValue, description: shortText.optional() }).strict())
        .min(2)
        .max(255)
        .refine(
          (choices) =>
            new Set(choices.map(({ value }) => JSON.stringify(value))).size === choices.length,
          'Choice values must be unique.'
        )
    })
    .strict(),
  z
    .object({
      ...questionBase,
      type: z.literal('score'),
      levels: z
        .array(z.object({ label: shortText, description: shortText.optional() }).strict())
        .min(2)
    })
    .strict()
])

export const decisionsBody = z
  .object({
    model: z.string().trim().min(1).max(1048576),
    input: input.describe(
      'Text or text conversation items. Images are unsupported by local decision models.'
    ),
    questions: z.array(question).min(1).max(200),
    safety_identifier: z.string().max(128).nullable().optional(),
    prompt_cache_key: z.string().max(64).nullable().optional(),
    prompt_cache_options: unsupportedCache
  })
  .strict()

const answerBase = { name: z.string().nullable() }
const probability = z.number().min(0).max(1)
export const decisionsResult = z.object({
  model: z.string(),
  answers: z.array(
    z.discriminatedUnion('type', [
      z.object({ ...answerBase, type: z.literal('predicate'), probability }),
      z.object({
        ...answerBase,
        type: z.literal('choice'),
        choice: choiceValue,
        confidence: probability,
        probabilities: z.array(z.object({ value: choiceValue, probability }))
      }),
      z.object({
        ...answerBase,
        type: z.literal('score'),
        score: z.number(),
        confidence: probability,
        probabilities: z.array(
          z.object({ value: z.number().int(), label: z.string(), probability })
        )
      }),
      z.object({ ...answerBase, type: z.literal('refusal') })
    ])
  ),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    input_tokens_details: z.object({
      cached_tokens: z.number().int().nonnegative(),
      cache_write_tokens: z.number().int().nonnegative()
    }),
    output_tokens: z.number().int().nonnegative(),
    output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative() }),
    total_tokens: z.number().int().nonnegative()
  })
})

export type DecisionsBody = z.infer<typeof decisionsBody>
export type DecisionsResult = z.infer<typeof decisionsResult>
