'use strict'

/**
 * Error class for API errors
 */
class ApiError extends Error {
  status

  /**
   * Create a new ApiError
   * @param {number} status
   * @param {string} message
   */
  constructor (status, message) {
    super(message)
    this.status = status
    Object.setPrototypeOf(this, ApiError.prototype)
  }
}

module.exports = ApiError
