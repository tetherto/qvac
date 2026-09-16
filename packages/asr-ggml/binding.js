module.exports = loadAddon()

// The split meta package has no local prebuild. Some runtimes return this
// package's Javascript entry from require.addon() instead of throwing, so
// validate the result before accepting it as the native binding.

function loadAddon() {
  let cause = null

  try {
    const addon = require.addon()
    if (isNativeBinding(addon)) return addon
    cause = new Error(
      '@qvac/asr-ggml: require.addon() answered with a module that is not the native binding ' +
        '(no createInstance function), so the prebuild in this package was treated as absent.'
    )
  } catch (err) {
    cause = err
  }

  return loadPlatformPackageAddon(cause)
}

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
      '@qvac/asr-ggml resolved #host-addon to a module that is not the native binding: ' +
        'it has no createInstance function. Check that the platform package for this host ' +
        'is installed and is not shadowed by another module of the same name.'
    )
    err.cause = cause
    throw err
  }

  return addon
}

function isNativeBinding(addon) {
  return addon !== null && typeof addon === 'object' && typeof addon.createInstance === 'function'
}
