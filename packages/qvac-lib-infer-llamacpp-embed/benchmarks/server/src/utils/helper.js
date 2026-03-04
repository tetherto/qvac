const ApiError = require('./ApiError')
const { ERRORS } = require('./constants')
const { Buffer } = require('bare-buffer')

/**
 * Process a JSON request from an IncomingMessage, with safety guards.
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
  const limit = opts.limit ?? 1 * 1024 * 1024
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

/**
 * Compute the mean‐pooled embedding over a sequence of token embeddings.
 * @param {Float32Array[]} tokenEmbeddings
 *   An array of token embedding vectors. Each element must be a Float32Array of the same length.
 * @returns {Float32Array}
 *   A new Float32Array of length D (the hidden dimension), where each element is
 *   the average of the corresponding elements across all token embeddings.
 */
function meanPoolEmbeddings (tokenEmbeddings) {
  if (!Array.isArray(tokenEmbeddings) || tokenEmbeddings.length === 0) {
    throw new Error(ERRORS.INVALID_INPUT)
  }
  const seqLen = tokenEmbeddings.length
  const dim = tokenEmbeddings[0].length
  for (let i = 1; i < seqLen; i++) {
    if (tokenEmbeddings[i].length !== dim) {
      throw new Error(ERRORS.INCONSISTENT_EMBEDDING_LENGTH)
    }
  }
  const output = new Float32Array(dim)
  for (let i = 0; i < seqLen; i++) {
    const vec = tokenEmbeddings[i]
    for (let j = 0; j < dim; j++) {
      output[j] += vec[j]
    }
  }
  const invSeqLen = 1 / seqLen
  for (let j = 0; j < dim; j++) {
    output[j] *= invSeqLen
  }
  return output
}

/**
 * L2‑normalize a vector in place (Frobenius norm).
 * @param {Float32Array} vector The vector to normalize. Its length must be > 0.
 * @returns {Array<number>} A similar array, scaled so that its L2 norm equals 1.
 */
function l2Normalize (vector) {
  if (!(vector instanceof Float32Array) || vector.length === 0) {
    throw new Error(ERRORS.INVALID_INPUT)
  }
  let sumSquares = 0
  for (let i = 0; i < vector.length; i++) {
    sumSquares += vector[i] * vector[i]
  }
  const norm = Math.sqrt(sumSquares)
  if (norm === 0) return vector
  const invNorm = 1 / norm
  for (let i = 0; i < vector.length; i++) {
    vector[i] *= invNorm
  }
  return Array.from(vector)
}

/**
 * Compute a single “summary” embedding by:
 *   1) Mean‑pooling the token embeddings.
 *   2) L2‑normalizing the pooled vector.
 * @param {Float32Array[]} tokenEmbeddings Array of token embedding vectors (each of equal length).
 * @returns {Array<number>} A normalized array of the same hidden dimension.
 * @example
 * const tokens = [
 *   new Float32Array([0.1, 0.2, 0.3]),
 *   new Float32Array([0.0, 0.1, 0.4]),
 *   new Float32Array([0.2, 0.0, 0.5]),
 * ];
 * const summaryVec = summarizeEmbeddings(tokens);
 * // summaryVec = [ ~0.447, ~0.298, ~0.843 ] (L2 norm = 1)
 */
function summarizeEmbeddings (tokenEmbeddings) {
  const pooled = meanPoolEmbeddings(tokenEmbeddings)
  return l2Normalize(pooled)
}

module.exports = {
  processJsonRequest,
  formatZodError,
  summarizeEmbeddings
}
