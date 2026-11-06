import test from 'brittle'
import {
  ENDED_RECORD_CAP,
  assertOwnerModelUsable,
  awaitSessionUsable,
  endAllSessions,
  endSession,
  isModelHeldBySession,
  isSessionEnded,
  OWNER_HANDLE_ID,
  recordHeldModel,
  registerSession,
  releaseHeldModel,
  resetSessionRegistry
} from '@/client/session-registry'
import { ModelHandleInvalidatedError, SessionInvalidatedError } from '@/utils/errors-client'

// The client-side registry decides, before any wire traffic, which typed
// error a call on a dead session or a dead model handle gets.

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

test('session registry: a model a session held keeps its own error after the session ends', async (t) => {
  resetSessionRegistry()
  registerSession('s', Promise.resolve())
  recordHeldModel('s', 'm-held')
  await awaitSessionUsable('s', { modelId: 'm-held' })

  endSession('s', 'crashed')
  t.is(isModelHeldBySession('s', 'm-held'), true, 'the handle still reports what it held')

  const held = await rejection(awaitSessionUsable('s', { modelId: 'm-held' }))
  t.ok(held instanceof ModelHandleInvalidatedError, 'a held model names the model')
  t.is((held as ModelHandleInvalidatedError).modelId, 'm-held')
  t.is((held as ModelHandleInvalidatedError).sessionId, 's')

  const other = await rejection(awaitSessionUsable('s', { modelId: 'm-other' }))
  t.ok(other instanceof SessionInvalidatedError, 'another model gets the session error')
  t.is((other as SessionInvalidatedError).reason, 'crashed')
  const none = await rejection(awaitSessionUsable('s', {}))
  t.ok(none instanceof SessionInvalidatedError, 'so does a call without a model')
})

test('session registry: an unloaded model is not a held model', async (t) => {
  resetSessionRegistry()
  registerSession('s', Promise.resolve())
  recordHeldModel('s', 'm')
  releaseHeldModel('s', 'm')
  t.is(isModelHeldBySession('s', 'm'), false)
  endSession('s', 'closed')
  const error = await rejection(awaitSessionUsable('s', { modelId: 'm' }))
  t.ok(error instanceof SessionInvalidatedError)
  t.is((error as SessionInvalidatedError).reason, 'closed')
})

test('session registry: the first end reason wins', async (t) => {
  resetSessionRegistry()
  registerSession('s', Promise.resolve())
  endSession('s', 'closed')
  endAllSessions('crashed')
  const error = await rejection(awaitSessionUsable('s', {}))
  t.is((error as SessionInvalidatedError).reason, 'closed')
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

test('session registry: ended records are capped, oldest first', async (t) => {
  resetSessionRegistry()
  for (let i = 0; i <= ENDED_RECORD_CAP; i++) {
    registerSession(`s-${i}`, Promise.resolve())
    endSession(`s-${i}`, 'closed')
  }
  t.is(isSessionEnded('s-0'), false, 'the oldest ended record is forgotten')
  await awaitSessionUsable('s-0', {})
  t.is(isSessionEnded('s-1'), true)
  const error = await rejection(awaitSessionUsable(`s-${ENDED_RECORD_CAP}`, {}))
  t.ok(error instanceof SessionInvalidatedError)

  registerSession('s-open', Promise.resolve())
  for (let i = 0; i < ENDED_RECORD_CAP; i++) {
    registerSession(`t-${i}`, Promise.resolve())
    endSession(`t-${i}`, 'crashed')
  }
  await awaitSessionUsable('s-open', {})
  t.pass('an open session is never evicted')
})

test('session registry: a model the owner unloaded before shutdown is not invalidated', (t) => {
  resetSessionRegistry()
  recordHeldModel(undefined, 'm-gone')
  releaseHeldModel(undefined, 'm-gone')
  endAllSessions('shutdown')
  assertOwnerModelUsable({ modelId: 'm-gone' })
  t.pass('an unloaded id is a plain unknown id, not a dead handle')
})
