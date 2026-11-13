import { z } from 'zod'
import { sessionScopedRequestSchema } from '@/schemas/request-base'

export const heartbeatRequestSchema = z
  .object({
    type: z.literal('heartbeat')
  })
  .extend(sessionScopedRequestSchema.shape)

export const heartbeatResponseSchema = z.object({
  type: z.literal('heartbeat'),
  number: z.number()
})

export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>
