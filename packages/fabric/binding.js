'use strict'

// Keep this require literal. bare-pack follows static specifiers; the host
// package is selected by the "#binding" imports map in package.json (Bare
// platform / arch / simulator conditions), matching bare-collabora.
try {
  module.exports = require('#binding')
} catch (cause) {
  const { platformPackageName, runtimeHost } = require('./platform')
  const { platform, arch } = runtimeHost()
  const expected = platformPackageName(platform, arch)
  const host = platform && arch ? `${platform}-${arch}` : 'this host'
  let resolved = false
  if (expected) {
    try {
      require.resolve(`${expected}/package`)
      resolved = true
    } catch {}
  }
  if (resolved) {
    const error = new Error(`@qvac/fabric found ${expected} but could not load its native addon`)
    error.cause = cause
    throw error
  }
  const suffix = expected ? ` Install ${expected}; optional dependencies may have been omitted or your package manager may be unsupported.` : ''
  const error = new Error(`@qvac/fabric has no installed runtime for ${host}.${suffix}`)
  error.cause = cause
  throw error
}
