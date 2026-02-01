'use strict'

const ERRORS = {
  ROUTE_NOT_FOUND: 'Route not found',
  MODEL_NOT_FOUND: 'Model not found',
  UNEXPECTED_ERROR: 'An unexpected error occurred',
  INVALID_JSON_PAYLOAD: 'Invalid JSON payload',
  PAYLOAD_TOO_LARGE: 'Payload too large to process',
  REQUEST_ABORTED: 'Request has been aborted',
  REQUEST_TIMEOUT: 'Request timed out'
}

const HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST'
}

module.exports = {
  ERRORS,
  HTTP_METHODS
}
