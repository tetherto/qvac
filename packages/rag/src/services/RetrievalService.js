'use strict'

const { normalizeDocs } = require('../utils/helper')
const { QvacErrorRAG, ERR_CODES } = require('../errors')
const QvacLogger = require('@qvac/logging')

class RetrievalService {
  /**
   * @param {Object} config
   * @param {BaseDBAdapter} config.dbAdapter - Database adapter for searching embeddings
   * @param {ChunkingService} config.chunkingService - Service for chunking documents
   * @param {EmbeddingService} config.embeddingService - Service for generating embeddings
   * @param {Logger} [config.logger] - Optional logger instance
   */
  constructor ({ dbAdapter, chunkingService, embeddingService, logger }) {
    if (!dbAdapter) throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_REQUIRED })
    if (!chunkingService) throw new QvacErrorRAG({ code: ERR_CODES.INVALID_CHUNKER })
    if (!embeddingService) throw new QvacErrorRAG({ code: ERR_CODES.EMBEDDING_FUNCTION_REQUIRED })

    this.dbAdapter = dbAdapter
    this.chunkingService = chunkingService
    this.embeddingService = embeddingService
    this.logger = logger || new QvacLogger()
  }

  /**
   * Generate embeddings for a text.
   * @param {string} text - The text to generate embeddings for.
   * @returns {Promise<Array<number>>} The embeddings.
   */
  async generateEmbeddings (text) {
    return this.embeddingService.generateEmbeddings(text)
  }

  /**
   * Generate embeddings for a set of documents.
   * @param {string|Array<string>} docs - The documents to generate embeddings for.
   * @param {GenerateEmbeddingsOpts} [opts] - Options for the embedding generation.
   * @returns {Promise<{[key: string]: Array<number>}>} A map of document IDs to their embeddings.
   */
  async generateEmbeddingsForDocs (docs, opts = {}) {
    const { signal, chunk = true, chunkOpts } = opts

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    let normalizedDocs = null
    if (chunk) {
      normalizedDocs = await this.chunkingService.chunkText(docs, chunkOpts)
    } else {
      const docsToNormalize = typeof docs === 'string' ? [docs] : docs
      const result = normalizeDocs(docsToNormalize)
      normalizedDocs = result.normalizedDocs
    }

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    return this.embeddingService.generateEmbeddingsForDocs(normalizedDocs, { signal })
  }

  /**
   * Search for documents based on a query string.
   * @param {string} query - The search query.
   * @param {Object} [params] - The parameters for the search.
   * @returns {Promise<Array<SearchResult>>} An array of search results.
   */
  async search (query, params = {}) {
    const { signal } = params

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.debug(`Search started: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`)
    const startTime = Date.now()

    if (typeof query !== 'string' || query.trim() === '') throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT })
    const queryVector = await this.embeddingService.generateEmbeddings(query)

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    const results = await this.dbAdapter.search(query, queryVector, params)
    const duration = Date.now() - startTime

    this.logger.info(`Search complete: ${results.length} result(s) in ${duration}ms`)

    return results
  }
}

module.exports = RetrievalService
