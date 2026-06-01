import { z } from 'zod'

export const embeddingsBody = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.string().optional(),
  dimensions: z.number().optional(),
  user: z.string().optional()
}).passthrough()

export const EMBEDDINGS_UNSUPPORTED_PARAMS = ['encoding_format', 'dimensions', 'user'] as const
