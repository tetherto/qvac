import { z } from 'zod'
import { sessionScopedRequestSchema } from '@/schemas/request-base'

// ============== Delete cache ==============

export const deleteCacheRequestSchema = z.union([
  z
    .object({
      type: z.literal('deleteCache'),
      all: z.literal(true)
    })
    .extend(sessionScopedRequestSchema.shape)
    .meta({ title: 'DeleteCacheAllRequest' }),
  z
    .object({
      type: z.literal('deleteCache'),
      auto: z.literal(true)
    })
    .extend(sessionScopedRequestSchema.shape)
    .meta({ title: 'DeleteCacheAutoRequest' }),
  z
    .object({
      type: z.literal('deleteCache'),
      kvCacheKey: z.string(),
      modelId: z.string().optional()
    })
    .extend(sessionScopedRequestSchema.shape)
    .meta({ title: 'DeleteCacheKvEntryRequest' }),
  z
    .object({
      type: z.literal('deleteCache'),
      modelSrc: z
        .string()
        .describe('registry:// source of the model whose cached download to delete')
    })
    .extend(sessionScopedRequestSchema.shape)
    .meta({ title: 'DeleteCacheModelRequest' })
])

export const deleteCacheResponseSchema = z.object({
  type: z.literal('deleteCache'),
  success: z.boolean(),
  error: z.string().optional()
})

export type DeleteCacheRequest = z.infer<typeof deleteCacheRequestSchema>
export type DeleteCacheResponse = z.infer<typeof deleteCacheResponseSchema>

// ============== Unload model ==============

export const unloadModelParamsSchema = z.object({
  modelId: z.string(),
  clearStorage: z.boolean().default(false),
  autoClose: z.boolean().optional(),
  sessionId: z.string().min(1).optional()
})

export const unloadModelRequestSchema = z
  .object({
    type: z.literal('unloadModel'),
    modelId: z.string(),
    clearStorage: z.boolean().default(false)
  })
  .extend(sessionScopedRequestSchema.shape)

export const unloadModelResponseSchema = z.object({
  type: z.literal('unloadModel'),
  success: z.boolean(),
  error: z.string().optional(),
  hasActiveModels: z.boolean().optional(),
  hasOpenSessions: z
    .boolean()
    .optional()
    .describe('Whether any caller session is still open. The owner only auto-closes when none is.'),
  released: z
    .boolean()
    .optional()
    .describe("Whether the caller's lease on the model was released by this call."),
  unloaded: z
    .boolean()
    .optional()
    .describe(
      'Whether the model left memory. False when another session still holds a lease on it.'
    )
})

export type UnloadModelParams = z.input<typeof unloadModelParamsSchema>
export type UnloadModelRequest = z.infer<typeof unloadModelRequestSchema>
export type UnloadModelResponse = z.infer<typeof unloadModelResponseSchema>
