'use strict'

const { ERRORS } = require('./constants')
const ApiError = require('./ApiError')

/**
 * Process JSON request body
 * @param {http.IncomingMessage} req
 * @returns {Promise<Object>}
 */
const processJsonRequest = async (req) => {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })
    req.on('end', () => {
      try {
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
