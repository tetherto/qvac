'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.assessFit = assessFit
/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
const path = require('bare-path')
/**
 * Assess loading the detector and recognizer weights from GGUF metadata.
 * This does not load weights or account for image-dependent inference memory.
 * `error` means no reliable capacity verdict was available.
 */
function assessFit(request) {
  for (const key of ['pathDetector', 'pathRecognizer']) {
    if (typeof request[key] !== 'string' || !path.isAbsolute(request[key])) {
      throw new TypeError(`${key} must be an absolute path`)
    }
  }
  if (
    request.marginBytes !== undefined &&
    (!Number.isSafeInteger(request.marginBytes) || request.marginBytes < 0)
  ) {
    throw new RangeError('marginBytes must be a non-negative safe integer')
  }
  // Resolve lazily so importing this package never loads the native binding.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native prebuild is resolved lazily.
  const binding = require('./binding')
  return binding.assessFit(request)
}
