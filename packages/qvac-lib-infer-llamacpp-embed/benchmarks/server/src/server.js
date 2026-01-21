'use strict'

const http = require('bare-http1')
const logger = require('./utils/logger')
const ApiError = require('./utils/ApiError')
const { HTTP_METHODS, ERRORS } = require('./utils/constants')
const { runAddon } = require('./services/runAddon')
const { modelManager } = require('./services/modelManager')
const { URL } = require('bare-url')
const { processJsonRequest: parseJson, formatZodError } = require('./utils/helper')
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

    const log = [
      '[API]',
      method,
      url,
      statusCode,
      contentLength,
      host,
      '-',
      userAgent,
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
  const requestId = Math.random().toString(36).substring(7)
  logger.info(`[${requestId}] Starting request handling`)
  const method = req.method
  const host = req.headers.host || ''
  const url = new URL(req.url, `https://${host}`)
  const pathname = url.pathname
  let body

  if (method === HTTP_METHODS.POST) {
    try {
      body = await parseJson(req)
      logger.info(`[${requestId}] Parsed request body`)
    } catch (error) {
      logger.error(`[${requestId}] Error parsing request body: ${error}`)
      handleError(error, res)
      return
    }
  }

  logger.debug(`[${requestId}] Request body: ${JSON.stringify(body)}`)
  res.setHeader('Content-Type', 'application/json')

  try {
    if (pathname === '/' && method === HTTP_METHODS.GET) {
      logger.info(`[${requestId}] Handling health check request`)
      return res.end(JSON.stringify({
        message: 'EmbedLlamacpp Benchmark Server is running'
      }))
    }

    if (pathname === '/status' && method === HTTP_METHODS.GET) {
      logger.info(`[${requestId}] Handling status request`)
      const status = modelManager.getStatus()
      return res.end(JSON.stringify({
        message: 'Model Status',
        status
      }))
    }

    if (pathname === '/run' && method === HTTP_METHODS.POST) {
      logger.info(`[${requestId}] Received run request`)

      const result = await runAddon(body)

      logger.info(`[${requestId}] Completed run request for ${result.outputs.length} inputs`)
      return res.end(JSON.stringify({
        data: result
      }))
    }

    throw new ApiError(404, ERRORS.ROUTE_NOT_FOUND)
  } catch (error) {
    logger.error(`[${requestId}] Error handling request:`, {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code,
      status: error.status,
      toString: String(error),
      fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
    })
    handleError(error, res)
  } finally {
    res.on('finish', () => {
      logger.info(`[${requestId}] Request completed with status ${res.statusCode}`)
      logErrorDetails(req, res, method, url, host, body)
    })
  }
}

const server = http.createServer(handleRequest)

module.exports = {
  server
}
