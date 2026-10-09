import test from 'brittle'
import env from 'bare-env'
import os from 'bare-os'
import path from 'bare-path'
import { AbortController } from 'bare-abort-controller'
import { stream, close } from '@/dispatch'
import { registerPlugin, clearPlugins } from '@/plugins'
import { ModelType } from '@/schemas'
import type { Request, Response } from '@/schemas'
import { ALL_LOG_ID, getAppLogger } from '@/logging'
import { loggingStream } from '@/api/logging-stream'
import { subscribeServerLogs } from '@/api/subscribe-logs'
import {
  startLoggingStreamForModel,
  stopLoggingStreamForModel,
  hasActiveStreamForModel
} from '@/api/logging-stream-registry'
import {
  clearAllLoggingStreams,
  hasLoggingStreams,
  sendLogToStreams
} from '@/runtime/logging-stream-registry'
import { untilAborted } from '@/utils/until-aborted'
import { makeFakePlugin } from './fixtures/fake-plugin'

// Keep the storage-root lock out of the real home, as in dispatch.test.ts.
env['HOME'] = path.join(os.tmpdir(), `qvac-inference-test-${os.pid()}`)

function setUp() {
  clearPlugins()
  clearAllLoggingStreams()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
}

async function tearDown() {
  await close()
  clearPlugins()
  clearAllLoggingStreams()
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

// Readiness is async, so a subscription registers a few ticks after the first read.
async function waitFor(condition: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) return false
    await tick()
  }
  return true
}

const subscribed = (id: string) => hasLoggingStreams(id) === true

// A read that never settles: the shape of a log stream whose id gets no more logs.
async function* parked(): AsyncGenerator<number> {
  yield 1
  await new Promise<void>(() => {})
}

test('aborting a logging stream parked on a quiet id ends it and releases the subscription', async function (t) {
  setUp()
  try {
    const controller = new AbortController()
    const logs = loggingStream({ id: 'model-a' }, { signal: controller.signal })
    const read = logs.next()

    t.ok(await waitFor(() => subscribed('model-a')), 'the subscription registered')

    controller.abort(new Error('stop'))

    const result = await read
    t.ok(result.done, 'the pending read ends without another log')
    t.absent(subscribed('model-a'), 'the handler unregistered its subscription')
  } finally {
    await tearDown()
  }
})

test('a logging stream delivers logs until it is aborted', async function (t) {
  setUp()
  try {
    const controller = new AbortController()
    const logs = loggingStream({ id: 'model-a' }, { signal: controller.signal })
    const first = logs.next()
    t.ok(await waitFor(() => subscribed('model-a')), 'the subscription registered')

    sendLogToStreams('model-a', 'info', 'llamacpp-completion', 'hello')
    const entry = await first
    t.is(entry.value?.message, 'hello', 'a log arrives while the signal is live')

    controller.abort(new Error('stop'))
    t.ok((await logs.next()).done, 'the next read ends')
    t.absent(subscribed('model-a'), 'the subscription is released')
  } finally {
    await tearDown()
  }
})

test('a logging stream with an aborted signal opens no subscription', async function (t) {
  setUp()
  try {
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    const logs = loggingStream({ id: 'model-a' }, { signal: controller.signal })

    t.ok((await logs.next()).done, 'the stream ends at once')
    await tick()
    t.absent(subscribed('model-a'), 'nothing registered')
  } finally {
    await tearDown()
  }
})

test('the unsubscribe from subscribeServerLogs releases the subscription without another log', async function (t) {
  setUp()
  try {
    const unsubscribe = subscribeServerLogs(() => {})
    t.ok(await waitFor(() => subscribed(ALL_LOG_ID)), 'the global subscription registered')

    unsubscribe()

    t.ok(await waitFor(() => !subscribed(ALL_LOG_ID)), 'the global subscription is released')
  } finally {
    await tearDown()
  }
})

test('stopping a model log stream releases its subscription', async function (t) {
  setUp()
  try {
    startLoggingStreamForModel('model-b', getAppLogger())
    t.ok(await waitFor(() => subscribed('model-b')), 'the model subscription registered')

    stopLoggingStreamForModel('model-b')

    t.absent(hasActiveStreamForModel('model-b'), 'the model has no active stream')
    t.ok(await waitFor(() => !subscribed('model-b')), 'the model subscription is released')
  } finally {
    await tearDown()
  }
})

test('a model log stream restarted under the same id survives the old one ending', async function (t) {
  setUp()
  try {
    startLoggingStreamForModel('model-b', getAppLogger())
    t.ok(await waitFor(() => subscribed('model-b')), 'the first subscription registered')

    stopLoggingStreamForModel('model-b')
    startLoggingStreamForModel('model-b', getAppLogger())
    // Let the first stream finish and run its cleanup.
    await tick()
    await tick()

    t.ok(hasActiveStreamForModel('model-b'), 'the restarted stream is still tracked')
    stopLoggingStreamForModel('model-b')
    t.ok(await waitFor(() => !subscribed('model-b')), 'and it can still be stopped')
  } finally {
    await tearDown()
  }
})

test('stream with a signal still runs a reply handler', async function (t) {
  setUp()
  try {
    const controller = new AbortController()
    const responses: Response[] = []
    for await (const response of stream({ type: 'heartbeat' } as unknown as Request, {
      signal: controller.signal
    })) {
      responses.push(response)
    }
    t.is(responses.length, 1, 'one response')
    t.is(responses[0]?.type, 'heartbeat', 'from the reply handler')
  } finally {
    await tearDown()
  }
})

test('untilAborted ends a source parked on a read that never settles', async function (t) {
  const controller = new AbortController()
  const values = untilAborted(parked(), controller.signal)

  t.is((await values.next()).value, 1, 'values pass through')
  const read = values.next()
  controller.abort(new Error('stop'))
  t.ok((await read).done, 'the parked read ends on abort')
})

test('untilAborted rethrows a source error while the signal is live', async function (t) {
  const controller = new AbortController()
  async function* failing(): AsyncGenerator<number> {
    yield 1
    throw new Error('source failed')
  }
  const values = untilAborted(failing(), controller.signal)

  await values.next()
  await t.exception(() => values.next(), /source failed/, 'the error reaches the caller')
})

test('untilAborted drops a source error that arrives after the abort', async function (t) {
  const controller = new AbortController()
  let fail: (error: Error) => void = () => {}
  async function* failsLater(): AsyncGenerator<number> {
    await new Promise<void>((_resolve, reject) => {
      fail = reject
    })
    yield 1
  }
  const values = untilAborted(failsLater(), controller.signal)

  const read = values.next()
  await tick()
  controller.abort(new Error('stop'))
  t.ok((await read).done, 'the read ends on abort')

  fail(new Error('late failure'))
  await tick()
  t.pass('the late rejection is handled, not left unhandled')
})

test('untilAborted without a signal is the source', async function (t) {
  async function* three(): AsyncGenerator<number> {
    yield 1
    yield 2
    yield 3
  }
  const values: number[] = []
  for await (const value of untilAborted(three(), undefined)) values.push(value)
  t.alike(values, [1, 2, 3])
})
