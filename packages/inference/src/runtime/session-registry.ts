import { SessionIdConflictError, SessionNotOpenError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import { OWNER_SESSION_ID } from '@/runtime/session-id'

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

export function openSession(id: string, name?: string): SessionEntry {
  if (id === OWNER_SESSION_ID || sessions.has(id)) {
    throw new SessionIdConflictError(id)
  }
  const entry: SessionEntry = { id, name, openedAt: new Date() }
  sessions.set(id, entry)
  logger.info(`Session opened: ${id}${name ? ` (${name})` : ''}`)
  return entry
}

/** Removes the session. The caller cancels its work and releases its leases first. */
export function closeSession(id: string): SessionEntry {
  const entry = sessions.get(id)
  if (!entry) throw new SessionNotOpenError(id)
  sessions.delete(id)
  logger.info(`Session closed: ${id}`)
  return entry
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

export function listSessions(): SessionEntry[] {
  return Array.from(sessions.values())
}

export function hasOpenSessions(): boolean {
  return sessions.size > 0
}

/** Root shutdown: drop every session record. Work and models are torn down by the engine close path. */
export function clearSessions(): void {
  sessions.clear()
}
