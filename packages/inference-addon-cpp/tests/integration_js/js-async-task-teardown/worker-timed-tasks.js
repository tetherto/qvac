// Worker env entry for the terminate sweep in teardown.test.js: a burst of
// short JsAsyncTasks whose workers finish (uv_async_send) right around the
// moment the main thread terminates this env, so across rounds the send lands
// before, during and after the env teardown begins.
const addon = require('.')

for (let i = 0; i < 8; i++) addon.startTimedTask(1 + i * 3)
