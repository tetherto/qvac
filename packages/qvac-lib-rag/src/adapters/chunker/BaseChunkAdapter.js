'use strict'

const { QvacErrorRAG, ERR_CODES } = require('../../errors')

/**
 * Abstract base class for text chunking implementations.
 * Provides a common interface for different chunking strategies.
 * @param {ChunkOpts} opts - The options for the chunker.
 */
class BaseChunkAdapter {
  constructor (opts = {}) {
    if (new.target === BaseChunkAdapter) {
      throw new QvacErrorRAG({ code: ERR_CODES.ABSTRACT_CLASS })
    }
    this.opts = opts
  }

  /**
   * Chunks text(s) into smaller pieces.
   * @param {string|Array<string>} input - The text or array of texts to chunk.
   * @param {ChunkOpts} opts - Chunking options specific to the implementation.
   * @returns {Promise<Array<Doc>>} - Array of Docs.
   * @throws {Error} - If chunking fails.
   */
  async chunkText (input, opts = {}) {
    throw new QvacErrorRAG({ code: ERR_CODES.NOT_IMPLEMENTED })
  }

  /**
   * Validates the input for chunking.
   * @param {string|Array<string>} input - The input to validate.
   * @throws {Error} - If input is invalid.
   */
  validateInput (input) {
    if (!input) {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'Input cannot be empty, null or undefined' })
    }

    if (typeof input === 'string') {
      if (input.trim().length === 0) {
        throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'Input string cannot be empty' })
      }
    } else if (Array.isArray(input)) {
      if (input.length === 0) {
        throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'Input array cannot be empty' })
      }

      for (let i = 0; i < input.length; i++) {
        if (typeof input[i] !== 'string') {
          throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: `Input array element at index ${i} must be a string` })
        }
        if (input[i].trim().length === 0) {
          throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: `Input array element at index ${i} cannot be empty` })
        }
      }
    } else {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'Input must be a string or array of strings' })
    }
  }

  /**
   * Updates the default options for this chunker instance.
   * @param {ChunkOpts} opts - New options to merge with existing defaults.
   */
  updateOptions (opts = {}) {
    if (!this.opts) {
      this.opts = {}
    }
    this.opts = { ...this.opts, ...opts }
  }

  /**
   * Gets the current options for this chunker instance.
   * @returns {ChunkOpts} - Current chunker options.
   */
  getOptions () {
    return { ...this.opts }
  }
}

module.exports = BaseChunkAdapter
