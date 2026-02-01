'use strict'

const { QvacErrorRAG, ERR_CODES } = require('../../errors')

/**
 * Abstract base class for LLM implementations.
 * Provides a common interface for different LLM types (QVAC-based, HTTP-based, etc.).
 */
class BaseLlmAdapter {
  constructor () {
    if (new.target === BaseLlmAdapter) {
      throw new QvacErrorRAG({ code: ERR_CODES.ABSTRACT_CLASS, adds: 'BaseLlmAdapter cannot be instantiated directly' })
    }
  }

  /**
   * Run inference with the LLM using query and search results.
   * @param {string} query - The user query
   * @param {Array<SearchResult>} searchResults - Search results from the embedder
   * @param {InferOpts} [opts] - Additional options for the inference
   * @returns {Promise<any>} The generated response (format depends on LLM adapter implementation)
   */
  async run (query, searchResults, opts = {}) {
    throw new QvacErrorRAG({ code: ERR_CODES.NOT_IMPLEMENTED, adds: 'run method must be implemented by concrete adapter classes' })
  }
}

module.exports = BaseLlmAdapter
