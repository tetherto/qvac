import test from 'brittle'
import { createRequestRegistry } from '@/runtime/request-registry'
import { OWNER_SESSION_ID } from '@/runtime/session-id'
import { AbortController } from 'bare-abort-controller'
import { RequestIdConflictError, SessionNotOpenError } from '@/errors'
import { getRequestRegistry } from '@/runtime/request-context'
import { closeSession } from '@/runtime/session-registry'
import { openTestSessions } from './fixtures/sessions'

// The registry keys requests by (sessionId, requestId). These tests pin what
// that buys: one session can never reach another session's request, by id or
// by model, and ids only have to be unique within a session.

test('sessions: two sessions may reuse one requestId', async (t) => {
  const r = createRequestRegistry()
  await using a = await r.begin({ requestId: 'shared', sessionId: 'A', kind: 'embeddings' })
  await using b = await r.begin({ requestId: 'shared', sessionId: 'B', kind: 'embeddings' })
  t.is(a.requestId, 'shared')
  t.is(b.requestId, 'shared')
  t.is(a.sessionId, 'A')
  t.is(b.sessionId, 'B')
  t.not(a.registryKey, b.registryKey)
  t.is(r.list().length, 2)
  t.is(r.get('shared', 'A')?.sessionId, 'A')
  t.is(r.get('shared', 'B')?.sessionId, 'B')
  t.is(r.get('shared'), null, 'the owner session has no request with this id')
})

test('sessions: a duplicate id within one session still conflicts', async (t) => {
  const r = createRequestRegistry()
  await using first = await r.begin({ requestId: 'dup', sessionId: 'A', kind: 'embeddings' })
  await t.exception(
    r.begin({ requestId: 'dup', sessionId: 'A', kind: 'embeddings' }),
    RequestIdConflictError as unknown as new () => Error
  )
  t.is(first.state, 'running')
})

test('sessions: a request without a sessionId runs as the owner', async (t) => {
  const r = createRequestRegistry()
  await using ctx = await r.begin({ requestId: 'r', kind: 'embeddings' })
  t.is(ctx.sessionId, OWNER_SESSION_ID)
  t.is(r.cancel({ requestId: 'r' }), 1, 'a cancel without a session targets the owner')
  t.is(ctx.signal.aborted, true)
})

test('sessions: cancel by id from another session is a non-match', async (t) => {
  const r = createRequestRegistry()
  await using a = await r.begin({
    requestId: 'r-1',
    sessionId: 'A',
    kind: 'completion',
    modelId: 'm'
  })

  t.is(r.cancel({ requestId: 'r-1', sessionId: 'B' }), 0)
  t.is(a.signal.aborted, false, 'session A keeps running')
  t.is(a.state, 'running')

  t.is(r.cancel({ requestId: 'r-1', sessionId: 'A' }), 1)
  t.is(a.signal.aborted, true)
})

test('sessions: a cancel-before-begin marker from another session is ignored', async (t) => {
  const r = createRequestRegistry()
  t.is(r.cancel({ requestId: 'early', sessionId: 'B' }), 0)
  await using a = await r.begin({ requestId: 'early', sessionId: 'A', kind: 'embeddings' })
  t.is(a.signal.aborted, false, "B's marker does not abort A's begin")
  await using b = await r.begin({ requestId: 'early', sessionId: 'B', kind: 'embeddings' })
  t.is(b.signal.aborted, true, "B's own begin consumes B's marker")
})

test('sessions: broad cancel by model stays within the caller session', async (t) => {
  const r = createRequestRegistry()
  await using a = await r.begin({
    requestId: 'a',
    sessionId: 'A',
    kind: 'completion',
    modelId: 'm'
  })
  await using b = await r.begin({
    requestId: 'b',
    sessionId: 'B',
    kind: 'completion',
    modelId: 'm'
  })
  await using o = await r.begin({ requestId: 'o', kind: 'completion', modelId: 'm' })

  t.is(r.cancel({ modelId: 'm', sessionId: 'A' }), 1)
  t.is(a.signal.aborted, true)
  t.is(b.signal.aborted, false)
  t.is(o.signal.aborted, false)
})

test('sessions: broad cancel with allSessions reaches every session on the model', async (t) => {
  const r = createRequestRegistry()
  await using a = await r.begin({
    requestId: 'a',
    sessionId: 'A',
    kind: 'completion',
    modelId: 'm'
  })
  await using b = await r.begin({
    requestId: 'b',
    sessionId: 'B',
    kind: 'completion',
    modelId: 'm'
  })
  await using other = await r.begin({
    requestId: 'c',
    sessionId: 'B',
    kind: 'completion',
    modelId: 'other-model'
  })

  t.is(r.cancel({ modelId: 'm', allSessions: true }), 2)
  t.is(a.signal.aborted, true)
  t.is(b.signal.aborted, true)
  t.is(other.signal.aborted, false, 'another model is untouched')
})

test('sessions: broad cancel drains only the caller session queued waiters', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', maxConcurrentPerModel: 1, onOverflow: 'queue' })
  await using holder = await r.begin({
    requestId: 'h',
    sessionId: 'A',
    kind: 'completion',
    modelId: 'm'
  })
  const queuedA = r.begin({ requestId: 'qa', sessionId: 'A', kind: 'completion', modelId: 'm' })
  const queuedB = r.begin({ requestId: 'qb', sessionId: 'B', kind: 'completion', modelId: 'm' })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))

  t.is(r.cancel({ modelId: 'm', sessionId: 'A' }), 2, 'the holder and A queued waiter')
  await using a = await queuedA
  t.is(a.signal.aborted, true)
  await holder[Symbol.asyncDispose]()
  await using b = await queuedB
  t.is(b.signal.aborted, false, "B's waiter is admitted untouched")
})

test('sessions: drainSession cancels every request of one session and waits for disposal', async (t) => {
  const r = createRequestRegistry()
  let disposed = false
  const a = await r.begin({ requestId: 'a1', sessionId: 'A', kind: 'completion', modelId: 'm1' })
  a.scope.defer(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    disposed = true
  })
  const a2 = await r.begin({ requestId: 'a2', sessionId: 'A', kind: 'embeddings', modelId: 'm2' })
  await using b = await r.begin({
    requestId: 'b',
    sessionId: 'B',
    kind: 'completion',
    modelId: 'm1'
  })

  // Handlers dispose their context when the abort lands; the drain waits for that.
  for (const ctx of [a, a2]) {
    ctx.signal.addEventListener('abort', () => {
      void ctx[Symbol.asyncDispose]()
    })
  }
  const cancelled = await r.drainSession('A', 'sessionClosed')
  t.is(cancelled, 2)
  t.is(disposed, true, 'the active request finished disposing before drainSession resolved')
  t.is(a2.signal.aborted, true)
  t.is(b.signal.aborted, false)
  t.is(r.list().filter((ctx) => ctx.sessionId === 'A').length, 0)
  t.is(r.list().filter((ctx) => ctx.sessionId === 'B').length, 1)
})

test('sessions: drainSession cancels a begin that is past admission but not yet registered', async (t) => {
  const r = createRequestRegistry()
  // No policy: admission grants at once, but `begin` still resumes on a later
  // microtask, so the drain runs while the request is in neither the waiter
  // queue nor the active set.
  const pending = r.begin({ requestId: 'late', sessionId: 'A', kind: 'embeddings' })
  const untouched = r.begin({ requestId: 'late', sessionId: 'B', kind: 'embeddings' })
  const drain = r.drainSession('A', 'sessionClosed')

  const ctx = await pending
  t.is(ctx.signal.aborted, true, 'the begin lands as an aborted context')
  t.is(ctx.state, 'cancelling')
  const other = await untouched
  t.is(other.signal.aborted, false, 'another session is not drained')

  let drained = false
  void drain.then(() => {
    drained = true
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.is(drained, false, 'the drain waits for the landed request to dispose')
  await ctx[Symbol.asyncDispose]()
  t.is(await drain, 1)
  t.is(r.list().filter((ctx) => ctx.sessionId === 'A').length, 0)
  await other[Symbol.asyncDispose]()
})

test('sessions: drainSession waits for a queued begin of the session to land and dispose', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', maxConcurrentPerModel: 1, onOverflow: 'queue' })
  const holder = await r.begin({ requestId: 'h', sessionId: 'A', kind: 'completion', modelId: 'm' })
  holder.signal.addEventListener('abort', () => {
    void holder[Symbol.asyncDispose]()
  })
  const queuedA = r.begin({ requestId: 'qa', sessionId: 'A', kind: 'completion', modelId: 'm' })
  const queuedB = r.begin({ requestId: 'qb', sessionId: 'B', kind: 'completion', modelId: 'm' })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))

  const drain = r.drainSession('A', 'sessionClosed')
  const a = await queuedA
  t.is(a.signal.aborted, true, "A's queued begin lands aborted")
  await a[Symbol.asyncDispose]()
  t.is(await drain, 2, 'the holder and the queued begin')
  t.is(holder.signal.aborted, true)
  await using b = await queuedB
  t.is(b.signal.aborted, false, "B's waiter is admitted once the lane frees")
})

test('sessions: a separator inside an id does not reach another session', async (t) => {
  const r = createRequestRegistry()
  await using a = await r.begin({ requestId: 'b\u0000c', sessionId: 'a', kind: 'embeddings' })
  await using b = await r.begin({ requestId: 'c', sessionId: 'a\u0000b', kind: 'embeddings' })
  t.is(r.cancel({ requestId: 'c', sessionId: 'a\u0000b' }), 1)
  t.is(b.signal.aborted, true)
  t.is(a.signal.aborted, false, "the other session's request is untouched")
})

test('sessions: a parent abort pulls a queued child out of admission', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', maxConcurrentPerModel: 1, onOverflow: 'queue' })
  await using holder = await r.begin({ requestId: 'h', kind: 'completion', modelId: 'm' })
  const parent = new AbortController()
  const child = r.begin({
    requestId: 'child',
    sessionId: 'A',
    kind: 'completion',
    modelId: 'm',
    parentSignal: parent.signal
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))

  parent.abort('invokeCancelled')
  await using ctx = await child
  t.is(ctx.signal.aborted, true, 'the child lands aborted while the holder still runs')
  t.is(holder.signal.aborted, false)
  t.is(holder.state, 'running')
})

test('sessions: end() resolves the id within the given session', async (t) => {
  const r = createRequestRegistry()
  const a = await r.begin({ requestId: 'e', sessionId: 'A', kind: 'embeddings' })
  const b = await r.begin({ requestId: 'e', sessionId: 'B', kind: 'embeddings' })
  await r.end('e', 'completed', 'A')
  t.is(a.state, 'completed')
  t.is(b.state, 'running')
  await r.end('e', 'completed', 'B')
  t.is(r.list().length, 0)
})

// A dispatch check that ran before the session closed does not cover work the
// handler begins later, such as a RAG embed, so the worker registry checks the
// session again when a request begins.
test('sessions: the worker registry refuses a request under a closed session', async (t) => {
  const r = getRequestRegistry()
  openTestSessions(t, 'A')
  await using open = await r.begin({
    requestId: 'before-close',
    sessionId: 'A',
    kind: 'embeddings'
  })
  t.is(open.sessionId, 'A')

  closeSession('A')
  await t.exception(
    r.begin({ requestId: 'after-close', sessionId: 'A', kind: 'embeddings' }),
    SessionNotOpenError as unknown as new () => Error
  )
  await t.exception(
    r.begin({ requestId: 'never-opened', sessionId: 'Z', kind: 'embeddings' }),
    SessionNotOpenError as unknown as new () => Error
  )
  await using owner = await r.begin({ requestId: 'owner', kind: 'embeddings' })
  t.is(owner.sessionId, OWNER_SESSION_ID, 'the owner session is always open')
})
