'use strict'

const IngestionService = require('./services/IngestionService')
const RetrievalService = require('./services/RetrievalService')
const ChunkingService = require('./services/core/ChunkingService')
const EmbeddingService = require('./services/core/EmbeddingService')
const BaseLlmAdapter = require('./adapters/llm/BaseLlmAdapter')
const ReadyResource = require('ready-resource')
const { QvacErrorRAG, ERR_CODES } = require('./errors')
const QvacLogger = require('@qvac/logging')

class RAG extends ReadyResource {
  /**
   * RAG (Retrieval-Augmented Generation) class.
   * @param {Object} config - Configuration object.
   * @param {EmbeddingFunction} config.embeddingFunction - The embedding function
   * @param {BaseDBAdapter} config.dbAdapter - The database adapter instance.
   * @param {BaseLlmAdapter} [config.llm] - Optional LLM adapter for inference
   * @param {BaseChunkAdapter} [config.chunker] - Optional custom chunker instance.
   * @param {ChunkOpts} [config.chunkOpts] - Optional chunking options for document processing.
   * @param {Logger} [config.logger] - Optional logger instance
   */
  constructor ({ llm, embeddingFunction, dbAdapter, chunker, chunkOpts = {}, logger }) {
    super()
    if (!embeddingFunction) throw new QvacErrorRAG({ code: ERR_CODES.EMBEDDING_FUNCTION_REQUIRED })
    if (!dbAdapter) throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_REQUIRED })

    this.logger = logger || new QvacLogger()

    this.chunkingService = new ChunkingService({ chunker, chunkOpts, logger: this.logger })
    this.embeddingService = new EmbeddingService({ embeddingFunction, logger: this.logger })
    this.ingestionService = new IngestionService({
      dbAdapter,
      chunkingService: this.chunkingService,
      embeddingService: this.embeddingService,
      logger: this.logger
    })
    this.retrievalService = new RetrievalService({
      dbAdapter,
      chunkingService: this.chunkingService,
      embeddingService: this.embeddingService,
      logger: this.logger
    })
    this.dbAdapter = dbAdapter
    this.llmAdapter = llm

    this.logger.debug('RAG instance created')
  }

  /**
   * Chunks text into multiple chunks using the configured chunker.
   * @param {string|Array<string>} input - The text or array of texts to chunk.
   * @param {ChunkOpts} [opts] - Optional chunking options to override the default.
   * @returns {Promise<Array<Doc>>} - Array of chunked documents with IDs and content.
   */
  async chunk (input, opts = {}) {
    return this.chunkingService.chunkText(input, opts)
  }

  /**
   * Generate embeddings for a single text.
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
    return this.retrievalService.generateEmbeddingsForDocs(docs, opts)
  }

  /**
   * Save embedded documents directly to the vector database.
   * Documents must have id, content, embedding, and embeddingModelId fields.
   * @param {Array<EmbeddedDoc>} embeddedDocs - Documents with embeddings.
   * @param {SaveEmbeddingsOpts} [opts] - Options for saving.
   * @returns {Promise<Array<SaveEmbeddingsResult>>} - Array of processing results.
   */
  async saveEmbeddings (embeddedDocs, opts = {}) {
    return this.ingestionService.saveEmbeddings(embeddedDocs, opts)
  }

  /**
   * Ingest documents: chunk, embed, and save to the vector database.
   * Convenience method that handles the full pipeline.
   * @param {string|Array<string>} docs - Documents to ingest (text or Doc objects without embeddings).
   * @param {string} embeddingModelId - The embedding model identifier.
   * @param {IngestOpts} [opts] - Options for the ingestion pipeline.
   * @returns {Promise<{processed: Array<SaveEmbeddingsResult>, droppedIndices: Array<number>}>} - Processing results and dropped indices.
   */
  async ingest (docs, embeddingModelId, opts = {}) {
    return this.ingestionService.ingest(docs, embeddingModelId, opts)
  }

  /**
   * Delete embeddings for a set of documents inside the vector database.
   * @param {Array<string>} ids - The ids of the documents to be deleted.
   * @returns {Promise<boolean>} True if the embeddings were deleted
   */
  async deleteEmbeddings (ids) {
    return this.ingestionService.deleteEmbeddings(ids)
  }

  /**
   * Searches for context based on the prompt and generates a response.
   * @param {string} query - The user query.
   * @param {InferOpts} [opts] - Options for inference and search.
   * @returns {Promise<any>} The generated response (format depends on LLM adapter) or null if no context found.
   */
  async infer (query, { llmAdapter = this.llmAdapter, signal, ...opts } = {}) {
    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }
    if (!llmAdapter || !(llmAdapter instanceof BaseLlmAdapter)) {
      throw new QvacErrorRAG({ code: ERR_CODES.LLM_REQUIRED })
    }

    this.logger.debug(`Infer started: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`)
    const startTime = Date.now()

    const searchResults = await this.retrievalService.search(query, { signal, ...opts })
    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }
    if (searchResults.length === 0) {
      this.logger.debug('Infer: no context found')
      return null
    }

    const result = await llmAdapter.run(query, searchResults, { signal, ...opts })
    const duration = Date.now() - startTime

    this.logger.info(`Infer complete: ${searchResults.length} context(s) in ${duration}ms`)

    return result
  }

  /**
   * Searches for documents based on a query string.
   * @param {string} query - The user query.
   * @param {SearchOpts} [params] - Parameters for search.
   * @returns {Promise<Array<SearchResult>>} The search results.
   */
  async search (query, params = {}) {
    return this.retrievalService.search(query, params)
  }

  /**
   * Sets the chunker for the RAG.
   * @param {BaseChunkAdapter} chunker - The chunker instance.
   * @param {ChunkOpts} [chunkOpts] - The options for the chunking.
   */
  setChunker (chunker, chunkOpts = {}) {
    this.chunkingService.setChunker(chunker, chunkOpts)
  }

  /**
   * Sets the default LLM for the RAG.
   * @param {BaseLlmAdapter} llm - The LLM instance or adapter.
   */
  setLlm (llmAdapter) {
    if (!llmAdapter || !(llmAdapter instanceof BaseLlmAdapter)) {
      throw new QvacErrorRAG({ code: ERR_CODES.LLM_REQUIRED })
    }
    this.llmAdapter = llmAdapter
  }

  /**
   * Reindex the database to optimize search performance.
   * For HyperDBAdapter, this rebalances centroids using k-means clustering.
   * @param {ReindexOpts} [opts] - Options for reindexing.
   * @returns {Promise<ReindexResult>}
   */
  reindex (opts) {
    return this.dbAdapter.reindex(opts)
  }

  /**
   * Get stored adapter configuration.
   * Returns the persisted config including embeddingModelId.
   * @returns {Promise<BaseDBAdapterConfig|null>} The stored config or null if not configured
   */
  async getDBConfig () {
    return this.dbAdapter.getConfig()
  }

  /**
   * Initializes RAG adapter
   * @returns {Promise<void>}
   * @private
   */
  async _open () {
    this.logger.info('Initializing RAG...')
    await this.dbAdapter.ready()
    this.logger.info('RAG ready')
  }

  /**
   * Closes and cleans up resources for the RAG.
   * @returns {Promise<void>}
   * @private
   */
  async _close () {
    this.logger.info('Closing RAG...')
    await this.dbAdapter.close()
    this.logger.debug('RAG closed')
  }
}

module.exports = RAG
