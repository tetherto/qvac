import HyperDB from 'hyperdb'
import QvacLogger from '@qvac/logging'
import type { LoggerInterface } from '@qvac/logging'

import qvacCrypto from '#crypto'
import dbSpec from './hyperspec/hyperdb/index.js'
import type {
  Corestore,
  Hypercore,
  HyperDBInstance,
  HyperDBReader,
  HyperDBTransaction
} from './db-types.js'
import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import { createLRUCache, type LRUCache } from '../../utils/helper.js'
import type {
  EmbeddedDoc,
  HyperDBAdapterConfig,
  SaveEmbeddingsOpts,
  SaveEmbeddingsResult
} from '../../types.js'

export interface HyperDBStorageInput {
  store?: object
  db?: HyperDBInstance
  dbName?: string
  BATCH_SIZE?: number
  PROGRESS_INTERVAL?: number
  CACHE_SIZE?: number
  documentsTable?: string
  vectorsTable?: string
  configTable?: string
  logger?: LoggerInterface
}

// Adapter settings stored with the embedding model.
export type StoredAdapterConfig = Pick<
  HyperDBAdapterConfig,
  'NUM_CENTROIDS' | 'BUCKET_SIZE' | 'BATCH_SIZE'
>

export interface PreparedDocument {
  id: string
  vector: number[]
  content: string
  contentHash: string
  metadata: Record<string, any>
  embeddingModelId: string
  dimension: number
}

export interface VectorRecord {
  docId: string
  vector: number[]
}

export interface DocumentRecord {
  id: string
  content: string
}

export interface SavePipelineHooks<TDoc extends PreparedDocument, TWrite> {
  prepare?(doc: EmbeddedDoc, contentHash: string): TDoc
  write(tx: HyperDBTransaction, docs: TDoc[], now: Date): Promise<TWrite>
  committed?(docs: TDoc[], writeResult: TWrite): void
}

export interface DeletePipelineHooks<TWrite> {
  write?(tx: HyperDBTransaction, ids: string[], now: Date): Promise<TWrite>
  committed?(ids: string[], writeResult: TWrite): void
}

export class HyperDBStorage {
  store: Corestore | null
  db: HyperDBInstance | null
  readonly dbName: string
  readonly BATCH_SIZE: number
  readonly PROGRESS_INTERVAL: number
  readonly CACHE_SIZE: number
  readonly documentsTable: string
  readonly vectorsTable: string
  readonly configTable: string
  readonly logger: LoggerInterface
  readonly documentCache: LRUCache<string, string>
  readonly vectorCache: LRUCache<string, number[]>
  hypercore: Hypercore | null = null

  constructor(config: HyperDBStorageInput = {}) {
    this.store = (config.store as Corestore | undefined) || null
    this.db = config.db || null
    this.dbName = config.dbName || 'rag-vector-store'
    this.BATCH_SIZE = config.BATCH_SIZE || 100
    this.PROGRESS_INTERVAL = config.PROGRESS_INTERVAL || 10
    this.CACHE_SIZE = config.CACHE_SIZE || 1000
    this.documentsTable = config.documentsTable || '@rag/documents'
    this.vectorsTable = config.vectorsTable || '@rag/vectors'
    this.configTable = config.configTable || '@rag/config'
    this.logger = config.logger || new QvacLogger()
    this.documentCache = createLRUCache(this.CACHE_SIZE)
    this.vectorCache = createLRUCache(this.CACHE_SIZE)
  }

  async open(): Promise<void> {
    if (this.db) {
      await this.db.ready()
      this.hypercore = this.db.core
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
  }

  async close(): Promise<void> {
    this.documentCache.clear()
    this.vectorCache.clear()
    if (this.db) await this.db.close()
  }

  async withSnapshot<T>(operation: (snapshot: HyperDBReader) => Promise<T>): Promise<T> {
    const snapshot = this.db!.snapshot()
    try {
      return await operation(snapshot)
    } finally {
      await snapshot.close()
    }
  }

  async getConfig(): Promise<HyperDBAdapterConfig | null> {
    if (!this.db) {
      throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })
    }
    try {
      return await this.withSnapshot((snapshot) => this.readConfig(snapshot))
    } catch {
      return null
    }
  }

  async readConfig(snapshot: HyperDBReader): Promise<HyperDBAdapterConfig | null> {
    const result = await snapshot.get<HyperDBAdapterConfig>(this.configTable, {
      key: 'adapter'
    })
    return result || null
  }

  async ensureConfig(
    embeddingModelId: string,
    dimension: number,
    adapterConfig: StoredAdapterConfig
  ): Promise<void> {
    const storedConfig = await this.getConfig()
    if (!storedConfig) {
      await this._persistConfig(embeddingModelId, dimension, adapterConfig)
      this.logger.info(
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

  validateEmbeddingBatch(embeddedDocs: EmbeddedDoc[]): {
    embeddingModelId: string
    dimension: number
  } | null {
    if (embeddedDocs.length === 0) return null
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
    const dimension = embeddedDocs[0].embedding.length
    const mismatched = embeddedDocs.find((doc) => doc.embedding.length !== dimension)
    if (mismatched) {
      throw new QvacErrorRAG({
        code: ERR_CODES.EMBEDDING_DIMENSION_MISMATCH,
        adds: `All documents must have the same embedding dimension. Document '${mismatched.id}' has ${mismatched.embedding.length}, expected ${dimension}`
      })
    }
    return {
      embeddingModelId: Array.from(modelIds)[0],
      dimension
    }
  }

  prepareDocument(doc: EmbeddedDoc, contentHash: string): PreparedDocument {
    return {
      id: doc.id,
      vector: doc.embedding,
      content: doc.content,
      contentHash,
      metadata: doc.metadata || {},
      embeddingModelId: doc.embeddingModelId,
      dimension: doc.embedding.length
    }
  }

  // Deduplicate and prepare the documents, then save each batch in its own
  // transaction. Hooks add any adapter-specific work.
  async saveEmbeddings<TDoc extends PreparedDocument, TWrite>(
    embeddedDocs: EmbeddedDoc[],
    opts: SaveEmbeddingsOpts,
    hooks: SavePipelineHooks<TDoc, TWrite>
  ): Promise<SaveEmbeddingsResult[]> {
    const { onProgress, signal, progressInterval = this.PROGRESS_INTERVAL } = opts
    const totalDocs = embeddedDocs.length

    onProgress?.('deduplicating', 0, totalDocs)
    const { unique, duplicates } = await this.filterDuplicates(embeddedDocs)
    onProgress?.('deduplicating', totalDocs, totalDocs)

    if (duplicates.length > 0) {
      this.logger.warn(`${duplicates.length} duplicate(s) found`)
    }

    const results: SaveEmbeddingsResult[] = duplicates.map((doc) => ({
      id: doc.id,
      status: 'rejected' as const,
      error: doc.error
    }))

    let preparedCount = 0
    let writtenCount = 0
    for (let offset = 0; offset < unique.length; offset += this.BATCH_SIZE) {
      if (signal?.aborted) {
        throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
      }

      const batch = unique.slice(offset, offset + this.BATCH_SIZE)
      const preparedDocs: TDoc[] = []
      for (let index = 0; index < batch.length; index++) {
        const { doc, contentHash } = batch[index]
        preparedDocs.push(
          hooks.prepare
            ? hooks.prepare(doc, contentHash)
            : (this.prepareDocument(doc, contentHash) as TDoc)
        )
        if ((index + 1) % progressInterval === 0 || index === batch.length - 1) {
          onProgress?.('preparing', preparedCount + index + 1, unique.length)
        }
      }
      preparedCount += batch.length

      const batchResults: SaveEmbeddingsResult[] = []
      let pendingDocs = preparedDocs
      // A partial attempt is discarded without flushing. Retry only complete
      // documents so durable rows stay intact and hooks share the final commit.
      while (pendingDocs.length > 0) {
        const tx = await this.db!.exclusiveTransaction()
        const now = new Date()
        try {
          const { written, failed } = await this.insertDocumentsAndVectors(tx, pendingDocs, now)
          if (failed.length > 0) {
            batchResults.push(
              ...failed.map((failure) => ({
                id: failure.id,
                status: 'rejected' as const,
                error: failure.error
              }))
            )
            pendingDocs = written
            continue
          }

          const writeResult = await hooks.write(tx, written, now)
          await tx.flush()

          this.cacheDocuments(written)
          hooks.committed?.(written, writeResult)
          batchResults.push(...written.map((doc) => ({ id: doc.id, status: 'fulfilled' as const })))
          pendingDocs = []
        } catch (error) {
          const message =
            error instanceof Error && error.message ? error.message : 'Batch insertion failed'
          batchResults.push(
            ...pendingDocs.map((doc) => ({
              id: doc.id,
              status: 'rejected' as const,
              error: message
            }))
          )
          pendingDocs = []
        } finally {
          await tx.close()
        }
      }
      results.push(...batchResults)

      writtenCount += batch.length
      onProgress?.('writing', writtenCount, unique.length)
    }
    return results
  }

  // Delete documents and vectors in one transaction, run adapter hooks, then
  // clear the caches. Each adapter validates IDs to keep its current error order.
  async deleteEmbeddings<TWrite>(
    ids: string[],
    hooks: DeletePipelineHooks<TWrite> = {}
  ): Promise<void> {
    const tx = await this.db!.exclusiveTransaction()
    try {
      const now = new Date()
      await this.deleteDocumentsAndVectors(tx, ids)
      const writeResult = (await hooks.write?.(tx, ids, now)) as TWrite
      await tx.flush()

      this.evictDocuments(ids)
      hooks.committed?.(ids, writeResult)
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

  async deleteDocumentsAndVectors(tx: HyperDBTransaction, ids: string[]): Promise<void> {
    await Promise.all(
      ids.flatMap((id) => [
        tx.delete(this.documentsTable, { id }),
        tx.delete(this.vectorsTable, { docId: id })
      ])
    )
  }

  evictDocuments(ids: string[]): void {
    for (const id of ids) {
      this.documentCache.delete(id)
      this.vectorCache.delete(id)
    }
  }

  // Scan the whole table or a key range. Range results arrive in key order.
  findEntries<T>(snapshot: HyperDBReader, table: string, query?: object): Promise<T[]> {
    return snapshot.find<T>(table, query).toArray()
  }

  getVectors(snapshot: HyperDBReader, docIds: string[]): Promise<Map<string, number[]>> {
    return this._getCached(
      this.vectorCache,
      snapshot,
      this.vectorsTable,
      'docId',
      docIds,
      (record: VectorRecord) => (Array.isArray(record.vector) ? record.vector : undefined)
    )
  }

  getDocumentContents(snapshot: HyperDBReader, ids: string[]): Promise<Map<string, string>> {
    return this._getCached(
      this.documentCache,
      snapshot,
      this.documentsTable,
      'id',
      ids,
      (record: DocumentRecord) => record.content
    )
  }

  private async insertDocumentsAndVectors<TDoc extends PreparedDocument>(
    tx: HyperDBTransaction,
    docs: TDoc[],
    now: Date
  ): Promise<{ written: TDoc[]; failed: Array<{ id: string; error: string }> }> {
    const outcomes = await Promise.all(
      docs.map(async (doc) => {
        try {
          await tx.insert(this.documentsTable, {
            id: doc.id,
            content: doc.content,
            contentHash: doc.contentHash,
            metadata: doc.metadata,
            createdAt: now,
            updatedAt: now
          })
          await tx.insert(this.vectorsTable, {
            docId: doc.id,
            vector: doc.vector,
            createdAt: now
          })
          return { doc, error: null as string | null }
        } catch (error) {
          return {
            doc,
            error: error instanceof Error && error.message ? error.message : String(error)
          }
        }
      })
    )

    const written: TDoc[] = []
    const failed: Array<{ id: string; error: string }> = []
    for (const outcome of outcomes) {
      if (outcome.error === null) {
        written.push(outcome.doc)
      } else {
        failed.push({ id: outcome.doc.id, error: outcome.error })
      }
    }
    return { written, failed }
  }

  private cacheDocuments(docs: PreparedDocument[]): void {
    for (const doc of docs) {
      this.documentCache.set(doc.id, doc.content)
      this.vectorCache.set(doc.id, doc.vector)
    }
  }

  private async _getCached<T, V>(
    cache: LRUCache<string, V>,
    snapshot: HyperDBReader,
    table: string,
    keyField: string,
    ids: string[],
    // lunte-disable-next-line no-unused-vars
    pick: (record: T) => V | undefined
  ): Promise<Map<string, V>> {
    const values = new Map<string, V>()
    const results = await Promise.all(
      ids.map(async (id) => {
        let value = cache.get(id)
        if (value === undefined) {
          const entry = await snapshot.get<T>(table, { [keyField]: id })
          if (entry) {
            value = pick(entry)
            if (value !== undefined) cache.set(id, value)
          }
        }
        return { id, value }
      })
    )
    for (const { id, value } of results) {
      if (value !== undefined) values.set(id, value)
    }
    return values
  }

  private filterDuplicates(docs: EmbeddedDoc[]): Promise<{
    unique: Array<{ doc: EmbeddedDoc; contentHash: string }>
    duplicates: Array<{ id: string; error: string }>
  }> {
    return this.withSnapshot((snapshot) => this._filterDuplicatesFromSnapshot(snapshot, docs))
  }

  private async _persistConfig(
    embeddingModelId: string,
    dimension: number,
    adapterConfig: StoredAdapterConfig
  ): Promise<void> {
    const tx = await this.db!.exclusiveTransaction()
    try {
      await tx.insert(this.configTable, {
        key: 'adapter',
        embeddingModelId,
        dimension,
        ...adapterConfig,
        createdAt: new Date()
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

  private async _filterDuplicatesFromSnapshot(
    snapshot: HyperDBReader,
    docs: EmbeddedDoc[]
  ): Promise<{
    unique: Array<{ doc: EmbeddedDoc; contentHash: string }>
    duplicates: Array<{ id: string; error: string }>
  }> {
    const unique: Array<{ doc: EmbeddedDoc; contentHash: string }> = []
    const duplicates: Array<{ id: string; error: string }> = []
    const seenInBatch = new Map<string, string>()
    const batchUnique: Array<{ doc: EmbeddedDoc; contentHash: string }> = []

    for (const doc of docs) {
      const contentHash = qvacCrypto
        .createHash('sha256')
        .update(doc.content)
        .digest('hex') as string
      const seenId = seenInBatch.get(contentHash)
      if (seenId) {
        duplicates.push({
          id: seenId,
          error: 'Duplicate document found in current batch'
        })
      } else {
        batchUnique.push({ doc, contentHash })
        seenInBatch.set(contentHash, doc.id)
      }
    }

    const results = await Promise.all(
      batchUnique.map(async (entry) => ({
        entry,
        existingDoc: await snapshot.findOne<DocumentRecord>('@rag/doc-by-content-hash', {
          gte: { contentHash: entry.contentHash },
          lte: { contentHash: entry.contentHash }
        })
      }))
    )
    for (const { entry, existingDoc } of results) {
      if (existingDoc) {
        duplicates.push({
          id: existingDoc.id,
          error: 'Document already exists in database'
        })
      } else {
        unique.push(entry)
      }
    }
    return { unique, duplicates }
  }
}
