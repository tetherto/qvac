// AUTO-GENERATED FROM THE DESKTOP SUITE — DO NOT EDIT.
//
// Source: tests/integration_js/logger/worker-entry-teardown.js
// Regenerate: npm run test:mobile:generate   (verify: npm run test:mobile:validate)
//
// Only mechanical change from the source: `require('.')` is repointed at the
// unified mobile addon, because the mobile harness runs one aggregated addon
// instead of the three standalone desktop sub-packages.
// Worker runtime entry. Mirrors nmtcpp during a Keet worker teardown: install
// the C++->JS logger, then kick off background (non-JS-thread) logging so those
// threads keep calling JsLogger::log (uv_async_send) while the main thread tears
// this worker runtime down. We never call releaseLogger() — the teardown path
// is responsible for cleanup.
const addon = require('../../../index.js')

addon.setLogger((prio, msg) => {})

// Several rounds widen the window during which a background thread's
// uv_async_send can land right as bare_runtime_teardown runs its final uv_run.
for (let i = 0; i < 20; i++) addon.dummyMultiThreadedCppLogWork()
