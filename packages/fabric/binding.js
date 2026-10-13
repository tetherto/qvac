'use strict'

module.exports = loadAddon()

// `require.addon()` reads a runtime in this package's own prebuilds/ (source
// build, CI overlay, the unsliced GPR tarball). npm installs have none since the
// per-platform split, so the runtime normally comes from the `#host-addon`
// platform package. Some runtimes answer `require.addon()` with the package's
// JavaScript entry instead of failing, and the entry is this file, so that
// answer is this module's own half-built exports: returning it would leave
// qvac__fabric.bare unloaded and every consumer failing to resolve it.
function loadAddon() {
  let cause = null

  try {
    const addon = require.addon()
    if (isNativeBinding(addon)) return addon
    cause = new Error(
      "@qvac/fabric: require.addon() answered with this package's JavaScript entry " +
        'rather than the native runtime, so the prebuild in this package was treated as absent.'
    )
  } catch (err) {
    cause = err
  }

  return loadPlatformPackageAddon(cause)
}

// Keep the specifier literal: bare-pack follows static requires, and every arm
// of the imports map ends in ./addon-unavailable.js so this always resolves.
function loadPlatformPackageAddon(cause) {
  let addon

  try {
    addon = require('#host-addon')
  } catch (err) {
    if (err.cause === undefined) err.cause = cause
    throw err
  }

  if (!isNativeBinding(addon)) {
    const err = new Error(
      '@qvac/fabric resolved #host-addon to a module that is not the native runtime. ' +
        'Check that the platform package for this host is installed and is not shadowed ' +
        'by another module of the same name.'
    )
    err.cause = cause
    throw err
  }

  return addon
}

function isNativeBinding(addon) {
  return addon !== null && typeof addon === 'object' && addon !== module.exports
}
