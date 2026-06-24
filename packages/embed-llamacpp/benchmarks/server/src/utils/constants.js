'use strict'

const ERRORS = {
  ROUTE_NOT_FOUND: 'Route not found',
  UNEXPECTED_ERROR: 'An unexpected error occurred',
  INVALID_JSON_PAYLOAD: 'Invalid JSON payload',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  REQUEST_TIMEOUT: 'Request timeout',
  REQUEST_ABORTED: 'Request aborted',
  INVALID_INPUT: 'Invalid input',
  INCONSISTENT_EMBEDDING_LENGTH: 'Inconsistent embedding length'
}

const HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST'
}

module.exports = {
  ERRORS,
  HTTP_METHODS
}
