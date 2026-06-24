'use strict'

const HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
  OPTIONS: 'OPTIONS'
}

const ERRORS = {
  ROUTE_NOT_FOUND: 'Route not found',
  UNEXPECTED_ERROR: 'An unexpected error occurred',
  INVALID_REQUEST_BODY: 'Invalid request body',
  MISSING_REQUIRED_FIELD: 'Missing required field'
}

module.exports = {
  HTTP_METHODS,
  ERRORS
}
