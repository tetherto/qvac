import { z } from 'zod'

export const textTranslationsBody = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    stream: z.boolean().optional()
  })
  .passthrough()
