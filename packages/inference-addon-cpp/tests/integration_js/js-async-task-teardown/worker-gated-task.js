// Worker env entry for teardown.test.js. Starts a JsAsyncTask whose C++ work
// parks on a gate the main test env controls, then leaves this env idle so the
// main thread can terminate() it while the worker is provably still inside its
// work. The returned promise is deliberately abandoned: this env dies before
// settlement, which is exactly the path the teardown guard must survive.
const addon = require('.')

addon.startGatedTask()
