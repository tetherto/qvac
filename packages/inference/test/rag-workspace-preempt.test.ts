import test from 'brittle'
import {
  getActiveRagRequest,
  setActiveRagRequest,
  clearActiveRagRequest
} from '@/rag/rag-operation-manager'
import { OWNER_SESSION_ID } from '@/runtime/session-id'
import { beginRagContext } from '@/rag/handler'
import { RAGWorkspaceBusyError, RequestIdConflictError } from '@/errors/index'
import { openTestSessions } from './fixtures/sessions'

// -----------------------------------------------------------------------------
// RAG workspace → requestId map.
//
// The dispatcher-level pre-emption rule in `server/rpc/handlers/rag.ts`
// (cancel any existing RAG request on the same workspace before
// beginning a new one) is built on three small helpers in
// `rag-operation-manager.ts`:
//
//   - `getActiveRagRequest(workspace)` — returns the currently-tracked
//     `requestId` (or `undefined`)
//   - `setActiveRagRequest(workspace, requestId)` — replaces it
//   - `clearActiveRagRequest(workspace, requestId)` — clears iff the
//     map still holds the same id (the "still mine?" guard)
//
// The "still mine?" guard is what makes pre-emption safe: an older
// op's scope-deferred cleanup must not wipe out a newer op's mapping.
// These tests pin that contract in isolation from the registry so a
// refactor that loses the guard will fail here before the integration
// surface breaks.
// -----------------------------------------------------------------------------

const WS = 'ws-test'
const WS_OTHER = 'ws-other'

const req = (requestId: string, sessionId: string = OWNER_SESSION_ID) => ({ requestId, sessionId })

test('rag workspace map: get returns undefined before set', (t) => {
  clearActiveRagRequest(WS, req('unused'))
  t.is(getActiveRagRequest(WS), undefined)
})

test('rag workspace map: set / get round-trip', (t) => {
  setActiveRagRequest(WS, req('r-1'))
  t.alike(getActiveRagRequest(WS), req('r-1'))
  clearActiveRagRequest(WS, req('r-1'))
  t.is(getActiveRagRequest(WS), undefined)
})

test('rag workspace map: set replaces (pre-emption write path)', (t) => {
  setActiveRagRequest(WS, req('r-1'))
  setActiveRagRequest(WS, req('r-2'))
  t.alike(getActiveRagRequest(WS), req('r-2'), 'newer requestId replaces the older')
  clearActiveRagRequest(WS, req('r-2'))
})

test('rag workspace map: clear is a no-op for stale requestId (still-mine guard)', (t) => {
  setActiveRagRequest(WS, req('r-current'))
  // Older op's scope unwind fires after a newer op has already
  // installed its mapping. The stale clear must not stomp.
  clearActiveRagRequest(WS, req('r-stale'))
  t.alike(
    getActiveRagRequest(WS),
    req('r-current'),
    'stale clear leaves the current mapping intact'
  )
  clearActiveRagRequest(WS, req('r-current'))
})

test('rag workspace map: the same requestId in another session is a different request', (t) => {
  setActiveRagRequest(WS, req('r-1', 'A'))
  clearActiveRagRequest(WS, req('r-1', 'B'))
  t.alike(getActiveRagRequest(WS), req('r-1', 'A'), "B's clear leaves A's mapping intact")
  clearActiveRagRequest(WS, req('r-1', 'A'))
  t.is(getActiveRagRequest(WS), undefined)
})

test('rag workspace map: workspaces are isolated', (t) => {
  setActiveRagRequest(WS, req('r-a'))
  setActiveRagRequest(WS_OTHER, req('r-b'))
  t.alike(getActiveRagRequest(WS), req('r-a'))
  t.alike(getActiveRagRequest(WS_OTHER), req('r-b'))
  clearActiveRagRequest(WS, req('r-a'))
  t.is(getActiveRagRequest(WS), undefined)
  t.alike(
    getActiveRagRequest(WS_OTHER),
    req('r-b'),
    'clearing one workspace must not touch the other'
  )
  clearActiveRagRequest(WS_OTHER, req('r-b'))
})

// A workspace is shared, so a new operation pre-empts the running one. A
// session may pre-empt only its own operation; the owner may pre-empt any.

test('rag workspace: a session is refused while another session operates on the workspace', async (t) => {
  openTestSessions(t, 'B')
  const running = await beginRagContext(WS, { requestId: 'owner-ingest' })
  await t.exception(
    beginRagContext(WS, { requestId: 'b-ingest', sessionId: 'B' }),
    RAGWorkspaceBusyError as unknown as new () => Error
  )
  t.is(running.signal.aborted, false, "the owner's operation keeps running")
  await running[Symbol.asyncDispose]()
})

test('rag workspace: two sessions starting at once do not both get the workspace', async (t) => {
  openTestSessions(t, 'A', 'B')
  const first = beginRagContext(WS, { requestId: 'a-0', sessionId: 'A' })
  const second = beginRagContext(WS, { requestId: 'b-0', sessionId: 'B' })
  await t.exception(second, RAGWorkspaceBusyError as unknown as new () => Error)
  const running = await first
  t.is(running.signal.aborted, false)
  t.alike(getActiveRagRequest(WS), req('a-0', 'A'))
  await running[Symbol.asyncDispose]()
})

test('rag workspace: a resent request id keeps the running operation on the workspace', async (t) => {
  openTestSessions(t, 'A', 'B')
  const running = await beginRagContext(WS, { requestId: 'a-dup', sessionId: 'A' })
  await t.exception(
    beginRagContext(WS, { requestId: 'a-dup', sessionId: 'A' }),
    RequestIdConflictError as unknown as new () => Error
  )
  t.alike(getActiveRagRequest(WS), req('a-dup', 'A'), 'the workspace still names the running one')
  await t.exception(
    beginRagContext(WS, { requestId: 'b-dup', sessionId: 'B' }),
    RAGWorkspaceBusyError as unknown as new () => Error,
    'another session is still refused'
  )
  t.is(running.signal.aborted, false)
  await running[Symbol.asyncDispose]()
})

test('rag workspace: a session pre-empts its own earlier operation', async (t) => {
  openTestSessions(t, 'A')
  const first = await beginRagContext(WS, { requestId: 'a-1', sessionId: 'A' })
  const second = await beginRagContext(WS, { requestId: 'a-2', sessionId: 'A' })
  t.is(first.signal.aborted, true)
  t.alike(getActiveRagRequest(WS), req('a-2', 'A'))
  await first[Symbol.asyncDispose]()
  await second[Symbol.asyncDispose]()
})

test("rag workspace: the owner pre-empts a session's operation", async (t) => {
  openTestSessions(t, 'A')
  const session = await beginRagContext(WS, { requestId: 'a-3', sessionId: 'A' })
  const owner = await beginRagContext(WS, { requestId: 'owner-reindex' })
  t.is(session.signal.aborted, true)
  t.alike(getActiveRagRequest(WS), req('owner-reindex'))
  await session[Symbol.asyncDispose]()
  await owner[Symbol.asyncDispose]()
})
