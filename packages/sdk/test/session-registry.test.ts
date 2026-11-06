import test from 'brittle'
import {
  assertOwnerModelUsable,
  awaitSessionUsable,
  bindSession,
  createSessionRecord,
  endAllSessions,
  endSession,
  isModelHeldBySession,
  isSessionEnded,
  OWNER_HANDLE_ID,
  recordHeldModel,
  releaseHeldModel,
  resetSessionRegistry,
  sessionOf
} from '@/client/session-registry'
import { ModelHandleInvalidatedError, SessionInvalidatedError } from '@/utils/errors-client'

// The client-side registry decides, before any wire traffic, which typed
// error a call on a dead session or a dead model handle gets. A session's
// state lives in the record its handle owns; the registry tracks only the
// sessions still open.

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

/** What a session handle does for every call: stamp the id and bind its record. */
function stamped(record: ReturnType<typeof createSessionRecord>) {
  const options = { sessionId: record.sessionId }
  bindSession(options, record)
  return options
}

test('session registry: a model a session held keeps its own error after the session ends', async (t) => {
  resetSessionRegistry()
  const record = createSessionRecord('s', Promise.resolve())
  recordHeldModel(stamped(record), 'm-held')
  await awaitSessionUsable(record, { modelId: 'm-held' })

  endSession(record, 'crashed')
  t.is(isModelHeldBySession(record, 'm-held'), true, 'the handle still reports what it held')

  const held = await rejection(awaitSessionUsable(record, { modelId: 'm-held' }))
  t.ok(held instanceof ModelHandleInvalidatedError, 'a held model names the model')
  t.is((held as ModelHandleInvalidatedError).modelId, 'm-held')
  t.is((held as ModelHandleInvalidatedError).sessionId, 's')

  const other = await rejection(awaitSessionUsable(record, { modelId: 'm-other' }))
  t.ok(other instanceof SessionInvalidatedError, 'another model gets the session error')
  t.is((other as SessionInvalidatedError).reason, 'crashed')
  const none = await rejection(awaitSessionUsable(record, {}))
  t.ok(none instanceof SessionInvalidatedError, 'so does a call without a model')
})

test('session registry: an unloaded model is not a held model', async (t) => {
  resetSessionRegistry()
  const record = createSessionRecord('s', Promise.resolve())
  const options = stamped(record)
  recordHeldModel(options, 'm')
  releaseHeldModel(options, 'm')
  t.is(isModelHeldBySession(record, 'm'), false)
  endSession(record, 'closed')
  const error = await rejection(awaitSessionUsable(record, { modelId: 'm' }))
  t.ok(error instanceof SessionInvalidatedError)
  t.is((error as SessionInvalidatedError).reason, 'closed')
})

test('session registry: the first end reason wins', async (t) => {
  resetSessionRegistry()
  const record = createSessionRecord('s', Promise.resolve())
  endSession(record, 'closed')
  endAllSessions('crashed')
  const error = await rejection(awaitSessionUsable(record, {}))
  t.is((error as SessionInvalidatedError).reason, 'closed')
})

test('session registry: an ended record keeps its state without the registry holding it', async (t) => {
  resetSessionRegistry()
  const closed = createSessionRecord('closed', Promise.resolve())
  endSession(closed, 'closed')
  const open = createSessionRecord('open', Promise.resolve())
  resetSessionRegistry()

  t.is(isSessionEnded(closed), true, 'ended state lives on the record')
  const error = await rejection(awaitSessionUsable(closed, {}))
  t.ok(error instanceof SessionInvalidatedError)
  endAllSessions('crashed')
  t.is(isSessionEnded(open), false, 'a record the registry forgot is no longer ended by shutdown')
})

test('session registry: the record behind a call is found through its options, not its id', (t) => {
  resetSessionRegistry()
  const record = createSessionRecord('s', Promise.resolve())
  const options = stamped(record)
  t.is(sessionOf(options), record)
  t.is(sessionOf({ sessionId: 's' }), undefined, 'a bare sessionId has no local state')
  t.is(sessionOf(undefined), undefined)
  recordHeldModel({ sessionId: 's' }, 'm')
  t.is(isModelHeldBySession(record, 'm'), false, 'a bare sessionId records nothing')
})

test('session registry: owner model handles die with the runtime and revive on reload', (t) => {
  resetSessionRegistry()
  recordHeldModel(undefined, 'm-owner')
  assertOwnerModelUsable({ modelId: 'm-owner' })

  endAllSessions('crashed')
  t.exception(
    () => assertOwnerModelUsable({ modelId: 'm-owner' }),
    ModelHandleInvalidatedError as unknown as new () => Error,
    'the id loaded before the crash is refused'
  )
  try {
    assertOwnerModelUsable({ modelId: 'm-owner' })
  } catch (error) {
    t.is((error as ModelHandleInvalidatedError).modelId, 'm-owner')
    t.is((error as ModelHandleInvalidatedError).sessionId, OWNER_HANDLE_ID)
  }
  assertOwnerModelUsable({ modelId: 'm-never-loaded' })
  assertOwnerModelUsable({})

  recordHeldModel(undefined, 'm-owner')
  assertOwnerModelUsable({ modelId: 'm-owner' })
})

test('session registry: a model the owner unloaded before shutdown is not invalidated', (t) => {
  resetSessionRegistry()
  recordHeldModel(undefined, 'm-gone')
  releaseHeldModel(undefined, 'm-gone')
  endAllSessions('shutdown')
  assertOwnerModelUsable({ modelId: 'm-gone' })
  t.pass('an unloaded id is a plain unknown id, not a dead handle')
})
