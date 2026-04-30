'use strict'

const BaseChunkAdapter = require('../../adapters/chunker/BaseChunkAdapter')
const LLMChunkAdapter = require('../../adapters/chunker/LLMChunkAdapter')
const { QvacErrorRAG, ERR_CODES } = require('../../errors')
const QvacLogger = require('@qvac/logging')

class ChunkingService {
  /**
   * @param {Object} config
   * @param {BaseChunkAdapter} [config.chunker] - Chunker instance, defaults to LLMChunker
   * @param {ChunkOpts} [config.chunkOpts] - Optional chunking options
   * @param {Logger} [config.logger] - Optional logger instance
   */
  constructor ({ chunker, chunkOpts = {}, logger }) {
    if (chunker && !(chunker instanceof BaseChunkAdapter)) {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_CHUNKER })
    }

    this.chunker = chunker || new LLMChunkAdapter(chunkOpts)
    this.chunkOpts = chunkOpts
    this.logger = logger || new QvacLogger()
  }

  /**
   * Splits text into multiple chunks using the configured chunker.
   * @param {string|string[]} input - The text or array of texts to chunk.
   * @param {Object} [opts] - Chunking options to override defaults.
   * @returns {Promise<Array<Doc>>} Array of chunked documents with IDs and content.
   */
  async chunkText (input, opts = {}) {
    const inputCount = typeof input === 'string' ? 1 : input.length
    this.logger.debug(`Chunking ${inputCount} text(s)`)
    const startTime = Date.now()

    const chunkOpts = { ...this.chunkOpts, ...opts }
    const chunks = await this.chunker.chunkText(input, chunkOpts)

    const duration = Date.now() - startTime
    this.logger.info(`Chunking complete: ${chunks.length} chunk(s) in ${duration}ms`)

    return chunks
  }

  /**
   * Sets the chunker for the service.
   * @param {BaseChunkAdapter} chunker - The chunker instance.
   * @param {ChunkOpts} [chunkOpts] - The options for the chunking.
   */
  setChunker (chunker, chunkOpts = {}) {
    if (!(chunker instanceof BaseChunkAdapter)) {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_CHUNKER })
    }
    this.chunker = chunker
    this.chunkOpts = { ...this.chunkOpts, ...chunkOpts }
  }
}

module.exports = ChunkingService
