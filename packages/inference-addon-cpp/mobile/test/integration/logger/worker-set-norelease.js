// AUTO-GENERATED FROM THE DESKTOP SUITE — DO NOT EDIT.
//
// Source: tests/integration_js/logger/worker-set-norelease.js
// Regenerate: npm run test:mobile:generate   (verify: npm run test:mobile:validate)
//
// Only mechanical change from the source: `require('.')` is repointed at the
// unified mobile addon, because the mobile harness runs one aggregated addon
// instead of the three standalone desktop sub-packages.
// Worker env for reject.test.js teardown-without-release case. Installs the
// logger and logs once, then deliberately never calls releaseLogger. The live
// uv_async handle keeps the loop alive so the env stays owning until the main
// thread terminates it — exercising env teardown (onEnvTeardown) without an
// explicit release.
const { self } = require('bare-thread')
const addon = require('../../../index.js')

const flags = new Int32Array(self.data)
const OWNS = 0

addon.setLogger((prio, msg) => {})
addon.dummyCppLogWork()

// Signal the main thread that this env owns the logger; then just keep running
// (no releaseLogger) until the main thread terminates us.
Atomics.store(flags, OWNS, 1)
Atomics.notify(flags, OWNS)
