'use strict'

// Integration tests that must NOT be mirrored into the generated mobile suite.
//
// The mobile test framework (tetherto/qvac-test-addon-mobile) copies the whole
// test/ tree into its own backend/ directory, emits a static
// `require('./test/integration/<file>')` for every entry listed in
// test/mobile/integration.auto.cjs, and then bundles with bare-pack. bare-pack
// resolves those requires eagerly, including ones nested inside test bodies.
//
// It shims only the public entry points into backend/ — index.js, binding.js,
// addon.js (and addonLogging.js when present). A test reaching
// ../../binding-internal.js therefore resolves to backend/binding-internal.js,
// which nothing creates, and the whole mobile app build fails with
// MODULE_NOT_FOUND before any device is involved. The private surface is
// packaged but deliberately absent from `exports` (see the invariant asserted in
// test/desktop/llama-config.test.js), so it cannot be reached by package name
// either.
//
// Excluded files still run on desktop: test:integration:suite globs
// test/integration/*.test.js independently of this list.
//
// Keep this module dependency-free and free of fs/path use — it is loaded by
// generate-mobile-integration-tests.js under `bare` and by
// validate-mobile-tests.js under `node`.
module.exports = ['fit-internal.test.js']
