import { ModelHandleInvalidatedError, SessionInvalidatedError } from '@/utils/errors-client'

/**
 * Client-side record of every session handle this process opened. The RPC
 * layer consults it on each session-stamped request: a request waits for its
 * session's `openSession` round trip, and a request on a session that was
 * closed, shut down with the runtime or lost with the worker is refused
 * locally with a typed error instead of reaching the wire.
 */

export type SessionEndReason = 'closed' | 'shutdown' | 'crashed'

interface SessionRecord {
  opened: Promise<void>
  /** Why the open failed; every later call on the handle fails with it. */
  openError: unknown
  ended: SessionEndReason | undefined
  /** Model ids this session loaded and has not unloaded. */
  heldModels: Set<string>
}

const sessions = new Map<string, SessionRecord>()

export function registerSession(sessionId: string, opened: Promise<void>): void {
  const record: SessionRecord = {
    opened,
    openError: undefined,
    ended: undefined,
    heldModels: new Set()
  }
  opened.catch((error: unknown) => {
    record.openError = error
  })
  sessions.set(sessionId, record)
}

export function endSession(sessionId: string, reason: SessionEndReason): void {
  const record = sessions.get(sessionId)
  if (!record) return
  if (record.ended === undefined) record.ended = reason
  record.heldModels.clear()
}

/** Runtime shutdown or worker loss: every open session is gone with it. */
export function endAllSessions(reason: Exclude<SessionEndReason, 'closed'>): void {
  for (const sessionId of sessions.keys()) endSession(sessionId, reason)
}

export function isSessionEnded(sessionId: string): boolean {
  return sessions.get(sessionId)?.ended !== undefined
}

export function recordHeldModel(sessionId: string, modelId: string): void {
  sessions.get(sessionId)?.heldModels.add(modelId)
}

export function releaseHeldModel(sessionId: string, modelId: string): void {
  sessions.get(sessionId)?.heldModels.delete(modelId)
}

export function isModelHeldBySession(sessionId: string, modelId: string): boolean {
  return sessions.get(sessionId)?.heldModels.has(modelId) ?? false
}

/**
 * Called by the RPC layer before a session-stamped request leaves the
 * process. Resolves once the session is open on the worker; rejects with the
 * typed local error when the session can no longer be used.
 */
export async function awaitSessionUsable(
  sessionId: string,
  request: { modelId?: string | undefined }
): Promise<void> {
  const record = sessions.get(sessionId)
  if (!record) return
  if (record.openError !== undefined) throw record.openError
  if (record.ended !== undefined) throw endedError(sessionId, record, request.modelId)
  await record.opened
  if (record.ended !== undefined) throw endedError(sessionId, record, request.modelId)
}

function endedError(sessionId: string, record: SessionRecord, modelId: string | undefined): Error {
  const reason = record.ended ?? 'closed'
  if (modelId !== undefined && record.heldModels.has(modelId)) {
    return new ModelHandleInvalidatedError(modelId, sessionId)
  }
  return new SessionInvalidatedError(sessionId, reason)
}

/** Test seam: forget every record. */
export function resetSessionRegistry(): void {
  sessions.clear()
}
