import { z } from 'zod'
import { historyMessageSchema } from '@/schemas/completion-stream'
import { toolSchema } from '@/schemas/tools'

const modelId = z.string().min(1).describe('Loaded language model to tokenize with.')
const text = z.string().describe('Raw text, or the final user turn when history is present.')
const history = z
  .array(historyMessageSchema)
  .describe('Conversation to render with the loaded model chat template.')
const tools = z.array(toolSchema).optional().describe('Tools to include in the rendered prompt.')

const textFields = {
  modelId,
  text,
  history: history.optional(),
  tools
}
const historyFields = {
  modelId,
  text: text.optional(),
  history: history.min(1),
  tools
}

export const calcTokensParamsSchema = z.union([
  z.object(textFields).strict(),
  z.object(historyFields).strict()
])

export const calcTokensRequestSchema = z.union([
  z.object({ ...textFields, type: z.literal('calcTokens') }).strict(),
  z.object({ ...historyFields, type: z.literal('calcTokens') }).strict()
])

export const calcTokensResponseSchema = z.object({
  type: z.literal('calcTokens'),
  tokens: z.number().int().nonnegative()
})

export type CalcTokensParams = z.infer<typeof calcTokensParamsSchema>
export type CalcTokensRequest = z.infer<typeof calcTokensRequestSchema>
export type CalcTokensResponse = z.infer<typeof calcTokensResponseSchema>
