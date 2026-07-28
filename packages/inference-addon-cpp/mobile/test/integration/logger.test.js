const test = require('brittle')
const addon = require('../../index.js')

// Ported from tests/integration_js/logger/test.js — the C++→JS logger bridge
// tests (setLogger / cppLog / dummyCppLogWork / dummyMultiThreadedCppLogWork /
// releaseLogger). dummyMultiThreadedCppLogWork uses native std::thread (NOT
// bare-thread), so this file is portable to device.
//
// MANUAL PORT — KEEP IN SYNC with the source above. Two deliberate divergences:
//   1. require path: `require('.')` there → `require('../../index.js')` here.
//   2. timeouts are widened — mobile CPUs are slower/jitterier than the desktop
//      runners the original values were tuned for.
// No automated drift-check yet; tracked for phase-2. See ../../README.md.
//
// NOTE: logger's teardown.test.js / reject.test.js are NOT ported — they use
// bare-thread workers loaded by relative path, whose on-device viability
// (worker bundling + bare-thread runtime) is unconfirmed. Tracked as a phase-2
// follow-up pending the first Device Farm dispatch.

// Widened for device (desktop original: 1000ms).
function waitForMessages(messages, count, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (messages.length >= count) return resolve()
      if (Date.now() - start >= timeout) {
        return reject(new Error(`Timed out waiting for ${count} messages`))
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

function assertMessage(t, actual, expected, index) {
  t.is(actual.prio, expected.prio, `message #${index + 1} priority`)
  t.is(actual.msg, expected.msg, `message #${index + 1} text`)
}

test('async C++ to JS logger bridge receives single-thread logs', async (t) => {
  t.timeout(15000)

  const messages = []
  const expected = [
    { prio: 2, msg: 'test msg (this will be logged from cpp)' },
    { prio: 3, msg: 'hello from C++' }
  ]

  t.is(
    addon.setLogger((prio, msg) => {
      messages.push({ prio, msg })
    }),
    undefined,
    'setLogger returns undefined'
  )

  addon.cppLog(expected[0].prio, expected[0].msg)
  addon.dummyCppLogWork()

  await waitForMessages(messages, expected.length)
  expected.forEach((entry, index) => {
    assertMessage(t, messages[index], entry, index)
  })
  addon.releaseLogger()
})

test('async C++ to JS logger bridge receives multi-threaded logs', async (t) => {
  t.timeout(20000)

  const messages = []
  const expectedCount = 40

  t.is(
    addon.setLogger((prio, msg) => {
      messages.push({ prio, msg })
    }),
    undefined,
    'setLogger returns undefined'
  )

  addon.dummyMultiThreadedCppLogWork()
  await waitForMessages(messages, expectedCount)

  t.is(messages.length, expectedCount, 'received every threaded log message')
  for (const [index, message] of messages.entries()) {
    assertMessage(t, message, { prio: 3, msg: 'hello from C++' }, index)
  }
  addon.releaseLogger()
})

test('releaseLogger allows logger to be set again', async (t) => {
  t.timeout(15000)

  const firstMessages = []
  t.is(
    addon.setLogger((prio, msg) => {
      firstMessages.push({ prio, msg })
    }),
    undefined,
    'initial setLogger returns undefined'
  )

  addon.dummyCppLogWork()
  await waitForMessages(firstMessages, 1)
  addon.releaseLogger()

  const secondMessages = []
  t.is(
    addon.setLogger((prio, msg) => {
      secondMessages.push({ prio, msg })
    }),
    undefined,
    'second setLogger returns undefined'
  )

  addon.dummyCppLogWork()
  addon.dummyCppLogWork()
  await waitForMessages(secondMessages, 2)

  for (const [index, message] of secondMessages.entries()) {
    assertMessage(t, message, { prio: 3, msg: 'hello from C++' }, index)
  }
  addon.releaseLogger()
})

// Regression guard for the orphaned-log bug: log() enqueues the entry before it
// verifies that a live owner exists, so a C++ log emitted AFTER releaseLogger()
// (once clearQueueLocked has already run) leaves an orphaned entry in the shared
// queue. setLogger does not clear that queue, so the stale entry bleeds into the
// next owner's callback on the following drain.
test('log emitted between releaseLogger and setLogger does not bleed into the new callback', async (t) => {
  t.timeout(15000)

  const STALE = 'stale-after-release'
  const FRESH = 'fresh-after-reinstall'

  // Install and release an initial owner so the queue-clearing release path runs.
  addon.setLogger((prio, msg) => {})
  addon.releaseLogger()

  // Emit a C++ log while NO logger is installed.
  addon.cppLog(3, STALE)

  // A brand-new owner installs and emits its own fresh log.
  const messages = []
  t.is(
    addon.setLogger((prio, msg) => {
      messages.push({ prio, msg })
    }),
    undefined,
    'new setLogger returns undefined'
  )

  addon.cppLog(3, FRESH)

  await waitForMessages(messages, 1)
  // Give any additional queued entries a chance to be delivered too.
  await new Promise((resolve) => setTimeout(resolve, 50))

  t.absent(
    messages.some((m) => m.msg === STALE),
    'new callback must not receive the orphaned pre-install log'
  )
  t.ok(
    messages.some((m) => m.msg === FRESH),
    'new callback receives its own fresh log'
  )

  addon.releaseLogger()
})

test('setLogger replaces the callback on the same env without releaseLogger', async (t) => {
  t.timeout(15000)

  const firstMessages = []
  t.is(
    addon.setLogger((prio, msg) => {
      firstMessages.push({ prio, msg })
    }),
    undefined,
    'first setLogger returns undefined'
  )

  const secondMessages = []
  t.is(
    addon.setLogger((prio, msg) => {
      secondMessages.push({ prio, msg })
    }),
    undefined,
    'in-place setLogger returns undefined'
  )

  addon.dummyCppLogWork()
  await waitForMessages(secondMessages, 1)

  assertMessage(t, secondMessages[0], { prio: 3, msg: 'hello from C++' }, 0)
  t.is(firstMessages.length, 0, 'replaced callback no longer receives logs')

  addon.releaseLogger()
})
