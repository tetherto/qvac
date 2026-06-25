'use strict'

const ReadyResource = require('ready-resource')
const { QvacErrorRAG, ERR_CODES } = require('../../errors')

class BaseDBAdapter extends ReadyResource {
  /**
   * @param {Object} config - Configuration object.
   */
  // lunte-disable-next-line no-unused-vars
  constructor(config = {}) {
    super()
    if (new.target === BaseDBAdapter) {
      throw new QvacErrorRAG({ code: ERR_CODES.ABSTRACT_CLASS })
    }
    this.isInitialized = false
  }

  /**
   * Save embeddings for a set of documents inside the vector database.
   * @param {Array<EmbeddedDoc>} docs - The documents with embeddings to be processed.
   * @param {DbOpts} [opts] - The options for the processing.
   * @returns {Promise<Array<SaveEmbeddingsResult>>} - Array of processing results.
   */
  // lunte-disable-next-line require-await
  async saveEmbeddings(docs, opts) {
    throw new QvacErrorRAG({ code: ERR_CODES.NOT_IMPLEMENTED })
  }

  /**
   * Delete embeddings for a set of documents inside the vector database.
   * @param {Array<string>} ids - The ids of the documents to be deleted.
   * @returns {Promise<boolean>} - True if the embeddings were deleted
   */
  // lunte-disable-next-line require-await
  async deleteEmbeddings(ids) {
    throw new QvacErrorRAG({ code: ERR_CODES.NOT_IMPLEMENTED })
  }

  /**
   * Search for documents given a text query.
   * @param {string} query - The search query.
   * @param {Array<number>} queryVector - The query vector.
   * @param {Object} [params] - The parameters for the search..
   * @returns {Promise<Array<SearchResult>>} - An array of search results.
   */
  // lunte-disable-next-line require-await
  async search(query, queryVector, params) {
    throw new QvacErrorRAG({ code: ERR_CODES.NOT_IMPLEMENTED })
  }

  /**
   * Reindex the database to optimize search performance.
   * Default implementation returns not reindexed. Adapters can override.
   * @param {ReindexOpts} [opts] - Options for reindexing.
   * @returns {Promise<ReindexResult>} - Result of the reindex operation.
   */
  // lunte-disable-next-line require-await
  async reindex(opts) {
    return { reindexed: false, details: {} }
  }
}

module.exports = BaseDBAdapter
