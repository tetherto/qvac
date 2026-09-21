'use strict'

const ERRORS = {
  ROUTE_NOT_FOUND: 'Route not found',
  UNEXPECTED_ERROR: 'An unexpected error occurred',
  INVALID_JSON_PAYLOAD: 'Invalid JSON payload',
  INVALID_ENGINE: 'Body must carry engine: "whisper" | "parakeet"'
}

const HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST',
  OPTIONS: 'OPTIONS'
}

module.exports = {
  ERRORS,
  HTTP_METHODS
}
