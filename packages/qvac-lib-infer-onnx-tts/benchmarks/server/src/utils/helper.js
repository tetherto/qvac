'use strict'

const Buffer = require('bare-buffer')

const MAX_BODY_SIZE = 1 * 1024 * 1024 // 1 MB

/**
 * Process incoming JSON request body
 */
async function processJsonRequest (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    req.on('data', chunk => {
      received += chunk.length
      if (received > MAX_BODY_SIZE) {
        req.destroy(new Error('Payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks, received)
        const body = JSON.parse(buffer.toString())
        resolve(body)
      } catch (err) {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Format Zod validation errors
 */
function formatZodError (error) {
  const issues = error.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message
  }))
  return {
    message: 'Validation failed',
    issues
  }
}

module.exports = {
  processJsonRequest,
  formatZodError
}
