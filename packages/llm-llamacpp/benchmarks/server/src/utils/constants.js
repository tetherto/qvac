'use strict'

const HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE'
}

const ERRORS = {
  ROUTE_NOT_FOUND: 'Route not found',
  UNEXPECTED_ERROR: 'An unexpected error occurred',
  INVALID_REQUEST: 'Invalid request format',
  MODEL_NOT_LOADED: 'Model not loaded',
  INFERENCE_ERROR: 'Error during inference'
}

module.exports = {
  HTTP_METHODS,
  ERRORS
}
