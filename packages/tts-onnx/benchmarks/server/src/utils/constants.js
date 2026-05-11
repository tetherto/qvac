'use strict'

const HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST'
}

const ERRORS = {
  ROUTE_NOT_FOUND: 'Route not found',
  INVALID_REQUEST: 'Invalid request body',
  UNEXPECTED_ERROR: 'An unexpected error occurred'
}

module.exports = {
  HTTP_METHODS,
  ERRORS
}
