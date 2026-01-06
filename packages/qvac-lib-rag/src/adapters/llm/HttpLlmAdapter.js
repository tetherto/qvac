'use strict'

const BaseLlmAdapter = require('./BaseLlmAdapter')
const { QvacErrorRAG, ERR_CODES } = require('../../errors')

/**
 * HTTP-based LLM adapter that can work with various HTTP LLM APIs.
 * Requires bare-fetch as an optional dependency for HTTP requests.
 */
class HttpLlmAdapter extends BaseLlmAdapter {
  /**
 * @param {Object} httpConfig - Configuration for the LLM API
 * @param {string} httpConfig.apiUrl - The API endpoint URL
 * @param {string} [httpConfig.method='POST'] - HTTP method to use
 * @param {Object} [httpConfig.headers={}] - HTTP headers to send
 * @param {Function} requestBodyFormatter - Function that takes input(query & searchResults) and returns the request body
 * @param {Function} responseBodyFormatter - Function that takes API response and returns the final result
 */
  constructor (httpConfig, requestBodyFormatter, responseBodyFormatter) {
    super()

    if (!httpConfig || typeof httpConfig !== 'object') {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'HTTP configuration is required' })
    }

    if (!httpConfig.apiUrl || typeof httpConfig.apiUrl !== 'string') {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'API URL is required and must be a string' })
    }

    if (!requestBodyFormatter || typeof requestBodyFormatter !== 'function') {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'Request body formatter function is required' })
    }

    if (!responseBodyFormatter || typeof responseBodyFormatter !== 'function') {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'Response body formatter function is required' })
    }

    this.httpConfig = {
      method: 'POST',
      ...httpConfig,
      headers: {
        'Content-Type': 'application/json',
        ...httpConfig.headers
      }
    }
    this.requestBodyFormatter = requestBodyFormatter
    this.responseBodyFormatter = responseBodyFormatter
  }

  /**
   * Run inference with the HTTP LLM API using query and search results.
   * @param {string} query - The user query
   * @param {Array<SearchResult>} searchResults - Search results from the embedder
   * @param {InferOpts} [opts] - Additional options for the inference
   * @returns {Promise<any>} The generated response (formatted by responseBodyFormatter)
   */
  async run (query, searchResults, opts = {}) {
    try {
      const requestBody = this.requestBodyFormatter(query, searchResults, opts)
      if (!requestBody || typeof requestBody !== 'object') {
        throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'Request body formatter must return an object' })
      }
      const response = await this._makeHttpRequest(requestBody)
      const result = this.responseBodyFormatter(response)
      return result
    } catch (error) {
      if (error instanceof QvacErrorRAG) {
        throw error
      }
      throw new QvacErrorRAG({ code: ERR_CODES.GENERATION_FAILED, adds: `HTTP LLM request failed: ${error.message}`, cause: error })
    }
  }

  /**
   * Make an HTTP request to the LLM API.
   * @param {Object} requestBody - The request body to send
   * @returns {Promise<Object>} The parsed response object
   * @private
   */
  async _makeHttpRequest (requestBody) {
    try {
      const fetch = await import('bare-fetch').then(module => module.default || module)

      const response = await fetch(this.httpConfig.apiUrl, {
        method: this.httpConfig.method,
        headers: this.httpConfig.headers,
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      return response.json()
    } catch (error) {
      if ((error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND') && error.message.includes('bare-fetch')) {
        throw new QvacErrorRAG({ code: ERR_CODES.DEPENDENCY_REQUIRED, adds: 'bare-fetch is required for HttpLlmAdapter.', cause: error })
      }
      throw error
    }
  }

  /**
   * Update the HTTP configuration.
   * @param {Object} newHttpConfig - New HTTP configuration to merge
   */
  updateHttpConfig (newHttpConfig) {
    this.httpConfig = { ...this.httpConfig, ...newHttpConfig }
  }

  /**
   * Update the request body formatter function.
   * @param {Function} newFormatter - New formatter function
   */
  updateRequestBodyFormatter (newFormatter) {
    if (typeof newFormatter !== 'function') {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'Request body formatter must be a function' })
    }
    this.requestBodyFormatter = newFormatter
  }

  /**
   * Update the response body formatter function.
   * @param {Function} newFormatter - New formatter function
   */
  updateResponseBodyFormatter (newFormatter) {
    if (typeof newFormatter !== 'function') {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'Response body formatter must be a function' })
    }
    this.responseBodyFormatter = newFormatter
  }
}

module.exports = HttpLlmAdapter
