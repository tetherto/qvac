import { z } from 'zod'

export const heartbeatRequestSchema = z.object({
  type: z.literal('heartbeat')
})

export const heartbeatResponseSchema = z.object({
  type: z.literal('heartbeat'),
  number: z.number()
})

export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>
