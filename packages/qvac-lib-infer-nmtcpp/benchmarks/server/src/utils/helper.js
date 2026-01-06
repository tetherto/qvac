const ApiError = require('./ApiError')
const { ERRORS } = require('./constants')
const { Buffer } = require('bare-buffer')

/**
 * Process a JSON payload from an IncomingMessage, with safety guards.
 * @param {http.IncomingMessage} req - the HTTP request
 * @param {Object} opts - optional limits (body size, timeout)
 * @param {number} opts.limit - maximum number of bytes allowed in body (default 1MB)
 * @param {number} opts.timeoutMs - milliseconds before timing out (default 5m)
 * @returns {Promise<Object>} - resolves to the parsed object
 * @throws ApiError(400) on invalid JSON or client abort,
 *         ApiError(413) if body too large,
 *         ApiError(408) if timed out
 */
const processJsonRequest = (req, opts = {}) => {
  const limit = opts.limit ?? 1024 * 1024
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000

  return new Promise((resolve, reject) => {
    const buffers = []
    let received = 0
    let timeoutId

    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
      clearTimeout(timeoutId)
    }

    const onData = (chunk) => {
      received += chunk.length
      if (received > limit) {
        cleanup()
        req.destroy(new ApiError(413, ERRORS.PAYLOAD_TOO_LARGE))
        return
      }
      buffers.push(chunk)
    }

    const onEnd = () => {
      cleanup()
      const raw = Buffer.concat(buffers, received).toString('utf8')
      if (!raw) {
        return resolve({})
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new ApiError(400, ERRORS.INVALID_JSON_PAYLOAD))
      }
    }

    const onError = (err) => {
      cleanup()
      reject(err)
    }

    const onAborted = () => {
      cleanup()
      reject(new ApiError(400, ERRORS.REQUEST_ABORTED))
    }

    const onTimeout = () => {
      cleanup()
      req.destroy(new ApiError(408, ERRORS.REQUEST_TIMEOUT))
    }

    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)

    if (typeof req.setTimeout === 'function') {
      req.setTimeout(timeoutMs, onTimeout)
    } else {
      timeoutId = setTimeout(onTimeout, timeoutMs)
    }
  })
}

/**
 * Format Zod validation errors into a readable message
 * @param {ZodError} error
 * @returns {string}
 */
const formatZodError = (error) => {
  return error.issues
    .map(({ path, message }) => {
      const fieldPath = path.length ? path.join('.') : '<root>'
      return `${fieldPath}: ${message}`
    })
    .join('; ')
}

module.exports = {
  processJsonRequest,
  formatZodError
}
