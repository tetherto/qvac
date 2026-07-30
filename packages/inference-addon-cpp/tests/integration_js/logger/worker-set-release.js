// Worker env for reject.test.js sequential-handoff case. Installs the logger,
// emits one C++ log, lets the uv_async callback deliver it, then releases and
// exits — the supported sequential reload pattern. Records via shared flags
// whether setLogger succeeded and how many messages its callback received.
const { self } = require('bare-thread')
const addon = require('.')

const flags = new Int32Array(self.data)
const SET_OK = 0
const RECV = 1

try {
  addon.setLogger((prio, msg) => {
    Atomics.add(flags, RECV, 1)
  })
  Atomics.store(flags, SET_OK, 1)
} catch {
  Atomics.store(flags, SET_OK, 2)
}

addon.dummyCppLogWork()

// Give the uv_async callback a loop turn to deliver before releasing + exiting.
setTimeout(() => {
  addon.releaseLogger()
}, 50)
