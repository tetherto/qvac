// Worker env entry for teardown.test.js. Posts a gated task to the serial
// executor, then a second task that has to wait behind it, and leaves both
// promises unawaited so the main test env can terminate() this env while the
// second task is still queued.
const addon = require('.')

addon.startGatedTaskOn()
addon.startCountedTaskOn()
