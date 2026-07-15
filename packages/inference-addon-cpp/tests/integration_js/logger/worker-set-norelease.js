// Worker env for reject.test.js teardown-without-release case. Installs the
// logger and logs once, then deliberately never calls releaseLogger. The live
// uv_async handle keeps the loop alive so the env stays owning until the main
// thread terminates it — exercising env teardown (onEnvTeardown) without an
// explicit release.
const { self } = require('bare-thread')
const addon = require('.')

const flags = new Int32Array(self.data)
const OWNS = 0

addon.setLogger((prio, msg) => {})
addon.dummyCppLogWork()

// Signal the main thread that this env owns the logger; then just keep running
// (no releaseLogger) until the main thread terminates us.
Atomics.store(flags, OWNS, 1)
Atomics.notify(flags, OWNS)
