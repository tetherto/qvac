'use strict'

const addon = require('#host-addon')

if (!isNativeBinding(addon)) {
  throw new Error(
    '@qvac/fabric resolved #host-addon to a module that is not the native runtime. ' +
    'Check that the platform package for this host is installed and is not shadowed ' +
    'by another module of the same name.'
  )
}

module.exports = addon

function isNativeBinding (addon) {
  return addon !== null && typeof addon === 'object' && addon !== module.exports
}
