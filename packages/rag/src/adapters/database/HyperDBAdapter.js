'use strict'

const BaseDBAdapter = require('./BaseDBAdapter')
const { QvacErrorRAG, ERR_CODES } = require('../../errors')
const {
  cosineSimilarity,
  calculateTextScore,
  heapifyUp,
  heapifyDown,
  reservoirSample,
  createLRUCache
} = require('../../utils/helper')
const QvacLogger = require('@qvac/logging')

let qvacCrypto
try {
  qvacCrypto = require('crypto')
} catch (e) {
  try {
    qvacCrypto = require('bare-crypto')
  } catch (e2) {
    if (typeof global !== 'undefined' && global.crypto && global.crypto.createHash) {
      qvacCrypto = global.crypto
    } else {
      throw new QvacErrorRAG({
        code: ERR_CODES.DEPENDENCY_REQUIRED,
        adds: 'No crypto implementation found. Please ensure a crypto module is available in your environment.'
      })
    }
  }
}

class HyperDBAdapter extends BaseDBAdapter {
  /**
   * @param {Object} config - Configuration object.
   * @param {Corestore} [config.store] - An existing Corestore instance. Required when not providing a hyperdb instance.
   * @param {HyperDB} [config.db] - An existing HyperDB instance to use.
   * @param {string} [config.dbName] - The name of the underlying hypercore.
   * @param {number} [config.NUM_CENTROIDS=16] - The number of centroids to use for the IVF index.
   * @param {number} [config.BUCKET_SIZE=30] - The size of the bucket for the IVF index.
   * @param {number} [config.BATCH_SIZE=100] - The batch size for ingesting documents.
   * @param {number} [config.PROGRESS_INTERVAL=10] - Report progress every N documents during preparation.
   * @param {number} [config.CACHE_SIZE=1000] - The cache size for the document and vector caches.
   * @param {string} [config.documentsTable='@rag/documents'] - The name of the documents table.
   * @param {string} [config.vectorsTable='@rag/vectors'] - The name of the vectors table.
   * @param {string} [config.centroidsTable='@rag/centroids'] - The name of the centroids table.
   * @param {string} [config.invertedIndexTable='@rag/ivfBuckets'] - The name of the inverted index table.
   * @param {string} [config.configTable='@rag/config'] - The name of the config table.
   * @param {Logger} [config.logger] - Optional logger instance
   */
  constructor (config = {}) {
    super(config)
    this.store = config.store || null
    this.db = config.db || null
    this.dbName = config.dbName || 'rag-vector-store'
    this.NUM_CENTROIDS = config.NUM_CENTROIDS || 16
    this.BUCKET_SIZE = config.BUCKET_SIZE || 50
    this.BATCH_SIZE = config.BATCH_SIZE || 100
    this.PROGRESS_INTERVAL = config.PROGRESS_INTERVAL || 10
    this.CACHE_SIZE = config.CACHE_SIZE || 1000

    this.documentsTable = config.documentsTable || '@rag/documents'
    this.vectorsTable = config.vectorsTable || '@rag/vectors'
    this.centroidsTable = config.centroidsTable || '@rag/centroids'
    this.invertedIndexTable = config.invertedIndexTable || '@rag/ivfBuckets'
    this.configTable = config.configTable || '@rag/config'

    this.hypercore = null
    this.documentCache = createLRUCache(this.CACHE_SIZE)
    this.vectorCache = createLRUCache(this.CACHE_SIZE)
    this.centroids = []
    this.logger = config.logger || new QvacLogger()
  }

  /**
   * Get the hypercore instance.
   * @returns {Hypercore} The hypercore instance.
   */
  get core () { return this.hypercore }

  /**
   * Saves embeddings for a set of documents by processing them in batches.
   * Progress is reported with stages: 'deduplicating', 'preparing', 'writing'.
   * @param {Array<EmbeddedDoc>} embeddedDocs - Documents with embeddings to save.
   * @param {SaveEmbeddingsOpts} [opts] - Options for saving.
   * @returns {Promise<Array<SaveEmbeddingsResult>>} - Array of processing results.
   */
  async saveEmbeddings (embeddedDocs, opts = {}) {
    const { onProgress, signal, progressInterval } = opts
    const results = []

    // Validate embeddingModelId is present and consistent across all docs
    if (embeddedDocs.length > 0) {
      const modelIds = new Set(embeddedDocs.map(doc => doc.embeddingModelId).filter(Boolean))

      if (modelIds.size === 0) {
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_PARAMS,
          adds: 'embeddingModelId is required on all EmbeddedDoc objects'
        })
      }

      if (modelIds.size > 1) {
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_PARAMS,
          adds: `All documents must have the same embeddingModelId. Found: ${Array.from(modelIds).join(', ')}`
        })
      }

      const docEmbeddingModelId = Array.from(modelIds)[0]
      const docDimension = embeddedDocs[0].embedding.length

      this.logger.debug(`Saving ${embeddedDocs.length} embedding(s)`)

      if (!this.isInitialized) {
        await this._initialize(embeddedDocs, opts)
      }
      await this._ensureConfig(docEmbeddingModelId, docDimension)
    }

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    const totalDocs = embeddedDocs.length

    // Stage 1: Deduplicating
    onProgress?.('deduplicating', 0, totalDocs)
    const { unique, duplicates } = await this._filterDuplicates(embeddedDocs)
    onProgress?.('deduplicating', totalDocs, totalDocs)

    if (duplicates.length > 0) {
      this.logger.warn(`${duplicates.length} duplicate(s) found`)
    }

    results.push(...duplicates.map(doc => ({
      id: doc.id,
      status: 'rejected',
      error: doc.error
    })))

    const processedDocs = unique
    const uniqueTotal = processedDocs.length
    let preparedCount = 0
    let writtenCount = 0

    for (let i = 0; i < processedDocs.length; i += this.BATCH_SIZE) {
      if (signal?.aborted) {
        throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
      }

      const batch = processedDocs.slice(i, i + this.BATCH_SIZE)

      // Stage 2: Preparing (hash + centroid computation)
      const batchResults = await this._processBatch(batch, {
        signal,
        progressInterval,
        onPrepareProgress: (current) => {
          onProgress?.('preparing', preparedCount + current, uniqueTotal)
        }
      })
      preparedCount += batch.length

      // Stage 3: Writing (after batch transaction completes)
      writtenCount += batch.length
      onProgress?.('writing', writtenCount, uniqueTotal)

      results.push(...batchResults)
    }

    this.logger.info(`Saved ${results.length} embedding(s)`)

    return results
  }

  /**
 * Delete embeddings for a set of documents inside the vector database.
 * @param {Array<string>} ids - The IDs of the documents to be deleted.
 * @returns {Promise<boolean>} - True if the embeddings were deleted
 */
  async deleteEmbeddings (ids) {
    if (!Array.isArray(ids) || ids.length === 0) throw new QvacErrorRAG({ code: ERR_CODES.INVALID_PARAMS })

    this.logger.debug(`Deleting ${ids.length} document(s) from HyperDB`)

    const ops = []
    const tx = await this.db.exclusiveTransaction()
    try {
      for (const id of ids) {
        ops.push(tx.delete(this.documentsTable, { id }))
        ops.push(tx.delete(this.vectorsTable, { docId: id }))
        this.documentCache.delete(id)
        this.vectorCache.delete(id)
      }

      for (let i = 0; i < this.NUM_CENTROIDS; i++) {
        const centroidId = `centroid-${i}`
        const bucket = await this._getBucket(tx, centroidId)
        const updatedBucket = bucket.filter(docId => !ids.includes(docId))
        if (updatedBucket.length !== bucket.length) {
          ops.push(tx.insert(this.invertedIndexTable, {
            centroidId,
            documentIds: updatedBucket,
            capacity: this.BUCKET_SIZE,
            createdAt: new Date(),
            updatedAt: new Date()
          }))
        }
      }
      await Promise.all(ops)
      await tx.flush()

      this.logger.info(`Deleted ${ids.length} document(s) from HyperDB`)

      return true
    } catch (error) {
      this.logger.error('Delete embeddings failed:', error)
      throw new QvacErrorRAG({ code: ERR_CODES.DB_OPERATION_FAILED, adds: error.message, cause: error })
    } finally {
      await tx.close()
    }
  }

  /**
   * Search for documents given a text query.
   * Uses IVF buckets and ranking based on cosine similarity and text score.
   * @param {string} query - The search query.
   * @param {Array<number>} queryVector - The query vector.
   * @param {Object} [params] - Parameters for the search.
   * @param {number} [params.topK=5] - The number of results to return.
   * @param {number} [params.n=3] - The number of centroids to use for the IVF index.
   * @param {AbortSignal} [params.signal] - Signal for cancellation.
   * @returns {Promise<Array<SearchResult>>} The top matching results.
   */
  async search (query, queryVector, params = {}) {
    const { topK = 5, n = 3, signal } = params
    if (!this.isInitialized) throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.debug(`HyperDB search: topK=${topK}, n=${n}, centroids=${this.centroids.length}`)

    let candidateIds = new Set()
    const topCentroids = this._findTopNCentroids(queryVector, n)
    const dbSnapshot = this.db.snapshot()

    const bucketPromises = topCentroids.map(({ index }) => {
      const centroidId = `centroid-${index}`
      return this._getBucket(dbSnapshot, centroidId)
    })
    const buckets = await Promise.all(bucketPromises)

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    buckets.forEach(bucket => {
      bucket.forEach(id => candidateIds.add(id))
    })

    if (!candidateIds.size) {
      this.logger.debug('No candidates in top centroids, expanding search')
      candidateIds = await this._progressiveCentroidExpansion(dbSnapshot, queryVector, n)
    }

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    const candidateIdsArray = Array.from(candidateIds)
    this.logger.debug(`Scoring ${candidateIdsArray.length} candidate(s)`)

    const [vectorMap, contentMap] = await Promise.all([
      this._getVectors(dbSnapshot, candidateIdsArray),
      this._getDocumentContents(dbSnapshot, candidateIdsArray)
    ])

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    const results = []
    for (const id of candidateIdsArray) {
      const vector = vectorMap.get(id)
      const content = contentMap.get(id)
      if (!vector || !content) continue

      const vectorScore = cosineSimilarity(queryVector, vector)
      const textScore = calculateTextScore(query, content)
      const finalScore = (vectorScore * 0.7) + (textScore * 0.3) // todo: would weight be configurable?

      results.push({ id, content, score: finalScore })
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK)
  }

  /**
   * Reindex the database by rebalancing centroids using k-means clustering.
   * Call periodically for large datasets to improve search quality.
   * @param {ReindexOpts} [opts] - Options for reindexing.
   * @returns {Promise<ReindexResult>}
   */
  async reindex (opts = {}) {
    const { onProgress, signal } = opts

    if (!this.isInitialized) {
      throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })
    }

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.info('Starting reindex...')

    const snapshot = this.db.snapshot()

    // Stage 1: Collect all vectors
    onProgress?.('collecting', 0, 1)
    const allVectors = await this._getAllEntries(snapshot, this.vectorsTable)

    if (allVectors.length < this.NUM_CENTROIDS) {
      this.logger.warn(`Insufficient documents for reindex: ${allVectors.length} < ${this.NUM_CENTROIDS}`)
      return { reindexed: false, details: { reason: 'insufficient documents', documentCount: allVectors.length, centroidCount: this.centroids.length } }
    }

    this.logger.debug(`Collected ${allVectors.length} vectors`)
    onProgress?.('collecting', 1, 1)

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    // Stage 2: Run k-means clustering
    onProgress?.('clustering', 0, 1)
    const vectors = allVectors.map(v => v.vector)
    const docIds = allVectors.map(v => v.docId)
    const newCentroids = this._kMeans(vectors, this.NUM_CENTROIDS, 10)
    onProgress?.('clustering', 1, 1)

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    // Stage 3: Reassign documents to new centroids
    onProgress?.('reassigning', 0, vectors.length)
    const newBuckets = new Map()
    for (let i = 0; i < this.NUM_CENTROIDS; i++) {
      newBuckets.set(`centroid-${i}`, [])
    }

    for (let i = 0; i < vectors.length; i++) {
      const vector = vectors[i]
      const docId = docIds[i]

      // Find nearest centroid
      let bestIdx = 0
      let bestSim = -Infinity
      for (let j = 0; j < newCentroids.length; j++) {
        const sim = cosineSimilarity(vector, newCentroids[j])
        if (sim > bestSim) {
          bestSim = sim
          bestIdx = j
        }
      }

      newBuckets.get(`centroid-${bestIdx}`).push(docId)

      if ((i + 1) % 100 === 0 || i === vectors.length - 1) {
        onProgress?.('reassigning', i + 1, vectors.length)
      }
    }

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    // Stage 4: Update database
    onProgress?.('updating', 0, this.NUM_CENTROIDS * 2)
    const tx = await this.db.exclusiveTransaction()
    const now = new Date()

    try {
      // Update centroids
      for (let i = 0; i < newCentroids.length; i++) {
        const centroidId = `centroid-${i}`
        await tx.insert(this.centroidsTable, {
          id: centroidId,
          vector: newCentroids[i],
          index: i,
          createdAt: now,
          updatedAt: now
        })
        onProgress?.('updating', i + 1, this.NUM_CENTROIDS * 2)
      }

      // Update buckets
      for (let i = 0; i < this.NUM_CENTROIDS; i++) {
        const centroidId = `centroid-${i}`
        const documentIds = newBuckets.get(centroidId) || []
        await tx.insert(this.invertedIndexTable, {
          centroidId,
          documentIds,
          capacity: this.BUCKET_SIZE,
          createdAt: now,
          updatedAt: now
        })
        onProgress?.('updating', this.NUM_CENTROIDS + i + 1, this.NUM_CENTROIDS * 2)
      }

      await tx.flush()

      // Update in-memory centroids
      this.centroids = newCentroids

      this.logger.info(`Reindex complete: ${vectors.length} document(s), ${newCentroids.length} centroid(s)`)

      return { reindexed: true, details: { documentCount: vectors.length, centroidCount: newCentroids.length } }
    } catch (error) {
      this.logger.error('Reindex failed:', error)
      throw new QvacErrorRAG({ code: ERR_CODES.DB_OPERATION_FAILED, adds: error.message, cause: error })
    } finally {
      await tx.close()
    }
  }

  /**
   * @private
   */
  _kMeans (vectors, k, maxIterations = 10) {
    if (vectors.length === 0) return []
    if (vectors.length <= k) return vectors.slice()

    const dim = vectors[0].length

    const centroids = []
    const usedIndices = new Set()

    // First centroid: random
    const idx = Math.floor(Math.random() * vectors.length)
    centroids.push([...vectors[idx]])
    usedIndices.add(idx)

    // Remaining centroids: weighted by distance to nearest existing centroid
    while (centroids.length < k) {
      let maxDist = -Infinity
      let bestIdx = 0

      for (let i = 0; i < vectors.length; i++) {
        if (usedIndices.has(i)) continue

        // Find distance to nearest centroid
        let minDist = Infinity
        for (const c of centroids) {
          const sim = cosineSimilarity(vectors[i], c)
          const dist = 1 - sim
          if (dist < minDist) minDist = dist
        }

        if (minDist > maxDist) {
          maxDist = minDist
          bestIdx = i
        }
      }

      centroids.push([...vectors[bestIdx]])
      usedIndices.add(bestIdx)
    }

    // Run k-means iterations
    for (let iter = 0; iter < maxIterations; iter++) {
      const assignments = new Array(k).fill(null).map(() => [])

      for (const vector of vectors) {
        let bestIdx = 0
        let bestSim = -Infinity
        for (let j = 0; j < centroids.length; j++) {
          const sim = cosineSimilarity(vector, centroids[j])
          if (sim > bestSim) {
            bestSim = sim
            bestIdx = j
          }
        }
        assignments[bestIdx].push(vector)
      }

      // Update centroids to be mean of assigned vectors
      let converged = true
      for (let j = 0; j < k; j++) {
        if (assignments[j].length === 0) continue

        const newCentroid = new Array(dim).fill(0)
        for (const v of assignments[j]) {
          for (let d = 0; d < dim; d++) {
            newCentroid[d] += v[d]
          }
        }
        for (let d = 0; d < dim; d++) {
          newCentroid[d] /= assignments[j].length
        }

        // Check convergence
        const sim = cosineSimilarity(centroids[j], newCentroid)
        if (sim < 0.9999) converged = false

        centroids[j] = newCentroid
      }

      if (converged) break
    }

    return centroids
  }

  /**
   * Replicate the hypercore with another hypercore.
   * @param {Hypercore} otherHypercore - The other hypercore to replicate with.
   * @returns {Promise<Object>} An object containing the two streams and a destroy function.
   */
  async replicateWith (otherHypercore) {
    if (!this.isInitialized || !this.hypercore) {
      throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })
    }
    const s1 = this.hypercore.replicate(true)
    const s2 = otherHypercore.replicate(false)
    s1.pipe(s2).pipe(s1)
    return {
      stream1: s1,
      stream2: s2,
      destroy: () => {
        s1.destroy()
        s2.destroy()
      }
    }
  }

  /**
   * Initializes the underlying database connection and ensures that it is ready for use.
   * @private
   */
  async _open () {
    this.logger.info('Opening HyperDB connection...')

    // If a HyperDB instance was provided in constructor, use it
    if (this.db) {
      await this.db.ready()
      this.hypercore = this.db.core
      await this._checkIsInitialized()
      this.logger.info('HyperDB ready (using provided instance)')
      return
    }

    await this._validateDependencies()

    const HyperDB = await import('hyperdb')
    const hyperDBModule = HyperDB.default || HyperDB

    if (!this.hypercore) {
      if (!this.store) {
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_PARAMS,
          adds: 'A Corestore instance is required when not providing an existing HyperDB instance. '
        })
      }
      await this.store.ready()
      this.hypercore = this.store.get({ name: this.dbName })
    }
    const dbSpecModule = await import('./hyperspec/hyperdb/index.js')
    const dbSpec = await (dbSpecModule.default || dbSpecModule)
    this.db = hyperDBModule.bee(this.hypercore, dbSpec, { autoUpdate: true })
    await this.db.ready()
    await this._checkIsInitialized()

    this.logger.info('HyperDB ready')
  }

  /**
   * Close the adapter and release resources.
   * @private
   */
  async _close () {
    if (this.db) {
      this.logger.info('Closing HyperDB connection...')
      this.documentCache.clear()
      this.vectorCache.clear()
      this.centroids = []
      this.isInitialized = false
      await this.db.close()
      this.logger.debug('HyperDB closed')
    }
  }

  /**
   * Finds the top N centroids based on cosine similarity.
   * @param {Array<number>} vector - The vector to find centroids for.
   * @param {number} [n=3] - The number of centroids to return.
   * @returns {Array<{index: number, similarity: number}>} Top N centroids.
   */
  _findTopNCentroids (vector, n = 3) {
    const topCentroids = []

    for (let i = 0; i < this.centroids.length; i++) {
      const centroid = this.centroids[i]
      if (!Array.isArray(centroid) || centroid.length === 0) continue

      const similarity = cosineSimilarity(vector, centroid)
      const centroidInfo = { index: i, similarity }

      if (topCentroids.length < n) {
        topCentroids.push(centroidInfo)
        heapifyUp(topCentroids, topCentroids.length - 1)
      } else {
        if (similarity > topCentroids[0].similarity) {
          topCentroids[0] = centroidInfo
          heapifyDown(topCentroids, 0)
        }
      }
    }
    return topCentroids.sort((a, b) => b.similarity - a.similarity)
  }

  /**
   * Initialize the adapter by setting up centroids.
   * @param {Array<EmbeddedDoc>} [docs] - Array of documents with embeddings for initial ingestion.
   * @param {DbOpts} [opts] - Additional options.
   * @private
   */
  async _initialize (docs, opts = {}) {
    this.logger.info('Initializing HyperDB...')

    const tx = await this.db.exclusiveTransaction()
    try {
      if (docs && docs.length) {
        this.logger.debug(`Creating ${this.NUM_CENTROIDS} centroids from initial documents`)
        const shuffled = docs.slice()
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }
        const docsForCreatingCentroids = shuffled.slice(0, this.NUM_CENTROIDS)
        const embeddingsForCentroids = docsForCreatingCentroids
          .filter(doc => doc.embedding && Array.isArray(doc.embedding))
          .map(doc => doc.embedding)

        this.centroids = embeddingsForCentroids

        const ops = this.centroids.map((centroid, i) => {
          const centroidId = `centroid-${i}`
          const now = new Date()
          return tx.insert(this.centroidsTable, {
            id: centroidId,
            vector: centroid,
            index: i,
            createdAt: now
          })
        })
        await Promise.all(ops)
        await tx.flush()
      } else {
        this.logger.debug('Loading existing centroids from database')
        for (let i = 0; i < this.NUM_CENTROIDS; i++) {
          const centroidId = `centroid-${i}`
          const entry = await tx.get(this.centroidsTable, { id: centroidId })
          if (entry && entry.vector) {
            this.centroids[i] = Array.isArray(entry.vector) ? entry.vector : []
          }
        }
      }
      this.centroids = this.centroids.filter(v => Array.isArray(v) && v.length > 0)
      this.isInitialized = this.centroids.length > 0
      if (!this.isInitialized) throw new QvacErrorRAG({ code: ERR_CODES.CENTROIDS_INITIALIZATION_FAILURE })
      this.logger.info(`HyperDB initialized with ${this.centroids.length} centroid(s)`)
    } catch (error) {
      this.logger.error('HyperDB initialization failed:', error)
      throw new QvacErrorRAG({ code: ERR_CODES.DB_OPERATION_FAILED, adds: error.message, cause: error })
    } finally {
      await tx.close()
    }
  }

  async _checkIsInitialized () {
    if (this.isInitialized) return

    this.centroids = [] // reset centroids

    const tx = await this.db.exclusiveTransaction()
    try {
      for (let i = 0; i < this.NUM_CENTROIDS; i++) {
        const centroidId = `centroid-${i}`
        const entry = await tx.get(this.centroidsTable, { id: centroidId })
        if (entry && entry.vector) {
          this.centroids[i] = Array.isArray(entry.vector) ? entry.vector : []
        }
      }
      this.centroids = this.centroids.filter(v => Array.isArray(v) && v.length > 0)
      this.isInitialized = this.centroids.length > 0
    } catch (error) {
      throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED, adds: error.message, cause: error })
    } finally {
      await tx.close()
    }
  }

  /**
   * Ensure config exists with the given embeddingModelId.
   * Creates config if not exists, validates if exists.
   * @param {string} embeddingModelId - The embedding model ID
   * @private
   */
  async _ensureConfig (embeddingModelId, dimension) {
    const storedConfig = await this.getConfig()

    if (!storedConfig) {
      await this._persistConfig(embeddingModelId, dimension)
      this.logger?.info(`Initialized config: embeddingModelId=${embeddingModelId}, dimension=${dimension}`)
    } else if (storedConfig.embeddingModelId !== embeddingModelId) {
      throw new QvacErrorRAG({
        code: ERR_CODES.EMBEDDING_MODEL_MISMATCH,
        adds: `RAG DB configured for model '${storedConfig.embeddingModelId}', but documents use '${embeddingModelId}'`
      })
    } else if (storedConfig.dimension !== dimension) {
      throw new QvacErrorRAG({
        code: ERR_CODES.EMBEDDING_DIMENSION_MISMATCH,
        adds: `RAG DB configured for dimension '${storedConfig.dimension}', but documents use '${dimension}'`
      })
    }
  }

  /**
   * Persist config to database.
   * @param {string} embeddingModelId - The embedding model ID from the documents
   * @param {number} dimension - The embedding dimension from the documents
   * @private
   */
  async _persistConfig (embeddingModelId, dimension) {
    const now = new Date()
    const tx = await this.db.exclusiveTransaction()
    try {
      await tx.insert(this.configTable, {
        key: 'adapter',
        embeddingModelId,
        dimension,
        NUM_CENTROIDS: this.NUM_CENTROIDS,
        BUCKET_SIZE: this.BUCKET_SIZE,
        BATCH_SIZE: this.BATCH_SIZE,
        createdAt: now
      })
      await tx.flush()
    } catch (error) {
      throw new QvacErrorRAG({ code: ERR_CODES.DB_OPERATION_FAILED, adds: `Failed to persist config: ${error.message}`, cause: error })
    } finally {
      await tx.close()
    }
  }

  /**
   * Get stored adapter configuration.
   * @returns {Promise<HyperDBAdapterConfig|null>} The stored config or null if not configured
   */
  async getConfig () {
    if (!this.db) {
      throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })
    }
    const snapshot = this.db.snapshot()
    try {
      const result = await snapshot.get(this.configTable, { key: 'adapter' })
      return result || null
    } catch (error) {
      // If config table doesn't exist yet or other DB errors, return null
      return null
    }
  }

  /**
   * Generates and stores embeddings for a batch of documents.
   * @param {Array<EmbeddedDoc>} docs - Array of documents with embeddings.
   * @param {SaveEmbeddingsOpts} [opts] - Options for saving.
   * @returns {Promise<Array<SaveEmbeddingsResult>>} - Array of processing results.
   * @private
   */
  async _processBatch (docs, opts = {}) {
    if (!this.isInitialized) throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })

    const { signal, onPrepareProgress, progressInterval = this.PROGRESS_INTERVAL } = opts
    const results = []
    const bucketUpdates = new Map()
    const now = new Date()

    // Prepare docs with progress reporting
    const preparedDocs = []
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]
      const contentHash = qvacCrypto.createHash('sha256').update(doc.content).digest('hex')
      const centroidId = this.centroids.length
        ? `centroid-${this._findTopNCentroids(doc.embedding, 1)[0].index}`
        : null

      preparedDocs.push({
        id: doc.id,
        index: i,
        vector: doc.embedding,
        content: doc.content,
        contentHash,
        metadata: doc.metadata || {},
        embeddingModelId: doc.embeddingModelId,
        dimension: doc.embedding.length,
        centroidId
      })

      if ((i + 1) % progressInterval === 0 || i === docs.length - 1) {
        onPrepareProgress?.(i + 1)
      }
    }

    // Handle insertions of documents and vectors
    if (preparedDocs.length > 0) {
      if (signal?.aborted) {
        throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
      }

      const tx = await this.db.exclusiveTransaction()
      try {
        const operations = []

        preparedDocs.forEach(doc => {
          operations.push({
            type: 'document',
            index: doc.index,
            operation: () => tx.insert(this.documentsTable, {
              id: doc.id,
              content: doc.content,
              contentHash: doc.contentHash,
              metadata: doc.metadata,
              createdAt: now,
              updatedAt: now
            })
          })

          operations.push({
            type: 'vector',
            index: doc.index,
            operation: () => tx.insert(this.vectorsTable, {
              docId: doc.id,
              vector: doc.vector,
              createdAt: now
            })
          })

          this._updateCaches({ id: doc.id, content: doc.content }, doc.vector)

          // Prepare bucket updates
          if (doc.centroidId) {
            if (!bucketUpdates.has(doc.centroidId)) {
              bucketUpdates.set(doc.centroidId, {
                docIds: new Set(),
                updatedAt: now
              })
            }
            bucketUpdates.get(doc.centroidId).docIds.add(doc.id)
          }
        })

        // Execute all operations within the transaction
        const operationPromises = operations.map((op) => {
          return op.operation()
            .then(() => ({ type: op.type, index: op.index, status: 'fulfilled' }))
            .catch(error => ({
              type: op.type,
              index: op.index,
              status: 'rejected',
              error: error.message || 'Database operation failed'
            }))
        })
        const operationResults = await Promise.all(operationPromises)

        // Process results
        const docResults = new Map()
        operationResults.forEach((result, index) => {
          const op = operations[index]
          if (op && (op.type === 'document' || op.type === 'vector')) {
            const docIndex = op.index
            if (!docResults.has(docIndex)) {
              docResults.set(docIndex, {
                id: preparedDocs[docIndex].id,
                status: result.status,
                error: result.status === 'rejected' ? result.error : undefined
              })
            }
          }
        })

        if (bucketUpdates.size > 0) {
          await this._updateBuckets(tx, bucketUpdates, now)
        }

        await tx.flush()
        results.push(...Array.from(docResults.values()))
      } catch (error) {
        preparedDocs.forEach(doc => {
          results.push({
            id: doc.id,
            status: 'rejected',
            error: error.message || 'Batch insertion failed'
          })
        })
      } finally {
        await tx.close()
      }
    }
    return results
  }

  /**
   * Updates the caches with the new document and vector.
   * @param {Doc} doc - The document to update the caches with.
   * @param {Array<number>} vector - The vector to update the caches with.
   * @private
   */
  _updateCaches (doc, vector) {
    this.documentCache.set(doc.id, doc.content)
    this.vectorCache.set(doc.id, vector)
  }

  /**
   * Updates the inverted index buckets with new document IDs.
   * @param {Transaction} tx - The database snapshot to use for the updates.
   * @param {Map<string, {docIds: Set<string>, updatedAt: Date}>} bucketUpdates - Map of centroid IDs to updates.
   * @param {Date} now - Current timestamp.
   * @private
   */
  async _updateBuckets (tx, bucketUpdates, now) {
    const bucketPromises = Array.from(bucketUpdates.entries()).map(([centroidId, update]) => {
      return tx.get(this.invertedIndexTable, { centroidId })
        .then(existingBucket => {
          const newDocIds = Array.from(update.docIds)

          if (!existingBucket) {
            return tx.insert(this.invertedIndexTable, {
              centroidId,
              documentIds: newDocIds,
              capacity: this.BUCKET_SIZE,
              createdAt: now,
              updatedAt: now
            })
          }

          const updatedBucket = [...existingBucket.documentIds]
          let hasChanges = false

          newDocIds.forEach(docId => {
            if (!updatedBucket.includes(docId)) {
              updatedBucket.push(docId)
              hasChanges = true
              if (updatedBucket.length > this.BUCKET_SIZE) {
                updatedBucket.shift()
              }
            }
          })

          if (hasChanges) {
            return tx.insert(this.invertedIndexTable, {
              centroidId,
              documentIds: updatedBucket,
              capacity: this.BUCKET_SIZE,
              createdAt: existingBucket.createdAt,
              updatedAt: now
            })
          }
        })
        .catch(error => {
          throw new QvacErrorRAG({ code: ERR_CODES.DB_OPERATION_FAILED, adds: `Failed to update bucket ${centroidId}: ${error.message}`, cause: error })
        })
    })
    await Promise.all(bucketPromises)
  }

  /**
   * Retrieves the bucket associated with the specified centroid ID from the inverted index table.
   * @param {HyperDB} snapshot - The database snapshot to use.
   * @param {string} centroidId - The centroid ID to get the bucket for.
   * @returns {Promise<Array<string>>} The document IDs in the bucket.
   * @private
   */
  async _getBucket (snapshot, centroidId) {
    let bucket = []
    const bucketEntry = await snapshot.get(this.invertedIndexTable, { centroidId })
    if (bucketEntry && Array.isArray(bucketEntry.documentIds)) {
      bucket = bucketEntry.documentIds
    }
    return bucket
  }

  /**
   * Retrieves all entries from a table.
   * @param {string} table - The table to retrieve entries from.
   * @returns {Promise<Array>} The entries.
   * @private
   */
  async _getAllEntries (snapshot, table) {
    return snapshot.find(table).toArray()
  }

  /**
   * Batch retrieve multiple vectors by docIds.
   * @param {HyperDB} snapshot - The database snapshot to use.
   * @param {Array<string>} docIds - Array of document IDs.
   * @returns {Promise<Map<string, Array<number>>>} Map of docId to vector.
   * @private
   */
  async _getVectors (snapshot, docIds) {
    const vectorMap = new Map()
    const vectorPromises = docIds.map((docId) => {
      let vector = this.vectorCache.get(docId)
      if (vector) {
        return Promise.resolve({ docId, vector })
      }
      return snapshot.get(this.vectorsTable, { docId })
        .then(vectorEntry => {
          if (vectorEntry && Array.isArray(vectorEntry.vector)) {
            vector = vectorEntry.vector
            this.vectorCache.set(docId, vector)
          }
          return { docId, vector }
        })
    })
    const results = await Promise.all(vectorPromises)
    results.forEach(({ docId, vector }) => {
      if (vector) {
        vectorMap.set(docId, vector)
      }
    })

    return vectorMap
  }

  /**
   * Batch retrieve multiple document contents by IDs.
   * @param {HyperDB} snapshot - The database snapshot to use.
   * @param {Array<string>} ids - Array of document IDs.
   * @returns {Promise<Map<string, string>>} Map of id to content.
   * @private
   */
  async _getDocumentContents (snapshot, ids) {
    const contentMap = new Map()
    const contentPromises = ids.map((id) => {
      let content = this.documentCache.get(id)
      if (content) {
        return Promise.resolve({ id, content })
      }
      return snapshot.get(this.documentsTable, { id })
        .then(docEntry => {
          if (docEntry) {
            content = docEntry.content
            this.documentCache.set(id, content)
          }
          return { id, content }
        })
    })

    const results = await Promise.all(contentPromises)
    results.forEach(({ id, content }) => {
      if (content) {
        contentMap.set(id, content)
      }
    })
    return contentMap
  }

  /**
  * Progressive centroid expansion for smart fallback when no candidates are found.
  * Gradually expands the search scope by including more centroids until sufficient candidates are found.
  * @param {HyperDB} snapshot - The database snapshot to use.
  * @param {Array<number>} queryVector - The query vector.
  * @param {number} initialN - The initial number of centroids to try.
  * @param {number} [minCandidates=10] - Minimum number of candidates to find before stopping.
  * @param {number} [maxExpansions=5] - Maximum number of expansion steps.
  * @returns {Promise<Set<string>>} Set of candidate document IDs.
  * @private
  */
  async _progressiveCentroidExpansion (snapshot, queryVector, initialN, minCandidates = 10, maxExpansions = 5) {
    const candidateIds = new Set()
    let centroidCount = initialN
    let expansionStep = 0

    while (candidateIds.size < minCandidates && expansionStep < maxExpansions && centroidCount <= this.NUM_CENTROIDS) {
      const topCentroids = this._findTopNCentroids(queryVector, centroidCount)
      const bucketPromises = topCentroids.map(({ index }) => {
        const centroidId = `centroid-${index}`
        return this._getBucket(snapshot, centroidId)
      })
      const buckets = await Promise.all(bucketPromises)
      buckets.forEach(bucket => {
        bucket.forEach(docId => {
          candidateIds.add(docId)
        })
      })
      if (candidateIds.size >= minCandidates) {
        break
      }
      centroidCount = Math.min(centroidCount + 3, this.NUM_CENTROIDS)
      expansionStep++
    }

    if (candidateIds.size < minCandidates && expansionStep >= maxExpansions) {
      const allDocs = await this._getAllEntries(snapshot, this.documentsTable)
      const sampleSize = Math.min(50, allDocs.length)
      const sample = reservoirSample(allDocs, sampleSize)
      sample.forEach(doc => {
        candidateIds.add(doc.id)
      })
    }
    return candidateIds
  }

  /**
   * Filter out duplicate documents that already exist in the database.
   * Uses contentHash field on documents table for efficient duplicate detection.
   * @param {Array<EmbeddedDoc>} docs - The documents to check for duplicates.
   * @returns {Promise<{unique: Array<EmbeddedDoc>, duplicates: Array<{id: string, error: string}>}>} Separated unique and duplicate documents.
   * @private
   */
  async _filterDuplicates (docs) {
    const dbSnapshot = this.db.snapshot()
    const unique = []
    const duplicates = []
    const seenInBatch = new Map()

    const docsWithHashes = docs.map(doc => ({
      doc,
      hash: qvacCrypto.createHash('sha256').update(doc.content).digest('hex')
    }))

    // Check for duplicates within the batch first
    const batchUnique = []
    for (const { doc, hash } of docsWithHashes) {
      if (seenInBatch.has(hash)) {
        duplicates.push({
          id: seenInBatch.get(hash),
          error: 'Duplicate document found in current batch'
        })
      } else {
        batchUnique.push({ doc, hash })
        seenInBatch.set(hash, doc.id)
      }
    }

    const dbLookupPromises = batchUnique.map(({ doc, hash }) =>
      dbSnapshot.findOne('@rag/doc-by-content-hash', { gte: { contentHash: hash }, lte: { contentHash: hash } })
        .then(existingDoc => ({ doc, hash, existingDoc }))
    )

    const dbResults = await Promise.all(dbLookupPromises)

    for (const { doc, existingDoc } of dbResults) {
      if (existingDoc) {
        duplicates.push({
          id: existingDoc.id,
          error: 'Document already exists in database'
        })
      } else {
        unique.push(doc)
      }
    }
    return { unique, duplicates }
  }

  /**
   * Validate that all required dependencies are available.
   * @private
   */
  async _validateDependencies () {
    const missing = []

    try {
      await import('hyperdb')
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND') {
        missing.push('hyperdb')
      }
    }

    try {
      await import('hyperschema')
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND') {
        missing.push('hyperschema')
      }
    }

    if (missing.length > 0) {
      throw new QvacErrorRAG({
        code: ERR_CODES.DEPENDENCY_REQUIRED,
        adds: `HyperDBAdapter requires the following dependencies: ${missing.join(', ')}.`
      })
    }
  }
}

module.exports = HyperDBAdapter
