import { z } from 'zod'
import {
  imageEmbeddingInputSchema,
  imageEmbeddingClientInputSchema,
  imageEmbeddingStatsSchema
} from './image-embedding'

const mediaSourceSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('base64'), value: z.string().min(1).base64() }),
    z.object({ type: z.literal('filePath'), value: z.string().min(1) })
  ])
  .describe(
    'Image or WAV/MP3/FLAC bytes as base64, or a file path accessible to the inference worker.'
  )

export const embedMediaSourceSchema = mediaSourceSchema.meta({ title: 'EmbedMediaSource' })
export const embedInputPartSchema = z
  .union([
    z.string(),
    z.object({ media: embedMediaSourceSchema }).meta({ title: 'EmbedMediaInputPart' })
  ])
  .meta({ title: 'EmbedInputPart' })
const inputPartSchema = z.union([z.string(), z.object({ media: mediaSourceSchema })])

function textMediaInputSchema(parts: typeof inputPartSchema) {
  return z.union([
    z.string().min(1, 'Text cannot be empty'),
    z
      .array(parts)
      .min(1, 'Input parts cannot be empty')
      .refine(
        (items) => items.some((part) => typeof part !== 'string' || part.length > 0),
        'Input cannot be empty'
      )
  ])
}
// Text or ordered text/media parts. This is the item type of the legacy embed({ inputs }) call,
// kept unchanged so generated Kotlin and Python types for that call stay source-compatible.
export const embedInputSchema = textMediaInputSchema(embedInputPartSchema).meta({
  title: 'EmbedInput'
})
const textMediaEmbedInputSchema = textMediaInputSchema(inputPartSchema)
// Any input a model can embed, including a MegaLoc image. Used by embed({ input }) and embedBatch.
export const embedWireInputSchema = z.union([
  ...textMediaEmbedInputSchema.options,
  imageEmbeddingInputSchema
])
export const embedClientInputSchema = z.union([
  ...textMediaEmbedInputSchema.options,
  imageEmbeddingClientInputSchema
])

// The contract needs every title to be globally unique, so each wire use of
// embedWireInputSchema gets its own titles. Untitled arms would reach Python and
// Kotlin with field-derived (`Input1`) or hashed names.
function titledInputSchema(title: string) {
  const [text, parts] = textMediaInputSchema(inputPartSchema).options
  return z
    .union([
      text.meta({ title: `${title}Text` }),
      parts.meta({ title: `${title}Parts` }),
      imageEmbeddingInputSchema.meta({ title: `${title}Image` })
    ])
    .meta({ title })
}

// Field order matters: the Kotlin generator emits constructor parameters in this order.
const modelId = z.string().describe('The identifier of the embedding model to use')
const absent = z.never().optional()
const textEmbedParamsSchema = z.object({
  modelId,
  text: z
    .union([
      z.string().min(1, 'Text cannot be empty'),
      z.array(z.string().min(1, 'Text cannot be empty')).min(1, 'Text array cannot be empty')
    ])
    .describe(
      'Legacy text input. A string returns one vector; an array returns one vector per string.'
    ),
  inputs: absent,
  input: absent
})
const inputsEmbedParamsSchema = z.object({
  modelId,
  inputs: z
    .array(embedInputSchema)
    .min(1, 'Inputs cannot be empty')
    .describe(
      'Legacy batch input. One vector per text or ordered text/media input. Use embedBatch for images.'
    ),
  text: absent,
  input: absent
})
const singleInputDescription =
  'One text, ordered text/media input, or image supported by the model.'
const batchInputsDescription = 'One vector per input, in input order.'
const singleEmbedParamsSchema = z.object({
  modelId,
  input: embedWireInputSchema.describe(singleInputDescription),
  text: absent,
  inputs: absent
})
export const embedBatchParamsSchema = z.object({
  modelId,
  inputs: z
    .array(embedWireInputSchema)
    .min(1, 'Inputs cannot be empty')
    .describe(batchInputsDescription),
  text: absent,
  input: absent
})
const clientSingleEmbedParamsSchema = singleEmbedParamsSchema.extend({
  input: embedClientInputSchema
})
export const embedBatchClientParamsSchema = embedBatchParamsSchema.extend({
  inputs: z.array(embedClientInputSchema).min(1, 'Inputs cannot be empty')
})
// Worker-side params for the llama.cpp op, which serves both embed and embedBatch requests.
export const embedParamsSchema = z.union([
  textEmbedParamsSchema,
  embedBatchParamsSchema,
  singleEmbedParamsSchema
])
// The params embed() accepted before embedBatch existed.
export const embedLegacyParamsSchema = z.union([textEmbedParamsSchema, inputsEmbedParamsSchema])
export const embedClientParamsSchema = z.union([
  textEmbedParamsSchema,
  inputsEmbedParamsSchema,
  clientSingleEmbedParamsSchema
])
const requestId = z
  .string()
  .min(1)
  .optional()
  .describe('Caller-generated identifier for cancellation with cancel({ requestId }).')
const requestFields = { type: z.literal('embed'), requestId }
export const embedRequestSchema = z.union([
  textEmbedParamsSchema.extend(requestFields).meta({ title: 'EmbedTextRequest' }),
  inputsEmbedParamsSchema.extend(requestFields).meta({ title: 'EmbedInputsRequest' }),
  singleEmbedParamsSchema
    .extend({
      ...requestFields,
      input: titledInputSchema('EmbedSingleInput').describe(singleInputDescription)
    })
    .meta({ title: 'EmbedSingleRequest' })
])
export const embedBatchRequestSchema = embedBatchParamsSchema.extend({
  type: z.literal('embedBatch'),
  requestId,
  inputs: z
    .array(titledInputSchema('EmbedBatchInput'))
    .min(1, 'Inputs cannot be empty')
    .describe(batchInputsDescription)
})

// embed() is model-agnostic, so its stats cover both engines. Each model fills only its own fields.
const imageStats = imageEmbeddingStatsSchema.shape
export const embedStatsSchema = z.object({
  totalTime: z
    .number()
    .optional()
    .describe(
      'Total embedding time in milliseconds. For a MegaLoc batch, the sum of native times.'
    ),
  tokensPerSecond: z
    .number()
    .optional()
    .describe('Tokens processed per second. llama.cpp embedding models only.'),
  totalTokens: z
    .number()
    .optional()
    .describe('Total tokens processed. llama.cpp embedding models only.'),
  backendDevice: z
    .enum(['cpu', 'gpu'])
    .optional()
    .describe('Compute backend used for inference. llama.cpp embedding models only.'),
  backendName: z
    .string()
    .optional()
    .describe(
      'Backend families used by the primary model after loading and fitting, in lowercase. Multiple families are sorted and comma-separated. Optional with older addons. llama.cpp embedding models only.'
    ),
  contextSize: z
    .number()
    .optional()
    .describe('Context size in tokens. llama.cpp embedding models only.'),
  backendId: imageStats.backendId.describe(
    'Native backend ID: CPU=0, Metal=1, CUDA=2, Vulkan=3, OpenCL=4, other=99. MegaLoc only.'
  ),
  cpuFallbackNodes: imageStats.cpuFallbackNodes.describe(
    'Number of graph nodes scheduled on CPU fallback. MegaLoc only.'
  ),
  weightBytes: imageStats.weightBytes.describe('Allocated model weight bytes. MegaLoc only.')
})

export const embedResponseSchema = z.object({
  type: z.literal('embed'),
  success: z.boolean(),
  embedding: z
    .union([z.array(z.number()), z.array(z.array(z.number()))])
    .default([])
    .describe(
      'One vector for input or a text string. One vector per item for legacy text arrays or inputs.'
    ),
  stats: embedStatsSchema.optional().describe('Performance statistics'),
  error: z.string().optional()
})

export const embedBatchResponseSchema = embedResponseSchema.extend({
  type: z.literal('embedBatch'),
  embedding: z.array(z.array(z.number()))
})

export type EmbedClientInput = z.infer<typeof embedClientInputSchema>
export type EmbedWireInput = z.infer<typeof embedWireInputSchema>
export type EmbedClientParams = z.infer<typeof embedClientParamsSchema>
export type EmbedLegacyParams = z.infer<typeof embedLegacyParamsSchema>
export type EmbedBatchClientParams = z.infer<typeof embedBatchClientParamsSchema>
export type EmbedBatchParams = z.infer<typeof embedBatchParamsSchema>
export type EmbedBatchRequest = z.infer<typeof embedBatchRequestSchema>
export type EmbedBatchResponse = z.infer<typeof embedBatchResponseSchema>
export type EmbedParams = z.infer<typeof embedParamsSchema>
export type EmbedRequest = z.infer<typeof embedRequestSchema>
export type EmbedResponse = z.infer<typeof embedResponseSchema>
export type EmbedStats = z.infer<typeof embedStatsSchema>

export type EmbedMediaSource = z.infer<typeof embedMediaSourceSchema>
export type EmbedInputPart = z.infer<typeof embedInputPartSchema>
export type EmbedInput = z.infer<typeof embedInputSchema>
