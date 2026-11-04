import { z } from 'zod'
import { historyMessageSchema } from '@/schemas/completion-stream'
import { toolSchema } from '@/schemas/tools'

const modelId = z.string().min(1).describe('Loaded language model to tokenize with.')
const text = z.string().describe('Raw text, or the final user turn when history is present.')
const history = z
  .array(historyMessageSchema)
  .describe(
    'Text-only conversation to render with the loaded model chat template. Attachments are not supported by token counting.'
  )
const tools = z.array(toolSchema).optional().describe('Tools to include in the rendered prompt.')

const commonFields = {
  modelId,
  tools
}
const textFields = { ...commonFields, text, history: history.optional() }
const historyFields = { ...commonFields, text: text.optional(), history: history.min(1) }

const calcTokensTextParamsSchema = z.object(textFields).strict()
const calcTokensHistoryParamsSchema = z.object(historyFields).strict()
export const calcTokensParamsSchema = z.union([
  calcTokensTextParamsSchema,
  calcTokensHistoryParamsSchema
])

const requestEnvelope = { type: z.literal('calcTokens') }
export const calcTokensRequestSchema = z.union([
  calcTokensTextParamsSchema.extend(requestEnvelope).meta({ title: 'CalcTokensRequestText' }),
  calcTokensHistoryParamsSchema.extend(requestEnvelope).meta({ title: 'CalcTokensRequestHistory' })
])

export const calcTokensResponseSchema = z.object({
  type: z.literal('calcTokens'),
  tokens: z.number().int().nonnegative()
})

export type CalcTokensParams = z.infer<typeof calcTokensParamsSchema>
export type CalcTokensRequest = z.infer<typeof calcTokensRequestSchema>
export type CalcTokensResponse = z.infer<typeof calcTokensResponseSchema>
