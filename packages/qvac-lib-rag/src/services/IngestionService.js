'use strict'

const { normalizeDocs } = require('../utils/helper')
const { QvacErrorRAG, ERR_CODES } = require('../errors')
const { embeddedDocsArraySchema } = require('../schemas/embedding')
const QvacLogger = require('@qvac/logging')

class IngestionService {
  /**
   * @param {Object} config
   * @param {BaseDBAdapter} config.dbAdapter - Database adapter for storing embeddings
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
   * Chunks a large text into multiple chunks using the configured chunking options.
   * @param {string|Array<string>} input - The text or array of texts to chunk.
   * @param {ChunkOpts} [opts] - Optional chunking options to override the default.
   * @returns {Promise<Array<Doc>>} - Array of chunked documents with IDs and content.
   */
  async chunk (input, opts = {}) {
    return this.chunkingService.chunkText(input, opts)
  }

  /**
   * Validate embedded docs structure.
   * @param {Array<EmbeddedDoc>} embeddedDocs - Documents with embeddings
   * @throws {QvacErrorRAG} If validation fails
   * @private
   */
  _validateEmbeddedDocs (embeddedDocs) {
    try {
      embeddedDocsArraySchema.parse(embeddedDocs)
    } catch (error) {
      if (error.name === 'ZodError') {
        const zodIssue = error.issues?.[0]
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: `Embedded document validation failed: ${zodIssue?.message || 'Invalid embedded documents'}`,
          cause: error
        })
      }
      throw error
    }
  }

  /**
   * Save embedded documents directly to the vector database.
   * Documents must have id, content, embedding, and embeddingModelId fields.
   * @param {Array<EmbeddedDoc>} embeddedDocs - Documents with embeddings.
   * @param {SaveEmbeddingsOpts} [opts] - Options for saving.
   * @returns {Promise<Array<SaveEmbeddingsResult>>} - Array of processing results.
   */
  async saveEmbeddings (embeddedDocs, opts = {}) {
    const { onProgress, signal, dbOpts } = opts

    this._validateEmbeddedDocs(embeddedDocs)

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    return this.dbAdapter.saveEmbeddings(embeddedDocs, {
      ...dbOpts,
      onProgress,
      signal
    })
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
    const { onProgress, signal, dbOpts, chunkOpts, progressInterval } = opts
    if (opts.chunk === undefined) opts.chunk = true

    if (!embeddingModelId || typeof embeddingModelId !== 'string') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_PARAMS,
        adds: 'embeddingModelId is required and must be a string'
      })
    }

    // Prepare documents: convert to {id, content} objects
    let preparedDocs = null
    let droppedIndices = []

    const inputDocs = typeof docs === 'string' ? [docs] : docs
    const inputCount = inputDocs.length
    this.logger.info(`Starting ingestion of ${inputCount} document(s)`)

    if (opts.chunk) {
      if (signal?.aborted) {
        throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
      }

      this.logger.debug('Phase: Chunking')
      onProgress?.('chunking', 0, inputCount)
      preparedDocs = await this.chunkingService.chunkText(docs, chunkOpts)
      onProgress?.('chunking', inputCount, inputCount)
    } else {
      const result = normalizeDocs(inputDocs)
      preparedDocs = result.normalizedDocs
      droppedIndices = result.droppedIndices
    }

    if (preparedDocs.length === 0) {
      this.logger.warn('No documents to ingest after preparation')
      return {
        processed: [],
        droppedIndices
      }
    }

    // Phase 2: Embedding
    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.debug('Phase: Embedding')
    const embeddingMap = await this.embeddingService.generateEmbeddingsForDocs(
      preparedDocs,
      {
        onProgress: (current, total) => {
          onProgress?.('embedding', current, total)
        },
        signal
      }
    )

    // Attach embeddings to documents
    const embeddedDocs = preparedDocs.map(doc => ({
      ...doc,
      embeddingModelId,
      embedding: embeddingMap[doc.id]
    }))

    // Phase 3: Saving
    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.debug('Phase: Saving')
    const processed = await this.dbAdapter.saveEmbeddings(embeddedDocs, {
      ...dbOpts,
      progressInterval,
      onProgress: (stage, current, total) => {
        onProgress?.(`saving:${stage}`, current, total)
      },
      signal
    })

    this.logger.info(`Ingestion complete: ${processed.length} saved, ${droppedIndices.length} dropped`)

    return {
      processed,
      droppedIndices
    }
  }

  /**
   * Delete embeddings for a set of documents inside the vector database.
   * @param {Array<string>} ids - The ids of the documents to be deleted.
   * @returns {Promise<boolean>} True if the embeddings were deleted
   */
  async deleteEmbeddings (ids) {
    return this.dbAdapter.deleteEmbeddings(ids)
  }
}

module.exports = IngestionService
