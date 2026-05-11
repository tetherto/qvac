const test = require('brittle')
const addon = require('.')

// waitFor(fn, timeoutMs) will poll fn() until it returns truthy or timeout
function waitFor(fn, timeout = 1000, interval = 10) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (fn()) {
        console.log("FN")
        return resolve()
      }
      if (Date.now() - start >= timeout) {
        return reject(new Error(`Timed out after ${timeout}ms`))
      }
      setTimeout(tick, interval)
    }
    tick()
  })
}

test('async C++ → JS logger bridge, single thread scenario, 2 logs', async (t) => {
  t.timeout(1000)

  let resolveAll, count = 0
  let cppMsgPrio = 2
  let cppMsgTxt = 'test msg (this will be logged from cpp)'
  const expected = [
    {prio: cppMsgPrio, msg: cppMsgTxt},
    {prio: 3, msg: 'hello from C++'}
  ]
  numOfMsg = expected.length
  t.plan(1 + numOfMsg * 2)

  const allReceived = new Promise(r => {
    resolveAll = r
  })

  t.is(
    addon.setLogger((prio, msg) => {
      console.log("count: %d", count)
      t.is(prio, expected[count].prio, `message #${count + 1} prio`)
      t.is(msg, expected[count].msg, `message #${count + 1} text`)
      count += 1
      resolveAll()
      console.log("after resolveAll(), count: %d", count)
    }),
    undefined,
    'setLogger returns undefined'
  )

  addon.cppLog(cppMsgPrio, cppMsgTxt)
  addon.dummyCppLogWork()

  await allReceived
  addon.releaseLogger()
})

test('async C++ → JS logger bridge, multi thread scenario (4 threads) * 10 logs', async (t) => {
  t.timeout(1000)

  let resolveAll, count = 0
  const expected = [
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},

    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},

    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},

    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'}
  ]
  numOfMsg = expected.length
  t.plan(1 + numOfMsg * 2)

  const allReceived = new Promise(r => {
    resolveAll = r
  })

  t.is(
    addon.setLogger((prio, msg) => {
      console.log("cout: %d", count)
      t.is(prio, expected[count].prio, `message #${count + 1} prio`)
      t.is(msg, expected[count].msg, `message #${count + 1} text`)
      count += 1
      resolveAll()
      console.log("after resolveAll(), count: %d", count)
    }),
    undefined,
    'setLogger returns undefined'
  )

  addon.dummyMultiThreadedCppLogWork()


  await allReceived
  addon.releaseLogger()
})

test('async C++ → JS logger bridge, releaseLogger, single thread scenario, 2 logs', async (t) => {
  t.timeout(1000)

  let resolveAll, count = 0
  const expected1 = [
    {prio: 3, msg: 'hello from C++'}
  ]
  const expected2 = [
    {prio: 3, msg: 'hello from C++'},
    {prio: 3, msg: 'hello from C++'}
  ]
  numOfMsg = expected1.length + expected2.length
  t.plan(1 + numOfMsg * 2)

  const allReceived1 = new Promise(r => {
    resolveAll = r
  })
  t.is(
    addon.setLogger((prio, msg) => {
      console.log("cout: %d", count)
      t.is(prio, expected1[count].prio, `message #${count + 1} prio`)
      count += 1
      resolveAll()
      console.log("after resolveAll(), count: %d", count)
    }),
    undefined,
    'setLogger returns undefined'
  )

  addon.dummyCppLogWork()

  await allReceived1
  addon.releaseLogger()

  const allReceived2 = new Promise(r => {
    resolveAll = r
  })
  count = 0
  t.is(
    addon.setLogger((prio, msg) => {
      console.log("cout: %d", count)
      t.is(prio, expected2[count].prio, `message #${count + 1} prio`)
      t.is(msg, expected2[count].msg, `message #${count + 1} text`)
      count += 1
      resolveAll()
      console.log("after resolveAll(), count: %d", count)
    }),
    undefined,
    'setLogger returns undefined'
  )

  addon.dummyCppLogWork()
  addon.dummyCppLogWork()

  await allReceived2
  addon.releaseLogger()
})

