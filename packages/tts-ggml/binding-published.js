const addon = require('#host-addon')

if (!isNativeBinding(addon)) {
  throw new Error(
    '@qvac/tts-ggml resolved #host-addon to a module that is not the native binding: ' +
      'it has no createInstance function. Check that the platform package for this host ' +
      'is installed and is not shadowed by another module of the same name.'
  )
}

module.exports = addon

function isNativeBinding(addon) {
  return addon !== null && typeof addon === 'object' && typeof addon.createInstance === 'function'
}
