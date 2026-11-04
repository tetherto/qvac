import test from 'brittle'
import {
  getActiveRagRequest,
  setActiveRagRequest,
  clearActiveRagRequest
} from '@/rag/rag-operation-manager'
import { OWNER_SESSION_ID } from '@/runtime/session-id'

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
