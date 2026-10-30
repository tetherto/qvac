import { z } from 'zod'

export const embedMediaSourceSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('base64'), value: z.string().min(1).base64() }),
    z.object({ type: z.literal('filePath'), value: z.string().min(1) })
  ])
  .describe(
    'Image or WAV/MP3/FLAC bytes as base64, or a file path accessible to the inference worker.'
  )

export const embedInputPartSchema = z.union([
  z.string(),
  z.object({ media: embedMediaSourceSchema })
])
export const embedInputSchema = z.union([
  z.string().min(1, 'Text cannot be empty'),
  z.array(embedInputPartSchema).min(1, 'Input parts cannot be empty')
])
const textEmbedParamsSchema = z.object({
  modelId: z.string().describe('The identifier of the embedding model to use'),
  text: z
    .union([
      z.string().min(1, 'Text cannot be empty'),
      z.array(z.string().min(1, 'Text cannot be empty')).min(1, 'Text array cannot be empty')
    ])
    .describe(
      'Text to embed. A string returns one vector; an array returns one vector per string.'
    ),
  inputs: z.never().optional()
})
const batchEmbedParamsSchema = z.object({
  modelId: z.string().describe('The identifier of the embedding model to use'),
  inputs: z
    .array(embedInputSchema)
    .min(1, 'Inputs cannot be empty')
    .describe(
      'One embedding per input. Each input is text or ordered text and media parts. Media requires projectionModelSrc at load time.'
    ),
  text: z.never().optional()
})
export const embedParamsSchema = z.union([textEmbedParamsSchema, batchEmbedParamsSchema])
const requestFields = {
  type: z.literal('embed'),
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe('Caller-generated identifier for cancellation with cancel({ requestId }).')
}
export const embedRequestSchema = z.union([
  textEmbedParamsSchema.extend(requestFields).meta({ title: 'EmbedTextRequest' }),
  batchEmbedParamsSchema.extend(requestFields).meta({ title: 'EmbedInputsRequest' })
])

export const embedStatsSchema = z.object({
  totalTime: z.number().optional().describe('Total embedding time in milliseconds'),
  tokensPerSecond: z.number().optional().describe('Tokens processed per second'),
  totalTokens: z.number().optional().describe('Total tokens processed'),
  backendDevice: z.enum(['cpu', 'gpu']).optional().describe('Compute backend used for inference'),
  contextSize: z.number().optional().describe('Context size in tokens')
})

export const embedResponseSchema = z.object({
  type: z.literal('embed'),
  success: z.boolean(),
  embedding: z
    .union([z.array(z.number()), z.array(z.array(z.number()))])
    .default([])
    .describe(
      'The embedding vector(s). Single `number[]` when `text` is a string; `number[][]` when `text` is an array or `inputs` is provided.'
    ),
  stats: embedStatsSchema.optional().describe('Performance statistics'),
  error: z.string().optional()
})

export type EmbedParams = z.infer<typeof embedParamsSchema>
export type EmbedRequest = z.infer<typeof embedRequestSchema>
export type EmbedResponse = z.infer<typeof embedResponseSchema>
export type EmbedStats = z.infer<typeof embedStatsSchema>

export type EmbedMediaSource = z.infer<typeof embedMediaSourceSchema>
export type EmbedInputPart = z.infer<typeof embedInputPartSchema>
export type EmbedInput = z.infer<typeof embedInputSchema>
