'use strict'

const { checkLoadFiles } = require('./load-config.js')

function optionalFinite(request, key) {
  const value = request[key]
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`assessFit: ${key} must be a non-negative finite number`)
  }
}

function validateFitRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('assessFit: request must be an object')
  }
  if (typeof request.modelPath !== 'string' || request.modelPath.length === 0) {
    throw new TypeError('assessFit: modelPath must be a non-empty string')
  }
  if (request.config !== undefined && (!request.config || typeof request.config !== 'object')) {
    throw new TypeError('assessFit: config must be an object when provided')
  }
  for (const [key, value] of Object.entries(request.config ?? {})) {
    if (typeof value !== 'string') {
      throw new TypeError(`assessFit: config.${key} must be a string`)
    }
  }
  optionalFinite(request, 'minCtxSize')
  optionalFinite(request, 'marginBytes')
  checkLoadFiles({ path: request.modelPath, projectionPath: '', config: request.config })
}

module.exports = { validateFitRequest }
