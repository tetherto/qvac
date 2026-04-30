'use strict'

/**
 * @typedef {Object} PartialDoc
 * @property {string} content - The content of the document.
 * @property {string} [id] - The identifier of the document.
 */

/**
 * @typedef {Object} Doc
 * @property {string} content - The content of the document.
 * @property {string} id - The identifier of the document.
 */

/**
 * @typedef {Object} EmbeddedDoc
 * @property {string} content - The content of the document.
 * @property {string} id - The identifier of the document.
 * @property {string} embeddingModelId - The ID of the embedding model used to generate the embedding.
 * @property {Array<number>} embedding - The embedding of the document.
 */

/**
 * @typedef {Object} BaseDBAdapterConfig
 * @property {string} embeddingModelId - The embedding model ID.
 * @property {number} dimension - The embedding vector dimension.
 * @property {Date} createdAt - The timestamp when config was created.
 */

/**
 * @typedef {Object} HyperDBAdapterConfig
 * @property {string} key - The config key (always 'adapter').
 * @property {string} embeddingModelId - The embedding model ID.
 * @property {number} dimension - The embedding vector dimension.
 * @property {Date} createdAt - The timestamp when config was created.
 * @property {number} NUM_CENTROIDS - The number of centroids for IVF index.
 * @property {number} BUCKET_SIZE - The bucket size for IVF index.
 * @property {number} BATCH_SIZE - The batch size for document processing.
 */

/**
 * @typedef {Object} SaveEmbeddingsResult
 * @property {'fulfilled' | 'rejected'} status - The status of the processing
 * @property {string} [id] - The ID of the document.
 * @property {string} [error] - The error that occurred during processing.
 */

/**
 * @typedef {Object} SearchResult
 * @property {string} id - The ID of the document.
 * @property {string} content - The content of the document.
 * @property {number} score - The score of the document.
 * @property {Object} _debug - Debug information
 */

/**
 * @typedef {Object} ChunkOpts
 * @property {*} [key] - Additional chunking options.
 */

/**
 * @typedef {Object} DbOpts
 * @property {*} [key] - Additional database options.
 */

/**
 * @typedef {Object} LLMChunkOpts
 * @property {number} [chunkSize=256] - Maximum size of each chunk in tokens. (default: 256)
 * @property {number} [chunkOverlap=50] - Number of tokens to overlap between chunks. (default: 50)
 * @property {'character'|'paragraph'} [chunkStrategy='paragraph'] - Chunking strategy to use. Determines how chunks are grouped. (default: 'paragraph')
 * @property {'character'|'word'|'sentence'|'line'} [splitStrategy='word'] - Predefined split strategy for tokenization. If both splitter and splitStrategy are provided, splitter takes precedence. (default: 'word')
 * @property {Function} [splitter] - Custom function to split text into tokens. Takes a string and returns an array of strings. If provided, takes precedence over splitStrategy.
 */

/**
 * @typedef {Object} QvacLlmAddon
 * @property {Function} run - Function that runs LLM inference. Takes (messages, opts) and returns Promise<QvacResponse>
 */

/**
 * @typedef {Function} EmbeddingFunction
 * @param {string|Array<string>} text - Single text or array of texts to generate embeddings for
 * @returns {Promise<Array<number>|Array<Array<number>>>} Single embedding or array of embeddings
 */

/**
 * @typedef {Object} EmbeddingOpts
 * @property {Function} [onProgress] - Progress callback (current, total)
 * @property {AbortSignal} [signal] - Signal for cancellation
 */

/**
 * @typedef {'deduplicating' | 'preparing' | 'writing'} SaveStage
 */

/**
 * @typedef {Object} SaveEmbeddingsOpts
 * @property {DbOpts} [dbOpts] - Options for the database adapter
 * @property {Function} [onProgress] - Progress callback: onProgress(stage, current, total). Stage: 'deduplicating' | 'preparing' | 'writing'
 * @property {number} [progressInterval] - Report 'preparing' progress every N documents (default: 10)
 * @property {AbortSignal} [signal] - Signal for cancellation
 */

/**
 * @typedef {'chunking' | 'embedding' | 'saving:deduplicating' | 'saving:preparing' | 'saving:writing'} IngestStage
 */

/**
 * @typedef {Object} IngestOpts
 * @property {boolean} [chunk] - Whether to chunk the documents (default: true)
 * @property {ChunkOpts} [chunkOpts] - Options for chunking
 * @property {DbOpts} [dbOpts] - Options for the database adapter
 * @property {Function} [onProgress] - Progress callback: onProgress(stage, current, total). Stage: 'chunking' | 'embedding' | 'saving:deduplicating' | 'saving:preparing' | 'saving:writing'
 * @property {number} [progressInterval] - Report 'saving:preparing' progress every N documents (default: 10)
 * @property {AbortSignal} [signal] - Signal for cancellation
 */

/**
 * @typedef {'collecting' | 'clustering' | 'reassigning' | 'updating'} ReindexStage
 */

/**
 * @typedef {Object} ReindexOpts
 * @property {Function} [onProgress] - Progress callback: onProgress(stage, current, total). Stage: 'collecting' | 'clustering' | 'reassigning' | 'updating'
 * @property {AbortSignal} [signal] - Signal for cancellation
 */

/**
 * @typedef {Object} ReindexResult
 * @property {boolean} reindexed - Whether reindexing was performed
 * @property {Object} [details] - Adapter-specific details about the reindex operation
 */

/**
 * @typedef {Object} SearchOpts
 * @property {number} [topK=5] - Number of top results to retrieve
 * @property {number} [n=3] - Number of centroids to use for IVF index
 * @property {AbortSignal} [signal] - Signal for cancellation
 */

/**
 * @typedef {Object} InferOpts
 * @property {number} [topK=5] - Number of top results to retrieve for context
 * @property {number} [n=3] - Number of centroids to use for IVF index
 * @property {BaseLlmAdapter} [llmAdapter] - Override the default LLM adapter
 * @property {AbortSignal} [signal] - Signal for cancellation
 */

/**
 * @typedef {Object} GenerateEmbeddingsOpts
 * @property {boolean} [chunk=true] - Whether to chunk the documents
 * @property {ChunkOpts} [chunkOpts] - Options for chunking
 * @property {AbortSignal} [signal] - Signal for cancellation
 */
