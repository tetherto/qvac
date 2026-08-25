import type {
  Corestore,
  Hypercore,
  ReplicationStream,
  HyperDBInstance,
  HyperDBReader,
  HyperDBTransaction
} from './db-types.js'
import type { LoggerInterface } from '@qvac/logging'

import { BaseDBAdapter } from './BaseDBAdapter.js'
import {
  HyperDBStorage,
  type DocumentRecord,
  type HyperDBStorageInput,
  type PreparedDocument,
  type VectorRecord
} from './HyperDBStorage.js'
import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import {
  cosineSimilarity,
  heapifyUp,
  heapifyDown,
  reservoirSample,
  scoreDocuments
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

export interface HyperDBAdapterInput extends HyperDBStorageInput {
  NUM_CENTROIDS?: number
  BUCKET_SIZE?: number
  centroidsTable?: string
  invertedIndexTable?: string
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

interface BucketRecord {
  documentIds: string[]
  createdAt: Date
}

// A document prepared for insertion within a batch.
interface PreparedDoc extends PreparedDocument {
  centroidId: string | null
}

export class HyperDBAdapter extends BaseDBAdapter {
  protected readonly storage: HyperDBStorage
  NUM_CENTROIDS: number
  BUCKET_SIZE: number
  centroidsTable: string
  invertedIndexTable: string
  centroids: number[][]

  constructor(config: HyperDBAdapterInput = {}) {
    // BaseDBAdapter ignores the config value; the cast bridges the concrete
    // input interface to its permissive index-signature parameter type.
    super(config as Record<string, unknown>)
    this.storage = new HyperDBStorage(config)
    this.NUM_CENTROIDS = config.NUM_CENTROIDS || 16
    this.BUCKET_SIZE = config.BUCKET_SIZE || 50

    this.centroidsTable = config.centroidsTable || '@rag/centroids'
    this.invertedIndexTable = config.invertedIndexTable || '@rag/ivfBuckets'

    this.centroids = []
  }

  get store(): Corestore | null {
    return this.storage.store
  }

  get db(): HyperDBInstance | null {
    return this.storage.db
  }

  get dbName(): string {
    return this.storage.dbName
  }

  get BATCH_SIZE(): number {
    return this.storage.BATCH_SIZE
  }

  get PROGRESS_INTERVAL(): number {
    return this.storage.PROGRESS_INTERVAL
  }

  get CACHE_SIZE(): number {
    return this.storage.CACHE_SIZE
  }

  get documentsTable(): string {
    return this.storage.documentsTable
  }

  get vectorsTable(): string {
    return this.storage.vectorsTable
  }

  get configTable(): string {
    return this.storage.configTable
  }

  get hypercore(): Hypercore | null {
    return this.storage.hypercore
  }

  get documentCache(): LRUCache<string, string> {
    return this.storage.documentCache
  }

  get vectorCache(): LRUCache<string, number[]> {
    return this.storage.vectorCache
  }

  get logger(): LoggerInterface {
    return this.storage.logger
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
    const batchConfig = this.storage.validateEmbeddingBatch(embeddedDocs)
    if (batchConfig) {
      this.logger.debug(`Saving ${embeddedDocs.length} embedding(s)`)

      if (!this.isInitialized) {
        await this._initialize(embeddedDocs, opts)
      }
      await this.storage.ensureConfig(batchConfig.embeddingModelId, batchConfig.dimension, {
        NUM_CENTROIDS: this.NUM_CENTROIDS,
        BUCKET_SIZE: this.BUCKET_SIZE,
        BATCH_SIZE: this.BATCH_SIZE
      })
    }

    if (opts.signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    const results = await this.storage.saveEmbeddings<PreparedDoc, void>(embeddedDocs, opts, {
      prepare: (doc, contentHash) => ({
        ...this.storage.prepareDocument(doc, contentHash),
        centroidId: this.centroids.length
          ? `centroid-${this._findTopNCentroids(doc.embedding, 1)[0].index}`
          : null
      }),
      write: (tx, docs, now) => this._writeBucketUpdates(tx, docs, now)
    })

    this.logger.info(`Saved ${results.length} embedding(s)`)

    return results
  }

  // Delete embeddings for a set of documents inside the vector database.
  override async deleteEmbeddings(ids: string[]): Promise<boolean> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_PARAMS })
    }

    this.logger.debug(`Deleting ${ids.length} document(s) from HyperDB`)

    await this.storage.deleteEmbeddings(ids, {
      write: (tx, deletedIds, now) => this._pruneBuckets(tx, deletedIds, now)
    })

    this.logger.info(`Deleted ${ids.length} document(s) from HyperDB`)

    return true
  }

  // Search for documents given a text query.
  // Uses IVF buckets and ranking based on cosine similarity and text score.
  override search(
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

    return this.storage.withSnapshot(async (dbSnapshot) => {
      let candidateIds = new Set<string>()
      const topCentroids = this._findTopNCentroids(queryVector, n)

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
        this.storage.getVectors(dbSnapshot, candidateIdsArray),
        this.storage.getDocumentContents(dbSnapshot, candidateIdsArray)
      ])

      if (signal?.aborted) {
        throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
      }

      return scoreDocuments(query, queryVector, candidateIdsArray, vectorMap, contentMap, topK)
    })
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

    // Stage 1: Collect all vectors
    onProgress?.('collecting', 0, 1)
    const allVectors = await this.storage.withSnapshot((snapshot) =>
      this.storage.findEntries<VectorRecord>(snapshot, this.vectorsTable)
    )

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

  // Initializes the underlying database connection and ensures it is ready for use.
  override async _open(): Promise<void> {
    this.logger.info('Opening HyperDB connection...')
    await this.storage.open()
    await this._checkIsInitialized()
    this.logger.info('HyperDB ready')
  }

  // Close the adapter and release resources.
  override async _close(): Promise<void> {
    if (this.db) {
      this.logger.info('Closing HyperDB connection...')
      this.centroids = []
      this.isInitialized = false
      await this.storage.close()
      this.logger.debug('HyperDB closed')
    }
  }

  // Get stored adapter configuration, or null if not configured.
  override getConfig(): Promise<HyperDBAdapterConfig | null> {
    return this.storage.getConfig()
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

  private async _writeBucketUpdates(
    tx: HyperDBTransaction,
    docs: PreparedDoc[],
    now: Date
  ): Promise<void> {
    const bucketUpdates = new Map<string, Set<string>>()
    for (const doc of docs) {
      if (!doc.centroidId) continue
      let docIds = bucketUpdates.get(doc.centroidId)
      if (!docIds) {
        docIds = new Set()
        bucketUpdates.set(doc.centroidId, docIds)
      }
      docIds.add(doc.id)
    }
    if (bucketUpdates.size > 0) {
      await this._updateBuckets(tx, bucketUpdates, now)
    }
  }

  private async _pruneBuckets(tx: HyperDBTransaction, ids: string[], now: Date): Promise<void> {
    const deleted = new Set(ids)
    const ops: Promise<void>[] = []
    for (let i = 0; i < this.NUM_CENTROIDS; i++) {
      const centroidId = `centroid-${i}`
      const bucket = await this._getBucket(tx, centroidId)
      const updatedBucket = bucket.filter((docId) => !deleted.has(docId))
      if (updatedBucket.length !== bucket.length) {
        ops.push(
          tx.insert(this.invertedIndexTable, {
            centroidId,
            documentIds: updatedBucket,
            capacity: this.BUCKET_SIZE,
            createdAt: now,
            updatedAt: now
          })
        )
      }
    }
    await Promise.all(ops)
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

  // Updates the inverted index buckets with new document IDs.
  private async _updateBuckets(
    tx: HyperDBTransaction,
    bucketUpdates: Map<string, Set<string>>,
    now: Date
  ): Promise<void> {
    const bucketPromises = Array.from(bucketUpdates.entries()).map(([centroidId, docIds]) => {
      return tx
        .get<BucketRecord>(this.invertedIndexTable, { centroidId })
        .then((existingBucket) => {
          const newDocIds = Array.from(docIds)

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
      const allDocs = await this.storage.findEntries<DocumentRecord>(snapshot, this.documentsTable)
      const sampleSize = Math.min(50, allDocs.length)
      const sample = reservoirSample(allDocs, sampleSize)
      sample.forEach((doc) => {
        candidateIds.add(doc.id)
      })
    }
    return candidateIds
  }
}
