'use strict'

class ApiError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

module.exports = ApiError
