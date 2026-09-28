'use strict'

const { resolveBackendsDir } = require('./backends')

/**
 * Projects one model set against the memory free right now, reading GGUF
 * metadata and never weight data. The registry's weightless copy of each stage
 * answers the same as the stage itself, so this can run before anything is
 * downloaded.
 *
 * `engine` defaults to `acestep`, the one engine audiogen-cpp ships a fitter
 * for. Any other engine comes back as `status: "error"` with
 * `reason: "unsupported-engine"`.
 *
 * A model set the engine cannot read comes back as `status: "error"` with its
 * own reason; a broken request, or a host with no native binding, throws.
 */
function assessFit(request) {
  const binding = require('../binding.js')

  return binding.assessFit({
    ...request,
    backendsDir:
      typeof request.backendsDir === 'string' && request.backendsDir.length > 0
        ? request.backendsDir
        : resolveBackendsDir()
  })
}

module.exports = { assessFit }
