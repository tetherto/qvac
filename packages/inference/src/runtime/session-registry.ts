import { OwnerOnlyError, SessionIdConflictError, SessionNotOpenError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import { OWNER_SESSION_ID } from '@/runtime/session-id'
import { OWNER_ONLY_OPERATIONS } from '@/schemas/session'

const logger = getEngineLogger()

export interface SessionEntry {
  id: string
  name: string | undefined
  openedAt: Date
}

/**
 * Open caller sessions by id. The owner session is implicit: it is always open,
 * never stored here, and cannot be closed through this module.
 *
 * This module only tracks identity. Cancelling a closing session's requests
 * and releasing its model leases is done by the `closeSession` handler, which
 * owns the ordering between the request registry and the model registry.
 */
const sessions = new Map<string, SessionEntry>()
// Ids whose close is still releasing work, indexes and leases. Leases and
// indexes are keyed by session id, so a session reopened under one of these
// ids would have its resources released by the close still running.
const closingSessions = new Set<string>()
// Work that is not a registered request but must end with its session, such
// as a log subscription.
const closeListeners = new Map<string, Set<() => void>>()

export function openSession(id: string, name?: string): SessionEntry {
  if (id === OWNER_SESSION_ID || sessions.has(id) || closingSessions.has(id)) {
    throw new SessionIdConflictError(id)
  }
  const entry: SessionEntry = { id, name, openedAt: new Date() }
  sessions.set(id, entry)
  logger.info(`Session opened: ${id}${name ? ` (${name})` : ''}`)
  return entry
}

/**
 * Starts closing the session: calls naming it are refused from here on, and
 * its id stays reserved until `finishSessionClose`. The caller cancels its
 * work and releases its leases in between.
 */
export function closeSession(id: string): SessionEntry {
  const entry = sessions.get(id)
  if (!entry) throw new SessionNotOpenError(id)
  sessions.delete(id)
  closingSessions.add(id)
  logger.info(`Session closed: ${id}`)
  const listeners = closeListeners.get(id)
  closeListeners.delete(id)
  for (const listener of listeners ?? []) {
    try {
      listener()
    } catch (error) {
      logger.warn(`Session close listener failed for ${id}:`, error)
    }
  }
  return entry
}

/**
 * Calls `listener` when the session starts closing. Returns a function that
 * removes it. A listener for the owner or a session that is not open is never
 * called, so check `isSessionOpen` first.
 */
export function onSessionClose(id: string, listener: () => void): () => void {
  let listeners = closeListeners.get(id)
  if (!listeners) {
    listeners = new Set()
    closeListeners.set(id, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = closeListeners.get(id)
    current?.delete(listener)
    if (current?.size === 0) closeListeners.delete(id)
  }
}

/** Frees a closed session's id for reuse once its cleanup has finished. */
export function finishSessionClose(id: string): void {
  closingSessions.delete(id)
}

export function isOwnerSession(id: string): boolean {
  return id === OWNER_SESSION_ID
}

export function isSessionOpen(id: string): boolean {
  return isOwnerSession(id) || sessions.has(id)
}

export function assertSessionOpen(id: string): void {
  if (!isSessionOpen(id)) throw new SessionNotOpenError(id)
}

/**
 * The open-session check for a request as it arrived on the wire. A request
 * runs as the owner only by naming no session: the owner id itself is refused
 * so a client cannot act as the owner by sending the string.
 */
export function assertWireSessionOpen(request: { sessionId?: string | undefined }): void {
  if (request.sessionId === OWNER_SESSION_ID) throw new SessionNotOpenError(OWNER_SESSION_ID)
  assertSessionOpen(request.sessionId ?? OWNER_SESSION_ID)
}

export function assertOwnerOperation(request: {
  type: string
  sessionId?: string | undefined
}): void {
  if (request.sessionId !== undefined && OWNER_ONLY_OPERATIONS.has(request.type)) {
    throw new OwnerOnlyError(request.type, request.sessionId)
  }
}

export function listSessions(): SessionEntry[] {
  return Array.from(sessions.values())
}

export function hasOpenSessions(): boolean {
  return sessions.size > 0
}

/** Root shutdown: drop every session record. Work and models are torn down by the engine close path. */
export function clearSessions(): void {
  sessions.clear()
  closingSessions.clear()
  closeListeners.clear()
}
