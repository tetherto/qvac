import { z } from 'zod'

export const filesUploadBody = z.object({
  file: z.instanceof(Buffer),
  purpose: z.string().optional()
}).passthrough()

export const fileIdParams = z.object({ id: z.string().min(1) })
