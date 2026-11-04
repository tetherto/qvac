import test from 'brittle'
import {
  openSession,
  closeSession,
  assertSessionOpen,
  isSessionOpen,
  hasOpenSessions,
  listSessions,
  clearSessions
} from '@/runtime/session-registry'
import { OWNER_SESSION_ID } from '@/runtime/session-id'
import {
  SessionIdConflictError as SessionIdConflict,
  SessionNotOpenError as SessionNotOpen
} from '@/errors'

const SessionIdConflictError = SessionIdConflict as unknown as new () => Error
const SessionNotOpenError = SessionNotOpen as unknown as new () => Error

test('session registry: open, list, close', (t) => {
  clearSessions()
  t.is(hasOpenSessions(), false)
  const entry = openSession('s-1', 'harness')
  t.is(entry.id, 's-1')
  t.is(entry.name, 'harness')
  t.is(hasOpenSessions(), true)
  t.alike(
    listSessions().map((s) => s.id),
    ['s-1']
  )
  t.is(isSessionOpen('s-1'), true)
  closeSession('s-1')
  t.is(isSessionOpen('s-1'), false)
  t.is(hasOpenSessions(), false)
})

test('session registry: a duplicate id is refused', (t) => {
  clearSessions()
  openSession('dup')
  t.exception(() => openSession('dup'), SessionIdConflictError)
  closeSession('dup')
})

test('session registry: the owner id cannot be opened or closed', (t) => {
  clearSessions()
  t.exception(() => openSession(OWNER_SESSION_ID), SessionIdConflictError)
  t.exception(() => closeSession(OWNER_SESSION_ID), SessionNotOpenError)
  t.is(isSessionOpen(OWNER_SESSION_ID), true, 'the owner is always open')
  assertSessionOpen(OWNER_SESSION_ID)
})

test('session registry: an unknown or closed session fails the open check', (t) => {
  clearSessions()
  t.exception(() => assertSessionOpen('nope'), SessionNotOpenError)
  t.exception(() => closeSession('nope'), SessionNotOpenError)
  openSession('once')
  closeSession('once')
  t.exception(() => assertSessionOpen('once'), SessionNotOpenError)
})

test('session registry: clearSessions drops every record', (t) => {
  openSession('x')
  openSession('y')
  clearSessions()
  t.is(hasOpenSessions(), false)
  t.exception(() => assertSessionOpen('x'), SessionNotOpenError)
})
