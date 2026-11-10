import { z } from 'zod'
import {
  historyMessageWithoutAttachmentsSchema,
  type CompletionClientParams
} from '@/schemas/completion-stream'
import { toolSchema } from '@/schemas/tools'

const modelId = z.string().min(1).describe('Loaded language model to tokenize with.')
const text = z.string().describe('Raw text, or the final user turn when history is present.')
const history = z
  .array(historyMessageWithoutAttachmentsSchema.meta({ title: 'CalcTokensHistoryMessage' }))
  .describe('Text-only conversation to render with the loaded model chat template.')
const tools = z
  .array(toolSchema.meta({ title: 'CalcTokensTool' }))
  .optional()
  .describe(
    'Tools to include in the rendered prompt when the model was loaded with `modelConfig.tools: true`.'
  )

const commonFields = {
  modelId,
  tools
}
const promptFields = { ...commonFields, text: text.optional(), history: history.optional() }

function hasPrompt(value: { text?: string | undefined; history?: readonly object[] | undefined }) {
  return value.text !== undefined || (value.history?.length ?? 0) > 0
}

const promptRequired = {
  message: 'At least one prompt source is required: `text` or non-empty `history`.'
}
const promptRequiredJsonSchema = {
  if: { not: { required: ['text'] } },
  then: { properties: { history: { minItems: 1 } }, required: ['history'] }
}

export const calcTokensParamsSchema = z
  .object(promptFields)
  .strict()
  .meta(promptRequiredJsonSchema)
  .refine(hasPrompt, promptRequired)

export const calcTokensRequestSchema = z
  .object({ ...promptFields, type: z.literal('calcTokens') })
  .strict()
  .meta(promptRequiredJsonSchema)
  .refine(hasPrompt, promptRequired)

export const calcTokensResponseSchema = z.object({
  type: z.literal('calcTokens'),
  tokens: z.number().int().nonnegative()
})

type CalcTokensParamsShape = z.infer<typeof calcTokensParamsSchema>
type CalcTokensParamsBase = Omit<CalcTokensParamsShape, 'text' | 'history'>
type CompletionHistory = CompletionClientParams['history']
export type CalcTokensParams =
  | (CalcTokensParamsBase & { text: string; history?: CompletionHistory })
  | (CalcTokensParamsBase & { text?: string; history: CompletionHistory })
export type CalcTokensRequest = z.infer<typeof calcTokensRequestSchema>
export type CalcTokensResponse = z.infer<typeof calcTokensResponseSchema>
