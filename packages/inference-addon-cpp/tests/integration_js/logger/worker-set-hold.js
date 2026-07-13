// Worker env for reject.test.js. Installs the C++->JS logger and then holds
// ownership alive (parked in Atomics.wait) so the main thread has a genuinely
// concurrent, live second env while it attempts its own setLogger. Once the
// main thread is done asserting, it releases and lets this env exit.
const { self } = require('bare-thread')
const addon = require('.')

const flags = new Int32Array(self.data)
const OWNS = 0
const DONE = 1

addon.setLogger((prio, msg) => {})

// Tell the main thread this env now owns the logger.
Atomics.store(flags, OWNS, 1)
Atomics.notify(flags, OWNS)

// Stay alive (and keep ownership) until the main thread signals completion.
Atomics.wait(flags, DONE, 0)

// Release from this env (same loop as the handle) to avoid a cross-thread close.
addon.releaseLogger()
