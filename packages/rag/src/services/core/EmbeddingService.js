'use strict'

const { QvacErrorRAG, ERR_CODES } = require('../../errors')
const {
  embeddingInputSchema,
  singleEmbeddingSchema,
  batchEmbeddingSchema,
  docsArraySchema
} = require('../../schemas/embedding')
const QvacLogger = require('@qvac/logging')

class EmbeddingService {
  /**
   * @param {Object} config
   * @param {EmbeddingFunction} config.embeddingFunction - The embedding function
   * @param {Logger} [config.logger] - Optional logger instance
   */
  constructor ({ embeddingFunction, logger }) {
    if (!embeddingFunction || typeof embeddingFunction !== 'function') {
      throw new QvacErrorRAG({ code: ERR_CODES.EMBEDDING_FUNCTION_REQUIRED, adds: 'embeddingFunction must be a function that takes text and returns an array of numbers' })
    }
    this.embeddingFunction = embeddingFunction
    this.logger = logger || new QvacLogger()
  }

  /**
   * Generate embeddings for text(s).
   * Supports both single text and batch processing.
   * @param {string|Array<string>} text - The text or array of texts to generate embeddings for.
   * @returns {Promise<Array<number>|Array<Array<number>>>} The embeddings (single array for text, array of arrays for batch).
   */
  async generateEmbeddings (text) {
    let validatedInput
    try {
      validatedInput = embeddingInputSchema.parse(text)
    } catch (error) {
      if (error.name === 'ZodError') {
        const zodIssue = error.issues?.[0]
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: `Input validation failed: ${zodIssue?.message || 'Invalid input'}`,
          cause: error
        })
      }
      throw error
    }

    let embeddings
    try {
      embeddings = await this.embeddingFunction(validatedInput)
    } catch (error) {
      if (error instanceof QvacErrorRAG) {
        throw error
      }
      throw new QvacErrorRAG({
        code: ERR_CODES.GENERATION_FAILED,
        adds: `Failed to generate embeddings: ${error.message}`,
        cause: error
      })
    }

    try {
      if (Array.isArray(validatedInput)) {
        batchEmbeddingSchema.parse(embeddings)
      } else {
        singleEmbeddingSchema.parse(embeddings)
      }
    } catch (error) {
      if (error.name === 'ZodError') {
        const zodIssue = error.issues?.[0]
        throw new QvacErrorRAG({
          code: ERR_CODES.GENERATION_FAILED,
          adds: `Embedding function returned invalid output: ${zodIssue?.message || 'Invalid output format'}`,
          cause: error
        })
      }
      throw error
    }

    return embeddings
  }

  /**
   * Generate embeddings for multiple texts with IDs.
   * Leverages the addon's automatic batch management for optimal performance.
   * Note: Batch embedding is atomic - only reports start/end, not incremental progress.
   * @param {Array<Doc>} docs - Array of documents with id and content.
   * @param {EmbeddingOpts} [opts] - Options for embedding generation.
   * @returns {Promise<{[key: string]: Array<number>}>} Map of document IDs to embeddings.
   */
  async generateEmbeddingsForDocs (docs, opts = {}) {
    let validatedDocs
    try {
      validatedDocs = docsArraySchema.parse(docs)
    } catch (error) {
      if (error.name === 'ZodError') {
        const zodIssue = error.issues?.[0]
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: `Document validation failed: ${zodIssue?.message || 'Invalid documents'}`,
          cause: error
        })
      }
      throw error
    }

    const { onProgress, signal } = opts

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.debug(`Generating embeddings for ${validatedDocs.length} document(s)`)

    const allTexts = validatedDocs.map(doc => doc.content)

    onProgress?.(0, validatedDocs.length)

    let batchEmbeddings
    try {
      batchEmbeddings = await this.embeddingFunction(allTexts)
    } catch (error) {
      if (error instanceof QvacErrorRAG) {
        throw error
      }
      throw new QvacErrorRAG({
        code: ERR_CODES.GENERATION_FAILED,
        adds: `Failed to generate batch embeddings: ${error.message}`,
        cause: error
      })
    }

    try {
      batchEmbeddingSchema.parse(batchEmbeddings)
    } catch (error) {
      if (error.name === 'ZodError') {
        const zodIssue = error.issues?.[0]
        throw new QvacErrorRAG({
          code: ERR_CODES.GENERATION_FAILED,
          adds: `Embedding function returned invalid batch output: ${zodIssue?.message || 'Invalid output format'}`,
          cause: error
        })
      }
      throw error
    }

    const embeddings = {}
    validatedDocs.forEach((doc, idx) => {
      embeddings[doc.id] = batchEmbeddings[idx]
    })

    this.logger.debug(`Embeddings generated: ${Object.keys(embeddings).length}`)

    onProgress?.(validatedDocs.length, validatedDocs.length)

    return embeddings
  }
}

module.exports = EmbeddingService
