import { z } from 'zod'
import { historyMessageSchema } from '@/schemas/completion-stream'
import { toolSchema } from '@/schemas/tools'

const modelId = z.string().min(1).describe('Loaded language model to tokenize with.')
const text = z.string().describe('Raw text, or the final user turn when history is present.')
const history = z
  .array(historyMessageSchema)
  .describe('Conversation to render with the loaded model chat template.')
const nonEmptyHistory = z
  .array(historyMessageSchema)
  .min(1)
  .describe('Conversation to render with the loaded model chat template.')
const tools = z.array(toolSchema).optional().describe('Tools to include in the rendered prompt.')

const fields = {
  modelId,
  text: text.optional(),
  history: history.optional(),
  tools
}
const requiredInput = z.union([z.object({ text }), z.object({ history: nonEmptyHistory })])

export const calcTokensParamsSchema = z.object(fields).strict().and(requiredInput)

export const calcTokensRequestSchema = z
  .object({ ...fields, type: z.literal('calcTokens') })
  .strict()
  .and(requiredInput)

export const calcTokensResponseSchema = z.object({
  type: z.literal('calcTokens'),
  tokens: z.number().int().nonnegative()
})

export type CalcTokensParams = z.infer<typeof calcTokensParamsSchema>
export type CalcTokensRequest = z.infer<typeof calcTokensRequestSchema>
export type CalcTokensResponse = z.infer<typeof calcTokensResponseSchema>
