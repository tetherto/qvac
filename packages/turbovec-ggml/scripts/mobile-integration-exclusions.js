'use strict'

// Integration tests that must NOT be mirrored into the generated mobile suite.
//
// The mobile test framework (tetherto/qvac-test-addon-mobile) copies the whole
// test/ tree into its own backend/ directory, emits a static
// `require('./test/integration/<file>')` for every entry listed in
// test/mobile/integration.auto.cjs, and then bundles with bare-pack. bare-pack
// resolves those requires eagerly, including ones nested inside skipped tests.
//
// The framework installs only its own dependencies plus the addon's runtime
// `dependencies`, so a test requiring a devDependency the framework lacks
// (bare-thread, bare-abort-controller) fails the whole mobile app build with
// MODULE_NOT_FOUND before any device is involved.
//
// Excluded files still run on desktop: test:integration:generate globs
// test/integration/*.test.js independently of this list.
//
// Keep this module dependency-free and free of fs/path use — it is loaded by
// generate-mobile-integration-tests.js under `bare` and by
// validate-mobile-tests.js under `node`.
module.exports = ['id-map-index-desktop.test.js']
