'use strict'

const http = require('bare-http1')
const logger = require('./utils/logger')
const ApiError = require('./utils/ApiError')
const { HTTP_METHODS, ERRORS } = require('./utils/constants')
const { runWhisper } = require('./services/whisper')
// const { runWhisper } = require('./services/whisper.cli')  // TEMP: Using original whisper.cpp CLI
const { runParakeet } = require('./services/parakeet')
const { runLiveAudio } = require('./services/runLiveAudio')
const { URL } = require('bare-url')
const { processJsonRequest, formatZodError } = require('./utils/helper')
const { ZodError } = require('zod')

/**
 * Handle errors and send appropriate response
 * @param {Error} error
 * @param {http.ServerResponse} res
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
    error: ERRORS.UNEXPECTED_ERROR
  }))
}

/**
 * Log error details when request fails
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} method
 * @param {URL} url
 * @param {string} host
 * @param {any} body
 */
const logErrorDetails = (req, res, method, url, host, body) => {
  const { statusCode } = res
  if (statusCode >= 400) {
    const contentLength = res.getHeader('content-length') || '(unknown)'
    const userAgent = req.headers['user-agent'] || ''
    const query = req.query ? JSON.stringify(req.query) : ''

    const log = [
      '[API]',
      method,
      url,
      statusCode,
      contentLength,
      host,
      '-',
      userAgent,
      `Query: ${query ? JSON.stringify(query) : ''}`,
      `Body: ${body ? JSON.stringify(body) : ''}`
    ].join(' ')
    logger.error(log)
  }
}

/**
 * Handle incoming requests
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
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

  const origin = req.headers.origin || ''
  const allowedOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : ''
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')

  if (method === HTTP_METHODS.OPTIONS) {
    res.statusCode = 204
    return res.end()
  }

  try {
    if (pathname === '/' && method === HTTP_METHODS.GET) {
      return res.end(JSON.stringify({
        message: 'ASR GGML Benchmark Server is running'
      }))
    }
    if (pathname === '/run' && method === HTTP_METHODS.POST) {
      // The body carries a required `engine` discriminator ("whisper" |
      // "parakeet"); each service re-validates its own branch of the union.
      const engine = body?.engine
      let result
      if (engine === 'whisper') {
        result = await runWhisper(body)
      } else if (engine === 'parakeet') {
        result = await runParakeet(body)
      } else {
        throw new ApiError(400, ERRORS.INVALID_ENGINE)
      }
      logger.info(`Completed ${engine} run request for ${result.outputs.length} inputs`)
      return res.end(JSON.stringify({
        data: result
      }))
    }
    if (pathname === '/live' && method === HTTP_METHODS.POST) {
      const result = await runLiveAudio(body)
      logger.info('Completed live audio request')
      return res.end(JSON.stringify({
        data: result
      }))
    }
    throw new ApiError(404, ERRORS.ROUTE_NOT_FOUND)
  } catch (error) {
    handleError(error, res)
  } finally {
    res.on('finish', () => logErrorDetails(req, res, method, url, host, body))
  }
}

const server = http.createServer(handleRequest)

module.exports = {
  server
}
