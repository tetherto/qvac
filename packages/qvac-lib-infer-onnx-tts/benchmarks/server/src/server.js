'use strict'

const http = require('bare-http1')
const logger = require('./utils/logger')
const ApiError = require('./utils/ApiError')
const { HTTP_METHODS, ERRORS } = require('./utils/constants')
const { runChatterboxTTS } = require('./services/runChatterboxTTS')
const { URL } = require('bare-url')
const { processJsonRequest, formatZodError } = require('./utils/helper')
const { ZodError } = require('zod')
const { ChatterboxRequestSchema } = require('./validation')

/**
 * Handle errors and send appropriate response
 */
const handleError = (error, res) => {
  logger.error(`API Error: ${error.stack || error}`)

  if (error instanceof ZodError) {
    res.statusCode = 400
    return res.end(JSON.stringify({
      error: formatZodError(error)
    }))
  }

  if (error instanceof ApiError) {
    res.statusCode = error.status
    return res.end(JSON.stringify({
      error: error.message
    }))
  }

  res.statusCode = 500
  res.end(JSON.stringify({
    error: ERRORS.UNEXPECTED_ERROR,
    details: error.message
  }))
}

/**
 * Log request details
 */
const logRequest = (req, res, method, url, body) => {
  const { statusCode } = res
  const contentLength = res.getHeader('content-length') || '(unknown)'
  const userAgent = req.headers['user-agent'] || ''

  const log = [
    '[API]',
    method,
    url.pathname,
    statusCode,
    contentLength,
    '-',
    userAgent
  ].join(' ')

  if (statusCode >= 400) {
    logger.error(log)
  } else {
    logger.info(log)
  }
}

/**
 * Handle incoming requests
 */
const handleRequest = async (req, res) => {
  const method = req.method
  const host = req.headers.host || ''
  const url = new URL(req.url, `https://${host}`)
  const pathname = url.pathname
  let body

  if (method === HTTP_METHODS.POST) {
    body = await processJsonRequest(req)
  }

  res.setHeader('Content-Type', 'application/json')

  try {
    if (pathname === '/' && method === HTTP_METHODS.GET) {
      // Get package version for health check
      let version = 'unknown'
      try {
        const pkg = require('@qvac/tts-onnx/package.json')
        version = pkg.version
      } catch (err) {
        logger.warn('Could not determine package version')
      }

      return res.end(JSON.stringify({
        message: 'TTS Addon Benchmark Server is running',
        implementation: 'addon',
        version,
        endpoints: {
          '/': 'Health check',
          '/synthesize-chatterbox': 'POST - Run Chatterbox TTS synthesis'
        }
      }))
    }

    if (pathname === '/synthesize-chatterbox' && method === HTTP_METHODS.POST) {
      const validated = ChatterboxRequestSchema.parse(body)
      const result = await runChatterboxTTS(validated)
      return res.end(JSON.stringify(result))
    }

    throw new ApiError(404, ERRORS.ROUTE_NOT_FOUND)
  } catch (error) {
    handleError(error, res)
  } finally {
    res.on('finish', () => logRequest(req, res, method, url, body))
  }
}

const server = http.createServer(handleRequest)

module.exports = {
  server
}
