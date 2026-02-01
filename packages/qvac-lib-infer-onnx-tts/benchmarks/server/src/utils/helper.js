'use strict'

const Buffer = require('bare-buffer')

/**
 * Process incoming JSON request body
 */
async function processJsonRequest (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks)
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
