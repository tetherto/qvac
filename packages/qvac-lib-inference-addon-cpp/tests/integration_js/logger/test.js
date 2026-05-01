const test = require('brittle')
const addon = require('.')

function waitForMessages (messages, count, timeout = 1000) {
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

function assertMessage (t, actual, expected, index) {
  t.is(actual.prio, expected.prio, `message #${index + 1} priority`)
  t.is(actual.msg, expected.msg, `message #${index + 1} text`)
}

test('async C++ to JS logger bridge receives single-thread logs', async (t) => {
  t.timeout(1000)

  const messages = []
  const expected = [
    { prio: 2, msg: 'test msg (this will be logged from cpp)' },
    { prio: 3, msg: 'hello from C++' }
  ]

  t.is(addon.setLogger((prio, msg) => {
    messages.push({ prio, msg })
  }), undefined, 'setLogger returns undefined')

  addon.cppLog(expected[0].prio, expected[0].msg)
  addon.dummyCppLogWork()

  await waitForMessages(messages, expected.length)
  expected.forEach((entry, index) => {
    assertMessage(t, messages[index], entry, index)
  })
  addon.releaseLogger()
})

test('async C++ to JS logger bridge receives multi-threaded logs', async (t) => {
  t.timeout(2000)

  const messages = []
  const expectedCount = 40

  t.is(addon.setLogger((prio, msg) => {
    messages.push({ prio, msg })
  }), undefined, 'setLogger returns undefined')

  addon.dummyMultiThreadedCppLogWork()
  await waitForMessages(messages, expectedCount)

  t.is(messages.length, expectedCount, 'received every threaded log message')
  for (const [index, message] of messages.entries()) {
    assertMessage(t, message, { prio: 3, msg: 'hello from C++' }, index)
  }
  addon.releaseLogger()
})

test('releaseLogger allows logger to be set again', async (t) => {
  t.timeout(1000)

  const firstMessages = []
  t.is(addon.setLogger((prio, msg) => {
    firstMessages.push({ prio, msg })
  }), undefined, 'initial setLogger returns undefined')

  addon.dummyCppLogWork()
  await waitForMessages(firstMessages, 1)
  addon.releaseLogger()

  const secondMessages = []
  t.is(addon.setLogger((prio, msg) => {
    secondMessages.push({ prio, msg })
  }), undefined, 'second setLogger returns undefined')

  addon.dummyCppLogWork()
  addon.dummyCppLogWork()
  await waitForMessages(secondMessages, 2)

  for (const [index, message] of secondMessages.entries()) {
    assertMessage(t, message, { prio: 3, msg: 'hello from C++' }, index)
  }
  addon.releaseLogger()
})
