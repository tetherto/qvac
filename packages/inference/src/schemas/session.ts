import { z } from 'zod'
import { sessionIdSchema } from '@/schemas/request-base'

export const openSessionRequestSchema = z.object({
  type: z.literal('openSession'),
  sessionId: sessionIdSchema.describe(
    'Identifier the client minted for the new session. Rejected when a session with this id is already open.'
  ),
  name: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Human-readable label for logs and diagnostics.')
})

export const openSessionResponseSchema = z.object({
  type: z.literal('openSession'),
  success: z.boolean(),
  sessionId: z.string(),
  error: z.string().optional()
})

export const closeSessionRequestSchema = z.object({
  type: z.literal('closeSession'),
  sessionId: sessionIdSchema.describe('Identifier of the session to close.')
})

export const closeSessionResponseSchema = z.object({
  type: z.literal('closeSession'),
  success: z.boolean(),
  sessionId: z.string(),
  cancelled: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Number of in-flight requests of the session that this call cancelled.'),
  releasedModels: z
    .array(z.string())
    .optional()
    .describe('Model ids whose lease the session held. Models with no lease left were unloaded.'),
  error: z.string().optional()
})

/**
 * Operations that change the shared runtime for every session: pausing and
 * resuming it, deleting its model storage, and starting or stopping its RPC
 * servers. Only the owner may call them; a session that tries is refused with
 * `OwnerOnlyError` before the handler runs. The SDK contract marks them, with
 * session management, as owner-only, so generated clients leave them off a
 * session handle.
 */
export const OWNER_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  'suspend',
  'resume',
  'deleteCache',
  'startRpcServer',
  'stopRpcServer'
])

export type OpenSessionRequest = z.infer<typeof openSessionRequestSchema>
export type OpenSessionResponse = z.infer<typeof openSessionResponseSchema>
export type CloseSessionRequest = z.infer<typeof closeSessionRequestSchema>
export type CloseSessionResponse = z.infer<typeof closeSessionResponseSchema>
