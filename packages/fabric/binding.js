'use strict'

module.exports = loadAddon()

function loadAddon () {
  try {
    // Local prebuilds win. A source checkout after `bare-make install`, the
    // mobile flatten layout, and `linked:` installs all have the runtime in this
    // package and no platform package to fall back to.
    return require.addon()
  } catch (cause) {
    return loadPlatformPackage(cause)
  }
}

// Keep this require literal. bare-pack follows static specifiers; the host
// package is selected by the "#binding" imports map in package.json (Bare
// platform / arch conditions), matching bare-collabora. An uninstalled host
// resolves to ./addon-unavailable.js, which throws the actionable error.
function loadPlatformPackage (cause) {
  try {
    return require('#binding')
  } catch (err) {
    if (err.cause === undefined) err.cause = cause
    throw err
  }
}
