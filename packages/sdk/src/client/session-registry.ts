import type { RPCOptions } from '@qvac/inference/surface'
import { ModelHandleInvalidatedError, SessionInvalidatedError } from '@/utils/errors-client'

/**
 * Client-side state of the session handles this process opened, and of the
 * models the owner loaded. The RPC layer consults it on each request: a
 * session-stamped request waits for its session's `openSession` round trip,
 * and a request on a session that was closed, shut down with the runtime or
 * lost with the worker is refused locally with a typed error instead of
 * reaching the wire. An owner request naming a model that was loaded before
 * the runtime stopped is refused the same way until the model is loaded again.
 *
 * A session's state lives in its record, which the handle owns and binds to
 * the options of every call it makes. The registry itself only tracks the
 * sessions that are still open, so it needs no cap: an ended session's record
 * goes away with its handle.
 */

export type SessionEndReason = 'closed' | 'shutdown' | 'crashed'

/** The owner's id in errors about its own model handles. It never goes on the wire. */
export const OWNER_HANDLE_ID = 'owner'

export interface SessionRecord {
  readonly sessionId: string
  readonly opened: Promise<void>
  /** Why the open failed; every later call on the handle fails with it. */
  openError: unknown
  ended: SessionEndReason | undefined
  /**
   * Model ids this session loaded and has not unloaded. Kept after the
   * session ends, so a call naming one of them fails with
   * `ModelHandleInvalidatedError` rather than the plain session error.
   */
  readonly heldModels: Set<string>
}

/** Sessions that have not ended; runtime shutdown and worker loss end them all. */
const openSessions = new Set<SessionRecord>()

/**
 * The record behind a call's options rides on the options object under a
 * symbol key, so the RPC layer finds the session's state without a lookup by
 * id that would have to outlive the handle. A symbol-keyed own property
 * survives the spreads the API functions make of their options and never
 * reaches JSON.
 */
const SESSION_RECORD: unique symbol = Symbol('qvac.sessionRecord')

interface BoundOptions {
  [SESSION_RECORD]?: SessionRecord
}

/** Model ids the owner loaded on the running runtime and has not unloaded. */
const ownerModels = new Set<string>()
/**
 * Model ids the owner loaded on a runtime that has since stopped. A call
 * naming one is refused locally until a load returns the same id again.
 */
const invalidOwnerModels = new Set<string>()

export function createSessionRecord(sessionId: string, opened: Promise<void>): SessionRecord {
  const record: SessionRecord = {
    sessionId,
    opened,
    openError: undefined,
    ended: undefined,
    heldModels: new Set()
  }
  // A session the worker refused never opened: the handle keeps the error for
  // its later calls, and the registry lets the record go.
  opened.catch((error: unknown) => {
    record.openError = error
    openSessions.delete(record)
  })
  openSessions.add(record)
  return record
}

export function endSession(record: SessionRecord, reason: SessionEndReason): void {
  openSessions.delete(record)
  if (record.ended === undefined) record.ended = reason
}

/**
 * Runtime shutdown or worker loss: every open session is gone with it, and so
 * is every model the owner had loaded.
 */
export function endAllSessions(reason: Exclude<SessionEndReason, 'closed'>): void {
  for (const record of openSessions) endSession(record, reason)
  for (const modelId of ownerModels) invalidOwnerModels.add(modelId)
  ownerModels.clear()
}

/**
 * Whether this client has a session open or still opening. A session counts
 * from `openSession()`, before the worker has registered it; one whose open
 * failed does not.
 */
export function hasClientSessions(): boolean {
  for (const record of openSessions) {
    if (record.openError === undefined) return true
  }
  return false
}

export function isSessionEnded(record: SessionRecord): boolean {
  return record.ended !== undefined
}

/** Binds the session behind a call's options; the handle calls it for every option object it stamps. */
export function bindSession(options: object, record: SessionRecord): void {
  ;(options as BoundOptions)[SESSION_RECORD] = record
}

/** The session behind a call's options, or undefined for an owner call or a bare `sessionId`. */
export function sessionOf(options: RPCOptions | undefined): SessionRecord | undefined {
  return options === undefined ? undefined : (options as BoundOptions)[SESSION_RECORD]
}

/** A load resolved: the session behind the options, or the owner when there is no `sessionId`, holds the model. */
export function recordHeldModel(options: RPCOptions | undefined, modelId: string): void {
  if (options?.sessionId === undefined) {
    invalidOwnerModels.delete(modelId)
    ownerModels.add(modelId)
    return
  }
  sessionOf(options)?.heldModels.add(modelId)
}

/** An unload released the caller's lease on the model. */
export function releaseHeldModel(options: RPCOptions | undefined, modelId: string): void {
  if (options?.sessionId === undefined) {
    ownerModels.delete(modelId)
    return
  }
  sessionOf(options)?.heldModels.delete(modelId)
}

export function isModelHeldBySession(record: SessionRecord, modelId: string): boolean {
  return record.heldModels.has(modelId)
}

/**
 * Called by the RPC layer before a session-stamped request leaves the
 * process. Resolves once the session is open on the worker; rejects with the
 * typed local error when the session can no longer be used.
 */
export async function awaitSessionUsable(
  record: SessionRecord,
  request: { modelId?: string | undefined }
): Promise<void> {
  assertSessionUsable(record, request)
  await record.opened
  assertSessionUsable(record, request)
}

/** The check `awaitSessionUsable` makes, without waiting for the open. */
export function assertSessionUsable(
  record: SessionRecord,
  request: { modelId?: string | undefined }
): void {
  if (record.openError !== undefined) throw record.openError
  if (record.ended !== undefined) throw endedError(record, request.modelId)
}

/**
 * Called by the RPC layer before an owner request leaves the process. A model
 * the owner loaded on a runtime that has since stopped is refused here, so
 * the caller learns why the id is dead instead of getting a not-found error
 * from a fresh worker.
 */
// Requests whose `modelId` does not need the model loaded: `deleteCache` uses
// it only to locate cache files on disk, and a `cancel` by model on a runtime
// that no longer has the model finds nothing to cancel.
const OWNER_REQUESTS_WITHOUT_MODEL_HANDLE: ReadonlySet<string> = new Set(['deleteCache', 'cancel'])

export function assertOwnerModelUsable(request: {
  type: string
  modelId?: string | undefined
}): void {
  if (OWNER_REQUESTS_WITHOUT_MODEL_HANDLE.has(request.type)) return
  const modelId = request.modelId
  if (modelId !== undefined && invalidOwnerModels.has(modelId)) {
    throw new ModelHandleInvalidatedError(modelId, OWNER_HANDLE_ID)
  }
}

function endedError(record: SessionRecord, modelId: string | undefined): Error {
  const reason = record.ended ?? 'closed'
  if (modelId !== undefined && record.heldModels.has(modelId)) {
    return new ModelHandleInvalidatedError(modelId, record.sessionId)
  }
  return new SessionInvalidatedError(record.sessionId, reason)
}

/** Test seam: the number of sessions the registry tracks as open or opening. */
export function trackedSessionCount(): number {
  return openSessions.size
}

/** Test seam: forget every open session and owner model. */
export function resetSessionRegistry(): void {
  openSessions.clear()
  ownerModels.clear()
  invalidOwnerModels.clear()
}
