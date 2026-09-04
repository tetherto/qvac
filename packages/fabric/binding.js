'use strict'

// Keep this require literal. bare-pack follows static specifiers; the host
// package is selected by the "#binding" imports map in package.json (Bare
// platform / arch / simulator conditions), matching bare-collabora.
try {
  module.exports = require('#binding')
} catch (cause) {
  const expected = require('./platform').platformPackageName()
  const suffix = expected ? ` Install ${expected}; optional dependencies may have been omitted or your package manager may be unsupported.` : ''
  const error = new Error(`@qvac/fabric has no installed runtime for ${process.platform}-${process.arch}.${suffix}`)
  error.cause = cause
  throw error
}
