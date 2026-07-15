// Worker env for reject.test.js owner-guard case. Installs the logger, then
// waits while the main (non-owner) env attempts releaseLogger. Once released is
// signalled, it emits a log and records via shared flags whether its callback
// still fires — proving the non-owner release did not disarm this owner.
const { self } = require('bare-thread')
const addon = require('.')

const flags = new Int32Array(self.data)
const OWNS = 0
const RELEASED = 1
const RECV = 2

addon.setLogger((prio, msg) => {
  Atomics.add(flags, RECV, 1)
})

// Tell the main thread this env now owns the logger.
Atomics.store(flags, OWNS, 1)
Atomics.notify(flags, OWNS)

// Wait until the main (non-owner) env has attempted its releaseLogger.
Atomics.wait(flags, RELEASED, 0)

// If the owner guard held, we still own the logger and this delivers.
addon.dummyCppLogWork()

// Give the uv_async callback a loop turn to deliver before releasing + exiting.
setTimeout(() => {
  addon.releaseLogger()
}, 50)
