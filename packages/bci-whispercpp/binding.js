module.exports = loadAddon()

// Some runtimes answer `require.addon()` with this package's own JavaScript
// entry, which re-exports `assessFit`. Accepting it makes the JS wrapper call
// itself until the stack runs out.

function loadAddon() {
  let addon
  let cause = null

  try {
    addon = require.addon()
  } catch (err) {
    cause = err
  }

  if (isNativeBinding(addon)) return addon

  const error = new Error(
    '@qvac/bci-whispercpp found no native prebuild for this host. ' +
      'Build from source with bare-make, or install a release that ships one.'
  )
  error.cause =
    cause ||
    new Error(
      'require.addon() answered with a module that is not the native binding ' +
        '(no createInstance function), so the prebuild in this package was treated as absent.'
    )
  throw error
}

function isNativeBinding(addon) {
  return addon !== null && typeof addon === 'object' && typeof addon.createInstance === 'function'
}
