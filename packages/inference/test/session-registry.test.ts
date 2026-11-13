import test from 'brittle'
import {
  openSession,
  closeSession,
  assertOwnerOperation,
  assertSessionOpen,
  assertWireSessionOpen,
  isSessionOpen,
  hasOpenSessions,
  listSessions,
  clearSessions
} from '@/runtime/session-registry'
import { OWNER_SESSION_ID } from '@/runtime/session-id'
import {
  OwnerOnlyError as OwnerOnly,
  SessionIdConflictError as SessionIdConflict,
  SessionNotOpenError as SessionNotOpen
} from '@/errors'

const OwnerOnlyError = OwnerOnly as unknown as new () => Error
const SessionIdConflictError = SessionIdConflict as unknown as new () => Error
const SessionNotOpenError = SessionNotOpen as unknown as new () => Error

test('session registry: open, list, close', (t) => {
  clearSessions()
  t.is(hasOpenSessions(), false)
  openSession('s-1', 'harness')
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

test('session registry: a wire request runs as the owner only by naming no session', (t) => {
  clearSessions()
  assertWireSessionOpen({})
  assertWireSessionOpen({ sessionId: undefined })
  t.exception(
    () => assertWireSessionOpen({ sessionId: OWNER_SESSION_ID }),
    SessionNotOpenError,
    'the owner id on the wire is refused'
  )
  openSession('s1')
  assertWireSessionOpen({ sessionId: 's1' })
  t.exception(() => assertWireSessionOpen({ sessionId: 's2' }), SessionNotOpenError)
})

test('session registry: an unknown or closed session fails the open check', (t) => {
  clearSessions()
  t.exception(() => assertSessionOpen('nope'), SessionNotOpenError)
  t.exception(() => closeSession('nope'), SessionNotOpenError)
  openSession('once')
  closeSession('once')
  t.exception(() => assertSessionOpen('once'), SessionNotOpenError)
})

test('session registry: runtime-wide operations are refused for a session and allowed for the owner', (t) => {
  assertOwnerOperation({ type: 'suspend' })
  assertOwnerOperation({ type: 'suspend', sessionId: undefined })
  assertOwnerOperation({ type: 'state', sessionId: 's-1' })
  assertOwnerOperation({ type: 'discoverRpcServers', sessionId: 's-1' })
  let refused: unknown
  try {
    assertOwnerOperation({ type: 'suspend', sessionId: 's-1' })
  } catch (error) {
    refused = error
  }
  t.ok(refused instanceof OwnerOnlyError, 'a session suspend is refused')
  t.is((refused as OwnerOnly).operation, 'suspend')
  t.is((refused as OwnerOnly).sessionId, 's-1')
})

test('session registry: clearSessions drops every record', (t) => {
  openSession('x')
  openSession('y')
  clearSessions()
  t.is(hasOpenSessions(), false)
  t.exception(() => assertSessionOpen('x'), SessionNotOpenError)
})
