import { z } from 'zod'

// ============== Delete cache ==============

export const deleteCacheRequestSchema = z.union([
  z.object({
    type: z.literal('deleteCache'),
    all: z.literal(true)
  }),
  z.object({
    type: z.literal('deleteCache'),
    kvCacheKey: z.string(),
    modelId: z.string().optional()
  })
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
  autoClose: z.boolean().optional()
})

export const unloadModelRequestSchema = z.object({
  type: z.literal('unloadModel'),
  modelId: z.string(),
  clearStorage: z.boolean().default(false)
})

export const unloadModelResponseSchema = z.object({
  type: z.literal('unloadModel'),
  success: z.boolean(),
  error: z.string().optional(),
  hasActiveModels: z.boolean().optional(),
  hasActiveProviders: z.boolean().optional()
})

export type UnloadModelParams = z.input<typeof unloadModelParamsSchema>
export type UnloadModelRequest = z.infer<typeof unloadModelRequestSchema>
export type UnloadModelResponse = z.infer<typeof unloadModelResponseSchema>
