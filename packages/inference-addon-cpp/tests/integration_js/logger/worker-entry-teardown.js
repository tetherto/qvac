// Worker runtime entry. Mirrors nmtcpp during a Keet worker teardown: install
// the C++->JS logger, then kick off background (non-JS-thread) logging so those
// threads keep calling JsLogger::log (uv_async_send) while the main thread tears
// this worker runtime down. We never call releaseLogger() — the teardown path
// is responsible for cleanup.
const addon = require('.')

addon.setLogger((prio, msg) => {})

// Several rounds widen the window during which a background thread's
// uv_async_send can land right as bare_runtime_teardown runs its final uv_run.
for (let i = 0; i < 20; i++) addon.dummyMultiThreadedCppLogWork()
