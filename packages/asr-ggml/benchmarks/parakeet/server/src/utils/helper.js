'use strict'

const { ERRORS } = require('./constants')
const ApiError = require('./ApiError')
const { Buffer } = require('bare-buffer')

/**
 * Process JSON request body
 * @param {http.IncomingMessage} req
 * @returns {Promise<Object>}
 */
const MAX_BODY_SIZE = 1 * 1024 * 1024 // 1 MB

const processJsonRequest = async (req) => {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    req.on('data', chunk => {
      received += chunk.length
      if (received > MAX_BODY_SIZE) {
        req.destroy(new ApiError(413, 'Payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks, received).toString('utf8')
        if (!body) {
          resolve({})
          return
        }
        const parsed = JSON.parse(body)
        resolve(parsed)
      } catch (error) {
        reject(new ApiError(400, ERRORS.INVALID_REQUEST_BODY))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Format Zod validation error for response
 * @param {import('zod').ZodError} error
 * @returns {string}
 */
const formatZodError = (error) => {
  const issues = error.issues.map(issue => {
    const path = issue.path.join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
  return `Validation error: ${issues.join(', ')}`
}

module.exports = {
  processJsonRequest,
  formatZodError
}
