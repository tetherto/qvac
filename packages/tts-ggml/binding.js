module.exports = loadAddon()

// `require.addon()` reads the prebuild shipped inside this package. Since the
// per-platform split (0.9.0) there is none, so the real binding almost always
// comes from the `#host-addon` platform package. Runtimes have been seen to
// answer `require.addon()` with this package's own JavaScript entry instead of
// failing, which used to be returned verbatim: callers then got a module with
// no `createInstance`, and the first symptom was an unrelated TypeError deep in
// a model load. Anything that is not the native binding is treated as a miss.
function loadAddon() {
  let cause = null

  try {
    const addon = require.addon()
    if (isNativeBinding(addon)) return addon
    cause = new Error(
      '@qvac/tts-ggml: require.addon() answered with a module that is not the native binding ' +
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
      '@qvac/tts-ggml resolved #host-addon to a module that is not the native binding: ' +
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
