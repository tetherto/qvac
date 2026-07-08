import { z } from 'zod'

export const suspendRequestSchema = z.object({
  type: z.literal('suspend')
})

export const suspendResponseSchema = z.object({
  type: z.literal('suspend')
})

export const resumeRequestSchema = z.object({
  type: z.literal('resume')
})

export const resumeResponseSchema = z.object({
  type: z.literal('resume')
})

export const lifecycleStateSchema = z.enum(['active', 'suspending', 'suspended', 'resuming'])

export const stateRequestSchema = z.object({
  type: z.literal('state')
})

export const stateResponseSchema = z.object({
  type: z.literal('state'),
  state: lifecycleStateSchema
})

export type SuspendRequest = z.infer<typeof suspendRequestSchema>
export type SuspendResponse = z.infer<typeof suspendResponseSchema>
export type ResumeRequest = z.infer<typeof resumeRequestSchema>
export type ResumeResponse = z.infer<typeof resumeResponseSchema>
export type LifecycleState = z.infer<typeof lifecycleStateSchema>
export type StateRequest = z.infer<typeof stateRequestSchema>
export type StateResponse = z.infer<typeof stateResponseSchema>
