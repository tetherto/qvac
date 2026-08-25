import HyperDB from 'hyperdb'
import type {
  Corestore,
  Hypercore,
  ReplicationStream,
  HyperDBInstance,
  HyperDBReader,
  HyperDBTransaction
} from './db-types.js'
import QvacLogger from '@qvac/logging'
import type { LoggerInterface } from '@qvac/logging'

import { BaseDBAdapter } from './BaseDBAdapter.js'
import dbSpec from './hyperspec/hyperdb/index.js'
import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import {
  cosineSimilarity,
  calculateTextScore,
  heapifyUp,
  heapifyDown,
  reservoirSample,
  createLRUCache
} from '../../utils/helper.js'
import type { LRUCache } from '../../utils/helper.js'
import type {
  EmbeddedDoc,
  HyperDBAdapterConfig,
  ReindexOpts,
  ReindexResult,
  SaveEmbeddingsOpts,
  SaveEmbeddingsResult,
  SearchParams,
  SearchResult
} from '../../types.js'
import qvacCrypto from '#crypto'

interface HyperDBAdapterInput {
  store?: Corestore
  db?: HyperDBInstance
  dbName?: string
  NUM_CENTROIDS?: number
  BUCKET_SIZE?: number
  BATCH_SIZE?: number
  PROGRESS_INTERVAL?: number
  CACHE_SIZE?: number
  documentsTable?: string
  vectorsTable?: string
  centroidsTable?: string
  invertedIndexTable?: string
  configTable?: string
  logger?: LoggerInterface
}

// A centroid match produced while ranking centroids against a query vector.
interface CentroidMatch {
  index: number
  similarity: number
}

// Shapes of the raw records this adapter reads back from the store.
interface CentroidRecord {
  vector: number[]
}

interface VectorRecord {
  docId: string
  vector: number[]
}

interface DocumentRecord {
  id: string
  content: string
}

interface BucketRecord {
  documentIds: string[]
  createdAt: Date
}

// A document prepared for insertion within a batch.
interface PreparedDoc {
  id: string
  index: number
  vector: number[]
  content: string
  contentHash: string
  metadata: Record<string, any>
  embeddingModelId: string
  dimension: number
  centroidId: string | null
}

// A single database operation tracked within a batch transaction.
interface BatchOperation {
  type: 'document' | 'vector'
  index: number
  operation: () => Promise<void>
}

interface OperationResult {
  type: 'document' | 'vector'
  index: number
  status: 'fulfilled' | 'rejected'
  error?: string
}

interface BucketUpdate {
  docIds: Set<string>
  updatedAt: Date
}

interface BatchOpts {
  signal?: AbortSignal
  onPrepareProgress?: (current: number) => void
  progressInterval?: number
}

export class HyperDBAdapter extends BaseDBAdapter {
  store: Corestore | null
  db: HyperDBInstance | null
  dbName: string
  NUM_CENTROIDS: number
  BUCKET_SIZE: number
  BATCH_SIZE: number
  PROGRESS_INTERVAL: number
  CACHE_SIZE: number
  documentsTable: string
  vectorsTable: string
  centroidsTable: string
  invertedIndexTable: string
  configTable: string
  hypercore: Hypercore | null
  documentCache: LRUCache<string, string>
  vectorCache: LRUCache<string, number[]>
  centroids: number[][]
  logger: LoggerInterface

  constructor(config: HyperDBAdapterInput = {}) {
    // BaseDBAdapter ignores the config value; the cast bridges the concrete
    // input interface to its permissive index-signature parameter type.
    super(config as Record<string, unknown>)
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

  // Get the hypercore instance.
  get core(): Hypercore | null {
    return this.hypercore
  }

  // Saves embeddings for a set of documents by processing them in batches.
  // Progress is reported with stages: 'deduplicating', 'preparing', 'writing'.
  override async saveEmbeddings(
    embeddedDocs: EmbeddedDoc[],
    opts: SaveEmbeddingsOpts = {}
  ): Promise<SaveEmbeddingsResult[]> {
    const { onProgress, signal, progressInterval } = opts
    const results: SaveEmbeddingsResult[] = []

    // Validate embeddingModelId is present and consistent across all docs
    if (embeddedDocs.length > 0) {
      const modelIds = new Set(embeddedDocs.map((doc) => doc.embeddingModelId).filter(Boolean))

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

    results.push(
      ...duplicates.map((doc) => ({
        id: doc.id,
        status: 'rejected' as const,
        error: doc.error
      }))
    )

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

  // Delete embeddings for a set of documents inside the vector database.
  override async deleteEmbeddings(ids: string[]): Promise<boolean> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_PARAMS })
    }

    this.logger.debug(`Deleting ${ids.length} document(s) from HyperDB`)

    const ops: Promise<void>[] = []
    const tx = await this.db!.exclusiveTransaction()
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
        const updatedBucket = bucket.filter((docId) => !ids.includes(docId))
        if (updatedBucket.length !== bucket.length) {
          ops.push(
            tx.insert(this.invertedIndexTable, {
              centroidId,
              documentIds: updatedBucket,
              capacity: this.BUCKET_SIZE,
              createdAt: new Date(),
              updatedAt: new Date()
            })
          )
        }
      }
      await Promise.all(ops)
      await tx.flush()

      this.logger.info(`Deleted ${ids.length} document(s) from HyperDB`)

      return true
    } catch (error) {
      this.logger.error('Delete embeddings failed:', error)
      throw new QvacErrorRAG({
        code: ERR_CODES.DB_OPERATION_FAILED,
        adds: error instanceof Error ? error.message : String(error),
        cause: error instanceof Error ? error : undefined
      })
    } finally {
      await tx.close()
    }
  }

  // Search for documents given a text query.
  // Uses IVF buckets and ranking based on cosine similarity and text score.
  override async search(
    query: string,
    queryVector: number[],
    params: SearchParams = {}
  ): Promise<SearchResult[]> {
    const { topK = 5, n = 3, signal } = params
    if (!this.isInitialized) throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.debug(`HyperDB search: topK=${topK}, n=${n}, centroids=${this.centroids.length}`)

    let candidateIds = new Set<string>()
    const topCentroids = this._findTopNCentroids(queryVector, n)
    const dbSnapshot = this.db!.snapshot()

    const bucketPromises = topCentroids.map(({ index }) => {
      const centroidId = `centroid-${index}`
      return this._getBucket(dbSnapshot, centroidId)
    })
    const buckets = await Promise.all(bucketPromises)

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    buckets.forEach((bucket) => {
      bucket.forEach((id) => candidateIds.add(id))
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

    const results: SearchResult[] = []
    for (const id of candidateIdsArray) {
      const vector = vectorMap.get(id)
      const content = contentMap.get(id)
      if (!vector || !content) continue

      const vectorScore = cosineSimilarity(queryVector, vector)
      const textScore = calculateTextScore(query, content)
      const finalScore = vectorScore * 0.7 + textScore * 0.3 // todo: would weight be configurable?

      results.push({ id, content, score: finalScore })
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK)
  }

  // Reindex the database by rebalancing centroids using k-means clustering.
  // Call periodically for large datasets to improve search quality.
  override async reindex(opts: ReindexOpts = {}): Promise<ReindexResult> {
    const { onProgress, signal } = opts

    if (!this.isInitialized) {
      throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })
    }

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.info('Starting reindex...')

    const snapshot = this.db!.snapshot()

    // Stage 1: Collect all vectors
    onProgress?.('collecting', 0, 1)
    const allVectors = await this._getAllEntries<VectorRecord>(snapshot, this.vectorsTable)

    if (allVectors.length < this.NUM_CENTROIDS) {
      this.logger.warn(
        `Insufficient documents for reindex: ${allVectors.length} < ${this.NUM_CENTROIDS}`
      )
      return {
        reindexed: false,
        details: {
          reason: 'insufficient documents',
          documentCount: allVectors.length,
          centroidCount: this.centroids.length
        }
      }
    }

    this.logger.debug(`Collected ${allVectors.length} vectors`)
    onProgress?.('collecting', 1, 1)

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    // Stage 2: Run k-means clustering
    onProgress?.('clustering', 0, 1)
    const vectors = allVectors.map((v) => v.vector)
    const docIds = allVectors.map((v) => v.docId)
    const newCentroids = this._kMeans(vectors, this.NUM_CENTROIDS, 10)
    onProgress?.('clustering', 1, 1)

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    // Stage 3: Reassign documents to new centroids
    onProgress?.('reassigning', 0, vectors.length)
    const newBuckets = new Map<string, string[]>()
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

      newBuckets.get(`centroid-${bestIdx}`)!.push(docId)

      if ((i + 1) % 100 === 0 || i === vectors.length - 1) {
        onProgress?.('reassigning', i + 1, vectors.length)
      }
    }

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    // Stage 4: Update database
    onProgress?.('updating', 0, this.NUM_CENTROIDS * 2)
    const tx = await this.db!.exclusiveTransaction()
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

      this.logger.info(
        `Reindex complete: ${vectors.length} document(s), ${newCentroids.length} centroid(s)`
      )

      return {
        reindexed: true,
        details: { documentCount: vectors.length, centroidCount: newCentroids.length }
      }
    } catch (error) {
      this.logger.error('Reindex failed:', error)
      throw new QvacErrorRAG({
        code: ERR_CODES.DB_OPERATION_FAILED,
        adds: error instanceof Error ? error.message : String(error),
        cause: error instanceof Error ? error : undefined
      })
    } finally {
      await tx.close()
    }
  }

  private _kMeans(vectors: number[][], k: number, maxIterations = 10): number[][] {
    if (vectors.length === 0) return []
    if (vectors.length <= k) return vectors.slice()

    const dim = vectors[0].length

    const centroids: number[][] = []
    const usedIndices = new Set<number>()

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
      const assignments: number[][][] = new Array(k).fill(null).map(() => [])

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

        const newCentroid: number[] = new Array(dim).fill(0)
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

  // Replicate the hypercore with another hypercore.
  // lunte-disable-next-line require-await
  async replicateWith(
    otherHypercore: Hypercore
  ): Promise<{ stream1: ReplicationStream; stream2: ReplicationStream; destroy: () => void }> {
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

  // Initializes the underlying database connection and ensures it is ready for use.
  override async _open(): Promise<void> {
    this.logger.info('Opening HyperDB connection...')

    // If a HyperDB instance was provided in constructor, use it
    if (this.db) {
      await this.db.ready()
      this.hypercore = this.db.core
      await this._checkIsInitialized()
      this.logger.info('HyperDB ready (using provided instance)')
      return
    }

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
    this.db = HyperDB.bee(this.hypercore, dbSpec, { autoUpdate: true })
    await this.db.ready()
    await this._checkIsInitialized()

    this.logger.info('HyperDB ready')
  }

  // Close the adapter and release resources.
  override async _close(): Promise<void> {
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

  // Finds the top N centroids based on cosine similarity.
  private _findTopNCentroids(vector: number[], n = 3): CentroidMatch[] {
    const topCentroids: CentroidMatch[] = []

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

  // Initialize the adapter by setting up centroids, optionally seeding them from
  // an initial set of embedded documents.
  // lunte-disable-next-line no-unused-vars
  private async _initialize(docs: EmbeddedDoc[], opts: SaveEmbeddingsOpts = {}): Promise<void> {
    this.logger.info('Initializing HyperDB...')

    const tx = await this.db!.exclusiveTransaction()
    try {
      if (docs && docs.length) {
        this.logger.debug(`Creating ${this.NUM_CENTROIDS} centroids from initial documents`)
        const shuffled = docs.slice()
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }
        const docsForCreatingCentroids = shuffled.slice(0, this.NUM_CENTROIDS)
        const embeddingsForCentroids = docsForCreatingCentroids
          .filter((doc) => doc.embedding && Array.isArray(doc.embedding))
          .map((doc) => doc.embedding)

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
          const entry = await tx.get<CentroidRecord>(this.centroidsTable, { id: centroidId })
          if (entry && entry.vector) {
            this.centroids[i] = Array.isArray(entry.vector) ? entry.vector : []
          }
        }
      }
      this.centroids = this.centroids.filter((v) => Array.isArray(v) && v.length > 0)
      this.isInitialized = this.centroids.length > 0
      if (!this.isInitialized) {
        throw new QvacErrorRAG({ code: ERR_CODES.CENTROIDS_INITIALIZATION_FAILURE })
      }
      this.logger.info(`HyperDB initialized with ${this.centroids.length} centroid(s)`)
    } catch (error) {
      this.logger.error('HyperDB initialization failed:', error)
      throw new QvacErrorRAG({
        code: ERR_CODES.DB_OPERATION_FAILED,
        adds: error instanceof Error ? error.message : String(error),
        cause: error instanceof Error ? error : undefined
      })
    } finally {
      await tx.close()
    }
  }

  private async _checkIsInitialized(): Promise<void> {
    if (this.isInitialized) return

    this.centroids = [] // reset centroids

    const tx = await this.db!.exclusiveTransaction()
    try {
      for (let i = 0; i < this.NUM_CENTROIDS; i++) {
        const centroidId = `centroid-${i}`
        const entry = await tx.get<CentroidRecord>(this.centroidsTable, { id: centroidId })
        if (entry && entry.vector) {
          this.centroids[i] = Array.isArray(entry.vector) ? entry.vector : []
        }
      }
      this.centroids = this.centroids.filter((v) => Array.isArray(v) && v.length > 0)
      this.isInitialized = this.centroids.length > 0
    } catch (error) {
      throw new QvacErrorRAG({
        code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED,
        adds: error instanceof Error ? error.message : String(error),
        cause: error instanceof Error ? error : undefined
      })
    } finally {
      await tx.close()
    }
  }

  // Ensure config exists with the given embeddingModelId, creating it when
  // absent and validating it against the documents when present.
  private async _ensureConfig(embeddingModelId: string, dimension: number): Promise<void> {
    const storedConfig = await this.getConfig()

    if (!storedConfig) {
      await this._persistConfig(embeddingModelId, dimension)
      this.logger?.info(
        `Initialized config: embeddingModelId=${embeddingModelId}, dimension=${dimension}`
      )
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

  // Persist config to database.
  private async _persistConfig(embeddingModelId: string, dimension: number): Promise<void> {
    const now = new Date()
    const tx = await this.db!.exclusiveTransaction()
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
      const message = error instanceof Error ? error.message : String(error)
      throw new QvacErrorRAG({
        code: ERR_CODES.DB_OPERATION_FAILED,
        adds: `Failed to persist config: ${message}`,
        cause: error instanceof Error ? error : undefined
      })
    } finally {
      await tx.close()
    }
  }

  // Get stored adapter configuration, or null if not configured.
  override async getConfig(): Promise<HyperDBAdapterConfig | null> {
    if (!this.db) {
      throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })
    }
    const snapshot = this.db.snapshot()
    try {
      const result = await snapshot.get<HyperDBAdapterConfig>(this.configTable, { key: 'adapter' })
      return result || null
    } catch {
      // If config table doesn't exist yet or other DB errors, return null
      return null
    }
  }

  // Generates and stores embeddings for a batch of documents.
  private async _processBatch(
    docs: EmbeddedDoc[],
    opts: BatchOpts = {}
  ): Promise<SaveEmbeddingsResult[]> {
    if (!this.isInitialized) throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })

    const { signal, onPrepareProgress, progressInterval = this.PROGRESS_INTERVAL } = opts
    const results: SaveEmbeddingsResult[] = []
    const bucketUpdates = new Map<string, BucketUpdate>()
    const now = new Date()

    // Prepare docs with progress reporting
    const preparedDocs: PreparedDoc[] = []
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]
      const contentHash = qvacCrypto
        .createHash('sha256')
        .update(doc.content)
        .digest('hex') as string
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

      const tx = await this.db!.exclusiveTransaction()
      try {
        const operations: BatchOperation[] = []

        preparedDocs.forEach((doc) => {
          operations.push({
            type: 'document',
            index: doc.index,
            operation: () =>
              tx.insert(this.documentsTable, {
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
            operation: () =>
              tx.insert(this.vectorsTable, {
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
            bucketUpdates.get(doc.centroidId)!.docIds.add(doc.id)
          }
        })

        // Execute all operations within the transaction
        const operationPromises = operations.map((op) => {
          return op
            .operation()
            .then(
              () =>
                ({ type: op.type, index: op.index, status: 'fulfilled' }) satisfies OperationResult
            )
            .catch(
              (error: unknown) =>
                ({
                  type: op.type,
                  index: op.index,
                  status: 'rejected',
                  error:
                    error instanceof Error && error.message
                      ? error.message
                      : 'Database operation failed'
                }) satisfies OperationResult
            )
        })
        const operationResults = await Promise.all(operationPromises)

        // Process results
        const docResults = new Map<number, SaveEmbeddingsResult>()
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
        const message =
          error instanceof Error && error.message ? error.message : 'Batch insertion failed'
        preparedDocs.forEach((doc) => {
          results.push({
            id: doc.id,
            status: 'rejected',
            error: message
          })
        })
      } finally {
        await tx.close()
      }
    }
    return results
  }

  // Updates the caches with the new document and vector.
  private _updateCaches(doc: { id: string; content: string }, vector: number[]): void {
    this.documentCache.set(doc.id, doc.content)
    this.vectorCache.set(doc.id, vector)
  }

  // Updates the inverted index buckets with new document IDs.
  private async _updateBuckets(
    tx: HyperDBTransaction,
    bucketUpdates: Map<string, BucketUpdate>,
    now: Date
  ): Promise<void> {
    const bucketPromises = Array.from(bucketUpdates.entries()).map(([centroidId, update]) => {
      return tx
        .get<BucketRecord>(this.invertedIndexTable, { centroidId })
        .then((existingBucket) => {
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

          newDocIds.forEach((docId) => {
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
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          throw new QvacErrorRAG({
            code: ERR_CODES.DB_OPERATION_FAILED,
            adds: `Failed to update bucket ${centroidId}: ${message}`,
            cause: error instanceof Error ? error : undefined
          })
        })
    })
    await Promise.all(bucketPromises)
  }

  // Retrieves the document IDs in the bucket for the given centroid.
  private async _getBucket(snapshot: HyperDBReader, centroidId: string): Promise<string[]> {
    let bucket: string[] = []
    const bucketEntry = await snapshot.get<BucketRecord>(this.invertedIndexTable, { centroidId })
    if (bucketEntry && Array.isArray(bucketEntry.documentIds)) {
      bucket = bucketEntry.documentIds
    }
    return bucket
  }

  // Retrieves all entries from a table.
  // lunte-disable-next-line require-await
  private async _getAllEntries<T>(snapshot: HyperDBReader, table: string): Promise<T[]> {
    return snapshot.find<T>(table).toArray()
  }

  // Batch retrieve multiple vectors by docIds.
  private async _getVectors(
    snapshot: HyperDBReader,
    docIds: string[]
  ): Promise<Map<string, number[]>> {
    const vectorMap = new Map<string, number[]>()
    const vectorPromises = docIds.map((docId) => {
      let vector = this.vectorCache.get(docId)
      if (vector) {
        return Promise.resolve({ docId, vector })
      }
      return snapshot.get<VectorRecord>(this.vectorsTable, { docId }).then((vectorEntry) => {
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

  // Batch retrieve multiple document contents by IDs.
  private async _getDocumentContents(
    snapshot: HyperDBReader,
    ids: string[]
  ): Promise<Map<string, string>> {
    const contentMap = new Map<string, string>()
    const contentPromises = ids.map((id) => {
      let content = this.documentCache.get(id)
      if (content) {
        return Promise.resolve({ id, content })
      }
      return snapshot.get<DocumentRecord>(this.documentsTable, { id }).then((docEntry) => {
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

  // Progressive centroid expansion for smart fallback when no candidates are found.
  // Gradually expands the search scope by including more centroids until sufficient
  // candidates are found, ultimately sampling documents if the search stays empty.
  private async _progressiveCentroidExpansion(
    snapshot: HyperDBReader,
    queryVector: number[],
    initialN: number,
    minCandidates = 10,
    maxExpansions = 5
  ): Promise<Set<string>> {
    const candidateIds = new Set<string>()
    let centroidCount = initialN
    let expansionStep = 0

    while (
      candidateIds.size < minCandidates &&
      expansionStep < maxExpansions &&
      centroidCount <= this.NUM_CENTROIDS
    ) {
      const topCentroids = this._findTopNCentroids(queryVector, centroidCount)
      const bucketPromises = topCentroids.map(({ index }) => {
        const centroidId = `centroid-${index}`
        return this._getBucket(snapshot, centroidId)
      })
      const buckets = await Promise.all(bucketPromises)
      buckets.forEach((bucket) => {
        bucket.forEach((docId) => {
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
      const allDocs = await this._getAllEntries<DocumentRecord>(snapshot, this.documentsTable)
      const sampleSize = Math.min(50, allDocs.length)
      const sample = reservoirSample(allDocs, sampleSize)
      sample.forEach((doc) => {
        candidateIds.add(doc.id)
      })
    }
    return candidateIds
  }

  // Filter out duplicate documents that already exist in the database.
  // Uses the contentHash field on the documents table for efficient detection.
  private async _filterDuplicates(
    docs: EmbeddedDoc[]
  ): Promise<{ unique: EmbeddedDoc[]; duplicates: Array<{ id: string; error: string }> }> {
    const dbSnapshot = this.db!.snapshot()
    const unique: EmbeddedDoc[] = []
    const duplicates: Array<{ id: string; error: string }> = []
    const seenInBatch = new Map<string, string>()

    const docsWithHashes = docs.map((doc) => ({
      doc,
      hash: qvacCrypto.createHash('sha256').update(doc.content).digest('hex') as string
    }))

    // Check for duplicates within the batch first
    const batchUnique: Array<{ doc: EmbeddedDoc; hash: string }> = []
    for (const { doc, hash } of docsWithHashes) {
      if (seenInBatch.has(hash)) {
        duplicates.push({
          id: seenInBatch.get(hash)!,
          error: 'Duplicate document found in current batch'
        })
      } else {
        batchUnique.push({ doc, hash })
        seenInBatch.set(hash, doc.id)
      }
    }

    const dbLookupPromises = batchUnique.map(({ doc, hash }) =>
      dbSnapshot
        .findOne<DocumentRecord>('@rag/doc-by-content-hash', {
          gte: { contentHash: hash },
          lte: { contentHash: hash }
        })
        .then((existingDoc) => ({ doc, hash, existingDoc }))
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
}
