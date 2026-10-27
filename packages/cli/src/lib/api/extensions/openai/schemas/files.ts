import { z } from 'zod'

export const filesUploadBody = z
  .object({
    file: z.instanceof(Buffer).meta({ type: 'string', format: 'binary' }),
    purpose: z.string().optional()
  })
  .passthrough()

export const fileIdParams = z.object({ id: z.string().min(1) })
