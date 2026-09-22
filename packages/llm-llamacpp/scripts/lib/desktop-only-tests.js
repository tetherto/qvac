'use strict'

// Integration tests that must not enter the mobile bundle at all.
//
// A generated runner is not merely a skipped test on device: bare-pack walks
// the bundle's require graph, so a desktop-only test's imports become native
// dependencies the mobile app has to link. load-mode.test.js measures each
// mode in its own process via bare-subprocess, which pulls bare-type —
// unlinked on Android, where it failed all 18 devices with ADDON_NOT_FOUND
// before any test body ran. `skip: isMobile` cannot prevent that; only
// leaving the file out of the bundle can.
//
// Add a file here only when it cannot run on device at all. A test that merely
// skips on mobile should stay in the bundle so its coverage is visible.
//
// Dependency-free on purpose: the generator runs under bare and the validator
// under node, and both must read the same list. One copy, no drift.
const DESKTOP_ONLY = new Set(['load-mode.test.js'])

module.exports = { DESKTOP_ONLY }
