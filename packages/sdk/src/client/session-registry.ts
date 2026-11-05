import { ModelHandleInvalidatedError, SessionInvalidatedError } from '@/utils/errors-client'

/**
 * Client-side record of every session handle this process opened, and of the
 * models the owner loaded. The RPC layer consults it on each request: a
 * session-stamped request waits for its session's `openSession` round trip,
 * and a request on a session that was closed, shut down with the runtime or
 * lost with the worker is refused locally with a typed error instead of
 * reaching the wire. An owner request naming a model that was loaded before
 * the runtime stopped is refused the same way until the model is loaded again.
 */

export type SessionEndReason = 'closed' | 'shutdown' | 'crashed'

/** The owner's id in errors about its own model handles. It never goes on the wire. */
export const OWNER_HANDLE_ID = 'owner'

interface SessionRecord {
  opened: Promise<void>
  /** Why the open failed; every later call on the handle fails with it. */
  openError: unknown
  ended: SessionEndReason | undefined
  /**
   * Model ids this session loaded and has not unloaded. Kept after the
   * session ends, so a call naming one of them fails with
   * `ModelHandleInvalidatedError` rather than the plain session error.
   */
  heldModels: Set<string>
}

const sessions = new Map<string, SessionRecord>()

/** Model ids the owner loaded on the running runtime and has not unloaded. */
const ownerModels = new Set<string>()
/**
 * Model ids the owner loaded on a runtime that has since stopped. A call
 * naming one is refused locally until a load returns the same id again.
 */
const invalidOwnerModels = new Set<string>()

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
}

/**
 * Runtime shutdown or worker loss: every open session is gone with it, and so
 * is every model the owner had loaded.
 */
export function endAllSessions(reason: Exclude<SessionEndReason, 'closed'>): void {
  for (const sessionId of sessions.keys()) endSession(sessionId, reason)
  for (const modelId of ownerModels) invalidOwnerModels.add(modelId)
  ownerModels.clear()
}

export function isSessionEnded(sessionId: string): boolean {
  return sessions.get(sessionId)?.ended !== undefined
}

/** A load resolved: the session, or the owner when `sessionId` is undefined, holds the model. */
export function recordHeldModel(sessionId: string | undefined, modelId: string): void {
  if (sessionId === undefined) {
    invalidOwnerModels.delete(modelId)
    ownerModels.add(modelId)
    return
  }
  sessions.get(sessionId)?.heldModels.add(modelId)
}

/** An unload released the caller's lease on the model. */
export function releaseHeldModel(sessionId: string | undefined, modelId: string): void {
  if (sessionId === undefined) {
    ownerModels.delete(modelId)
    return
  }
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

/**
 * Called by the RPC layer before an owner request leaves the process. A model
 * the owner loaded on a runtime that has since stopped is refused here, so
 * the caller learns why the id is dead instead of getting a not-found error
 * from a fresh worker.
 */
export function assertOwnerModelUsable(request: { modelId?: string | undefined }): void {
  const modelId = request.modelId
  if (modelId !== undefined && invalidOwnerModels.has(modelId)) {
    throw new ModelHandleInvalidatedError(modelId, OWNER_HANDLE_ID)
  }
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
  ownerModels.clear()
  invalidOwnerModels.clear()
}
