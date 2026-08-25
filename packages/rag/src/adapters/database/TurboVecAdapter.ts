import type { LoggerInterface } from '@qvac/logging'

import fs from '#fs'
import path from '#path'
import qvacCrypto from '#crypto'
import { BaseDBAdapter } from './BaseDBAdapter.js'
import {
  HyperDBStorage,
  type DocumentRecord,
  type HyperDBStorageInput,
  type PreparedDocument,
  type VectorRecord
} from './HyperDBStorage.js'
import type { HyperDBReader, HyperDBTransaction } from './db-types.js'
import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import { scoreDocuments } from '../../utils/helper.js'
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

const UINT64_MAX = 0xffffffffffffffffn
const UINT32_MAX = 0xffffffff
const ID_MAPPING_VERSION = 1
const MANIFEST_VERSION = 1
const WORKSPACE_STATE_KEY = 'workspace'
const UPSERT_OPERATION = 'upsert'
const DELETE_OPERATION = 'delete'
const DEFAULT_LOCK_STALE_MS = 30_000
const DEFAULT_LOCK_HEARTBEAT_MS = 10_000

export type TurboVecIndexStorage = 'f32' | 'q8' | 'q4' | 'turbovec-q4' | 'turbovec-q2'

export interface TurboVecIndexSearchResult {
  scores: Float32Array
  ids: BigUint64Array
  m: number
  k: number
}

export interface TurboVecIndex {
  readonly length: number
  readonly dim: number
  addWithIds(vectors: Float32Array, ids: BigUint64Array): void
  search(queries: Float32Array, k: number): TurboVecIndexSearchResult
  contains(id: bigint): boolean
  remove(id: bigint): boolean
  prepare(): void
  write(path: string): void
  dispose(): void
}

export interface TurboVecIndexProvider {
  create(options: { dim: number; storage: TurboVecIndexStorage }): TurboVecIndex
  load(path: string): TurboVecIndex
}

interface WorkspaceStateRecord {
  key: string
  revision: number
  updatedAt: Date
}

interface MutationRecord {
  revision: number
  operation: string
  documentIds: string[]
  createdAt: Date
}

interface NativeIdRecord {
  nativeId: string
  documentId: string
  mappingVersion: number
  createdAt: Date
}

interface CheckpointManifest {
  version: number
  revision: number
  dimension: number
  storage: TurboVecIndexStorage
  mappingVersion: number
  snapshot: string
}

interface NativeId {
  value: bigint
  hex: string
}

interface SavedBatch {
  nativeIds: NativeId[]
  revision: number
}

interface LockRecord {
  owner: string
  updatedAt: number
}

interface TimerHandle {
  unref?(): void
}

interface TimerRuntime {
  setInterval(callback: () => void, delay: number): TimerHandle
  clearInterval(timer: TimerHandle): void
}

const timerRuntime = globalThis as unknown as TimerRuntime

export interface TurboVecAdapterInput extends HyperDBStorageInput {
  indexProvider: TurboVecIndexProvider
  checkpointDir?: string
  storage?: 'turbovec-q4' | 'turbovec-q2'
  fallbackStorage?: 'f32' | 'q8' | 'q4'
  candidateMultiplier?: number
  checkpointEveryMutations?: number
  lockStaleMs?: number
  lockHeartbeatMs?: number
  workspaceStateTable?: string
  mutationsTable?: string
  nativeIdsTable?: string
  logger?: LoggerInterface
}

export class TurboVecAdapter extends BaseDBAdapter {
  readonly checkpointDir: string | undefined
  readonly preferredStorage: 'turbovec-q4' | 'turbovec-q2'
  readonly fallbackStorage: 'f32' | 'q8' | 'q4'
  readonly candidateMultiplier: number
  readonly checkpointEveryMutations: number
  readonly lockStaleMs: number
  readonly lockHeartbeatMs: number
  readonly workspaceStateTable: string
  readonly mutationsTable: string
  readonly nativeIdsTable: string

  private index: TurboVecIndex | null = null
  private indexUnavailable = false
  private indexRevision = 0
  private activeStorage: TurboVecIndexStorage | null = null
  private idToDocument = new Map<bigint, string>()
  private operationTail: Promise<void> = Promise.resolve()
  private activeSearches = new Set<Promise<SearchResult[]>>()
  private checkpointScheduled = false
  private refreshPromise: Promise<void> | null = null
  private dirty = false
  private needsRecovery = false
  private mutationsSinceCheckpoint = 0
  private lockHeartbeat: TimerHandle | null = null
  private ownsLock = false
  private writerFenced = false
  private readonly lockOwner: string
  private readonly indexProvider: TurboVecIndexProvider
  private readonly storage: HyperDBStorage
  private isClosingIndex = false

  constructor(config: TurboVecAdapterInput) {
    super(config as unknown as Record<string, unknown>)
    if (!config.indexProvider) {
      throw new QvacErrorRAG({
        code: ERR_CODES.DEPENDENCY_REQUIRED,
        adds: 'TurboVecAdapter requires a vector index provider'
      })
    }
    this.storage = new HyperDBStorage(config)
    this.indexProvider = config.indexProvider
    this.checkpointDir = config.checkpointDir
    this.preferredStorage = config.storage || 'turbovec-q4'
    this.fallbackStorage = config.fallbackStorage || 'q8'
    this.candidateMultiplier = config.candidateMultiplier || 10
    this.checkpointEveryMutations = config.checkpointEveryMutations || 1000
    this.lockStaleMs = config.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.lockHeartbeatMs = config.lockHeartbeatMs ?? DEFAULT_LOCK_HEARTBEAT_MS
    this.workspaceStateTable = config.workspaceStateTable || '@rag/workspaceState'
    this.mutationsTable = config.mutationsTable || '@rag/mutations'
    this.nativeIdsTable = config.nativeIdsTable || '@rag/nativeIds'
    this.lockOwner = qvacCrypto
      .createHash('sha256')
      .update(`${Date.now()}:${Math.random()}:${this.dbName}`)
      .digest('hex') as string
  }

  get dbName(): string {
    return this.storage.dbName
  }

  get BATCH_SIZE(): number {
    return this.storage.BATCH_SIZE
  }

  get logger(): LoggerInterface {
    return this.storage.logger
  }

  get vectorStorage(): TurboVecIndexStorage | null {
    return this.activeStorage
  }

  get revision(): number {
    return this.indexRevision
  }

  override saveEmbeddings(
    embeddedDocs: EmbeddedDoc[],
    opts: SaveEmbeddingsOpts = {}
  ): Promise<SaveEmbeddingsResult[]> {
    return this._enqueue(() => this._saveEmbeddings(embeddedDocs, opts))
  }

  override deleteEmbeddings(ids: string[]): Promise<boolean> {
    return this._enqueue(() => this._deleteEmbeddings(ids))
  }

  override search(
    query: string,
    queryVector: number[],
    params: SearchParams = {}
  ): Promise<SearchResult[]> {
    if (this.isClosingIndex) {
      return Promise.reject(this._closingError())
    }
    const operation = this._search(query, queryVector, params)
    this.activeSearches.add(operation)
    const done = () => this.activeSearches.delete(operation)
    void operation.then(done, done)
    return operation
  }

  private async _search(
    query: string,
    queryVector: number[],
    params: SearchParams
  ): Promise<SearchResult[]> {
    const { topK = 5, signal } = params
    if (!this.isInitialized) {
      throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })
    }
    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    const visibleRevision = await this.storage.withSnapshot((snapshot) =>
      this._readCurrentRevision(snapshot)
    )
    if (
      visibleRevision !== this.indexRevision &&
      this.index &&
      !this.needsRecovery &&
      !this.writerFenced
    ) {
      try {
        await this._scheduleRefresh()
      } catch (error) {
        this.needsRecovery = true
        this.logger.warn('TurboVec search refresh failed; scanning HyperDB directly:', error)
      }
    }
    if (
      !this.index ||
      this.index.length === 0 ||
      this.needsRecovery ||
      visibleRevision !== this.indexRevision
    ) {
      return this._searchAllDocuments(query, queryVector, topK, signal)
    }

    const candidateCount = Math.min(
      this.index.length,
      Math.max(topK, topK * this.candidateMultiplier)
    )
    const nativeResults = this.index.search(
      new Float32Array(this._normalizeVector(queryVector)),
      candidateCount
    )
    const candidateIds = this._resolveCandidateIds(nativeResults)
    const [vectorMap, contentMap] = await this.storage.withSnapshot((snapshot) =>
      Promise.all([
        this.storage.getVectors(snapshot, candidateIds),
        this.storage.getDocumentContents(snapshot, candidateIds)
      ])
    )

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    return scoreDocuments(query, queryVector, candidateIds, vectorMap, contentMap, topK)
  }

  private async _saveEmbeddings(
    embeddedDocs: EmbeddedDoc[],
    opts: SaveEmbeddingsOpts
  ): Promise<SaveEmbeddingsResult[]> {
    const batchConfig = this.storage.validateEmbeddingBatch(embeddedDocs)
    if (batchConfig) {
      await this.storage.ensureConfig(batchConfig.embeddingModelId, batchConfig.dimension, {
        NUM_CENTROIDS: 0,
        BUCKET_SIZE: 0,
        BATCH_SIZE: this.BATCH_SIZE
      })
      this.isInitialized = true
    }
    if (opts.signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    return this.storage.saveEmbeddings<PreparedDocument, SavedBatch>(embeddedDocs, opts, {
      write: async (tx, docs, now) => {
        const nativeIds = docs.map((doc) => this._nativeIdForDocument(doc.id))
        await Promise.all(
          docs.map((doc, index) => this._ensureNativeIdRecord(tx, doc.id, nativeIds[index], now))
        )
        const revision = await this._appendMutation(
          tx,
          UPSERT_OPERATION,
          docs.map((doc) => doc.id),
          now
        )
        return { nativeIds, revision }
      },
      committed: (docs, { nativeIds, revision }) =>
        this._applySavedDocuments(docs, nativeIds, revision)
    })
  }

  private async _deleteEmbeddings(ids: string[]): Promise<boolean> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_PARAMS })
    }
    if (!this.isInitialized) {
      throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })
    }

    await this.storage.deleteEmbeddings<number>(ids, {
      write: (tx, deletedIds, now) => this._appendMutation(tx, DELETE_OPERATION, deletedIds, now),
      committed: (deletedIds, revision) => this._applyDeletedDocuments(deletedIds, revision)
    })
    return true
  }

  private _applySavedDocuments(
    docs: PreparedDocument[],
    nativeIds: NativeId[],
    revision: number
  ): void {
    if (this.needsRecovery) return
    try {
      this._assertWriterOwnership()
      this._ensureIndex(docs[0].dimension)
      if (!this.index) {
        for (let index = 0; index < docs.length; index++) {
          this._assertRuntimeMapping(nativeIds[index].value, docs[index].id)
        }
        this.indexRevision = revision
        return
      }
      const ids = new BigUint64Array(docs.length)
      const vectors = new Float32Array(docs.length * docs[0].dimension)
      for (let index = 0; index < docs.length; index++) {
        const doc = docs[index]
        const nativeId = nativeIds[index]
        this._assertRuntimeMapping(nativeId.value, doc.id)
        if (this.index.contains(nativeId.value)) this.index.remove(nativeId.value)
        ids[index] = nativeId.value
        vectors.set(this._normalizeVector(doc.vector), index * doc.dimension)
      }
      this.index.addWithIds(vectors, ids)
      this.indexRevision = revision
      this._markDirty()
    } catch (error) {
      this.needsRecovery = true
      this.logger.error('TurboVec update failed after HyperDB commit; rebuild required:', error)
    }
  }

  private _applyDeletedDocuments(ids: string[], revision: number): void {
    if (this.needsRecovery) return
    try {
      this._assertWriterOwnership()
      if (!this.index) {
        this.indexRevision = revision
        return
      }
      for (const id of ids) this.index.remove(this._nativeIdForDocument(id).value)
      this.indexRevision = revision
      this._markDirty()
    } catch (error) {
      this.needsRecovery = true
      this.logger.error('TurboVec delete failed after HyperDB commit; rebuild required:', error)
    }
  }

  override reindex(opts: ReindexOpts = {}): Promise<ReindexResult> {
    return this._enqueue(async () => {
      const { signal, onProgress } = opts
      if (signal?.aborted) {
        throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
      }
      onProgress?.('collecting', 0, 1)
      const count = await this._fullRebuild()
      onProgress?.('collecting', 1, 1)
      onProgress?.('updating', 1, 1)
      return {
        reindexed: true,
        details: {
          documentCount: count,
          revision: this.indexRevision,
          storage: this.activeStorage
        }
      }
    })
  }

  checkpoint(): Promise<boolean> {
    return this._enqueue(() => this._checkpoint())
  }

  override getConfig(): Promise<HyperDBAdapterConfig | null> {
    return this.storage.getConfig()
  }

  override async _open(): Promise<void> {
    await this.storage.open()
    try {
      this._acquireLock()
      const config = await this.getConfig()
      if (config) {
        await this._recoverIndex(config.dimension)
        this.isInitialized = true
      }
    } catch (error) {
      try {
        this.index?.dispose()
      } catch (disposeError) {
        this.logger.warn('TurboVec index cleanup after open failure failed:', disposeError)
      }
      this.index = null
      this.idToDocument.clear()
      try {
        this._releaseLock()
      } catch (lockError) {
        this.logger.warn('TurboVec writer lock cleanup after open failure failed:', lockError)
      }
      try {
        await this.storage.close()
      } catch (closeError) {
        this.logger.warn('HyperDB cleanup after TurboVec open failure failed:', closeError)
      }
      throw error
    }
  }

  override async _close(): Promise<void> {
    this.isClosingIndex = true
    await this.operationTail
    await Promise.allSettled(this.activeSearches)
    try {
      if (this.dirty) {
        await this._checkpoint()
      }
    } catch (error) {
      this.logger.warn('TurboVec checkpoint during close failed:', error)
    } finally {
      try {
        this.index?.dispose()
      } catch (error) {
        this.logger.warn('TurboVec index disposal failed:', error)
      }
      this.index = null
      this.idToDocument.clear()
      try {
        this._releaseLock()
      } catch (error) {
        this.logger.warn('TurboVec writer lock release failed:', error)
      }
      this.isInitialized = false
      await this.storage.close()
    }
  }

  private _closingError(): QvacErrorRAG {
    return new QvacErrorRAG({
      code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED,
      adds: 'TurboVec adapter is closing'
    })
  }

  private _enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isClosingIndex) {
      return Promise.reject(this._closingError())
    }
    if (this.writerFenced) {
      return Promise.reject(this._lockLostError())
    }
    const guardedOperation = () => {
      this._assertWriterOwnership()
      return operation()
    }
    const result = this.operationTail.then(guardedOperation, guardedOperation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private _scheduleRefresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    if (this.isClosingIndex) return Promise.reject(this._closingError())
    if (this.writerFenced) return Promise.reject(this._lockLostError())

    const refresh = this._enqueue(() => this._refreshIndex())
    this.refreshPromise = refresh
    const clearRefresh = () => {
      if (this.refreshPromise === refresh) this.refreshPromise = null
    }
    void refresh.then(clearRefresh, clearRefresh)
    return refresh
  }

  private _searchAllDocuments(
    query: string,
    queryVector: number[],
    topK: number,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    return this.storage.withSnapshot(async (snapshot) => {
      // Scan both full tables once and in parallel. Looking up each document
      // separately would add one read per document and churn the cache.
      const [vectors, documents] = await Promise.all([
        this.storage.findEntries<VectorRecord>(snapshot, this.storage.vectorsTable),
        this.storage.findEntries<DocumentRecord>(snapshot, this.storage.documentsTable)
      ])
      if (signal?.aborted) {
        throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
      }
      const ids = vectors.map((entry) => entry.docId)
      const vectorMap = new Map(vectors.map((entry) => [entry.docId, entry.vector]))
      const contentMap = new Map(documents.map((entry) => [entry.id, entry.content]))
      return scoreDocuments(query, queryVector, ids, vectorMap, contentMap, topK)
    })
  }

  private async _appendMutation(
    tx: HyperDBTransaction,
    operation: string,
    documentIds: string[],
    now: Date
  ): Promise<number> {
    const state = await tx.get<WorkspaceStateRecord>(this.workspaceStateTable, {
      key: WORKSPACE_STATE_KEY
    })
    const revision = (state?.revision || 0) + 1
    if (revision > UINT32_MAX) {
      throw new QvacErrorRAG({
        code: ERR_CODES.DB_OPERATION_FAILED,
        adds: 'RAG workspace revision exhausted uint32 range'
      })
    }
    await tx.insert(this.mutationsTable, {
      revision,
      operation,
      documentIds,
      createdAt: now
    })
    await tx.insert(this.workspaceStateTable, {
      key: WORKSPACE_STATE_KEY,
      revision,
      updatedAt: now
    })
    return revision
  }

  private async _ensureNativeIdRecord(
    tx: HyperDBTransaction,
    documentId: string,
    nativeId: NativeId,
    now: Date,
    runtimeMappings = this.idToDocument
  ): Promise<void> {
    this._assertMapping(runtimeMappings, nativeId.value, documentId)
    const existing = await tx.get<NativeIdRecord>(this.nativeIdsTable, {
      nativeId: nativeId.hex
    })
    if (existing && existing.documentId !== documentId) {
      throw this._nativeIdCollision(nativeId.hex, existing.documentId, documentId)
    }
    if (!existing) {
      await tx.insert(this.nativeIdsTable, {
        nativeId: nativeId.hex,
        documentId,
        mappingVersion: ID_MAPPING_VERSION,
        createdAt: now
      })
    }
  }

  private async _refreshIndex(): Promise<void> {
    if (this.indexUnavailable) return

    const [config, currentRevision] = await this.storage.withSnapshot((snapshot) =>
      Promise.all([this.storage.readConfig(snapshot), this._readCurrentRevision(snapshot)])
    )
    if (!config) return

    if (!this.index || this.needsRecovery) {
      await this._recoverIndex(config.dimension)
      return
    }
    if (currentRevision === this.indexRevision) return
    if (currentRevision < this.indexRevision) {
      await this._fullRebuild()
      return
    }
    const replayed = await this._replayMutations(this.indexRevision, currentRevision)
    if (!replayed) {
      await this._fullRebuild()
    }
  }

  private async _recoverIndex(dimension: number): Promise<void> {
    if (this.indexUnavailable) return

    const currentRevision = await this.storage.withSnapshot((snapshot) =>
      this._readCurrentRevision(snapshot)
    )
    if (this.checkpointDir) {
      try {
        const manifest = this._readManifest()
        if (
          manifest &&
          manifest.dimension === dimension &&
          manifest.mappingVersion === ID_MAPPING_VERSION &&
          manifest.revision <= currentRevision &&
          (manifest.storage === this.preferredStorage || manifest.storage === this.fallbackStorage)
        ) {
          const loaded = this.indexProvider.load(path.join(this.checkpointDir, manifest.snapshot))
          if (loaded.dim !== dimension) {
            loaded.dispose()
            throw new QvacErrorRAG({
              code: ERR_CODES.DB_OPERATION_FAILED,
              adds: 'TurboVec checkpoint dimension does not match its manifest'
            })
          }
          this.index?.dispose()
          this.index = loaded
          this.activeStorage = manifest.storage
          this.indexRevision = manifest.revision
          await this._loadRuntimeMappings()
          if (
            currentRevision === manifest.revision ||
            (await this._replayMutations(manifest.revision, currentRevision))
          ) {
            this.needsRecovery = false
            return
          }
        }
      } catch (error) {
        this.logger.warn('TurboVec checkpoint is invalid; rebuilding from HyperDB:', error)
      }
    }
    await this._fullRebuild()
  }

  private async _fullRebuild(): Promise<number> {
    const config = await this.getConfig()
    if (!config) return 0

    const nextIndex = this._createIndex(config.dimension)
    if (!nextIndex) {
      this.index?.dispose()
      this.index = null
      this.idToDocument.clear()
      this.indexRevision = await this.storage.withSnapshot((snapshot) =>
        this._readCurrentRevision(snapshot)
      )
      this.needsRecovery = false
      return 0
    }
    const [vectors, currentRevision] = await this.storage.withSnapshot((snapshot) =>
      Promise.all([
        this.storage.findEntries<VectorRecord>(snapshot, this.storage.vectorsTable),
        this._readCurrentRevision(snapshot)
      ])
    )
    const nextMappings = new Map<bigint, string>()
    const nativeIdsByDocument = new Map<string, NativeId>()
    const batchSize = Math.max(1, this.BATCH_SIZE)

    try {
      for (let offset = 0; offset < vectors.length; offset += batchSize) {
        const batch = vectors.slice(offset, offset + batchSize)
        const ids = new BigUint64Array(batch.length)
        const values = new Float32Array(batch.length * config.dimension)
        for (let index = 0; index < batch.length; index++) {
          const row = batch[index]
          const nativeId = this._nativeIdForDocument(row.docId)
          const collision = nextMappings.get(nativeId.value)
          if (collision && collision !== row.docId) {
            throw this._nativeIdCollision(nativeId.hex, collision, row.docId)
          }
          nextMappings.set(nativeId.value, row.docId)
          nativeIdsByDocument.set(row.docId, nativeId)
          ids[index] = nativeId.value
          values.set(this._normalizeVector(row.vector), index * config.dimension)
        }
        if (batch.length > 0) {
          nextIndex.addWithIds(values, ids)
        }
      }
      nextIndex.prepare()
    } catch (error) {
      nextIndex.dispose()
      throw error
    }

    try {
      await this._persistMissingMappings(nativeIdsByDocument, nextMappings)
      this._assertWriterOwnership()
    } catch (error) {
      nextIndex.dispose()
      this.needsRecovery = true
      throw error
    }

    this.index?.dispose()
    this.index = nextIndex
    this.idToDocument = nextMappings
    this.indexRevision = currentRevision
    this.needsRecovery = false
    this.dirty = true
    return vectors.length
  }

  private _replayMutations(fromRevision: number, toRevision: number): Promise<boolean> {
    if (!this.index || fromRevision === toRevision) {
      return Promise.resolve(fromRevision === toRevision)
    }
    return this.storage.withSnapshot(async (snapshot) => {
      const mutations = await this.storage.findEntries<MutationRecord>(
        snapshot,
        this.mutationsTable,
        { gt: { revision: fromRevision }, lte: { revision: toRevision } }
      )

      if (
        mutations.length === 0 ||
        mutations[0].revision !== fromRevision + 1 ||
        mutations[mutations.length - 1].revision !== toRevision
      ) {
        return false
      }

      try {
        let expectedRevision = fromRevision + 1
        const documentIds = new Set<string>()
        for (const mutation of mutations) {
          if (mutation.revision !== expectedRevision) return false
          if (mutation.operation !== DELETE_OPERATION && mutation.operation !== UPSERT_OPERATION) {
            return false
          }
          for (const documentId of mutation.documentIds) documentIds.add(documentId)
          expectedRevision++
        }

        const replayDocuments = await Promise.all(
          Array.from(documentIds, async (documentId) => {
            const nativeId = this._nativeIdForDocument(documentId)
            const vector = await snapshot.get<VectorRecord>(this.storage.vectorsTable, {
              docId: documentId
            })
            return { documentId, nativeId, vector }
          })
        )
        const nextMappings = new Map(this.idToDocument)
        for (const replay of replayDocuments) {
          if (replay.vector) {
            this._assertMapping(nextMappings, replay.nativeId.value, replay.documentId)
          }
        }

        // All HyperDB reads complete before the live index is touched. The
        // synchronous section below cannot be observed halfway through by a search.
        this._assertWriterOwnership()
        for (const replay of replayDocuments) {
          if (this.index!.contains(replay.nativeId.value)) {
            this.index!.remove(replay.nativeId.value)
          }
          if (replay.vector) {
            this.index!.addWithIds(
              new Float32Array(this._normalizeVector(replay.vector.vector)),
              new BigUint64Array([replay.nativeId.value])
            )
          }
        }
        this.idToDocument = nextMappings
        this.indexRevision = toRevision
        this.dirty = toRevision > fromRevision
        this.needsRecovery = false
        return true
      } catch (error) {
        this.needsRecovery = true
        this.logger.warn('TurboVec mutation replay failed:', error)
        return false
      }
    })
  }

  private _ensureIndex(dimension: number): void {
    if (this.index && this.index.dim === dimension) return
    if (this.indexUnavailable) return
    this.index?.dispose()
    this.index = this._createIndex(dimension)
    this.indexRevision = 0
    this.idToDocument.clear()
  }

  private _createIndex(dimension: number): TurboVecIndex | null {
    if (dimension <= 1024 && dimension % 8 === 0) {
      try {
        const index = this.indexProvider.create({
          dim: dimension,
          storage: this.preferredStorage
        })
        this.activeStorage = this.preferredStorage
        this.indexUnavailable = false
        return index
      } catch (error) {
        this.logger.warn(
          `TurboVec ${this.preferredStorage} is unavailable; using ${this.fallbackStorage}:`,
          error
        )
      }
    }
    try {
      const fallback = this.indexProvider.create({
        dim: dimension,
        storage: this.fallbackStorage
      })
      this.activeStorage = this.fallbackStorage
      this.indexUnavailable = false
      return fallback
    } catch (error) {
      this.indexUnavailable = true
      this.activeStorage = null
      this.logger.warn(
        'No TurboVec index storage is available; searches will scan HyperDB directly:',
        error
      )
      return null
    }
  }

  private _normalizeVector(vector: number[]): number[] {
    let normSquared = 0
    for (const value of vector) normSquared += value * value
    const norm = Math.sqrt(normSquared)
    if (norm === 0) return vector.slice()
    return vector.map((value) => value / norm)
  }

  private _nativeIdForDocument(documentId: string): NativeId {
    const digest = qvacCrypto
      .createHash('sha256')
      .update(`qvac-rag-native-id:v${ID_MAPPING_VERSION}:${documentId}`)
      .digest('hex')
    if (typeof digest !== 'string') {
      throw new QvacErrorRAG({
        code: ERR_CODES.DB_OPERATION_FAILED,
        adds: 'SHA-256 implementation did not return a hexadecimal digest'
      })
    }
    const hex = digest.slice(0, 16).padStart(16, '0')
    const value = BigInt(`0x${hex}`)
    if (value === 0n || value === UINT64_MAX) {
      throw new QvacErrorRAG({
        code: ERR_CODES.DB_OPERATION_FAILED,
        adds: `Document '${documentId}' maps to reserved native id ${hex}`
      })
    }
    return { value, hex }
  }

  private _assertRuntimeMapping(nativeId: bigint, documentId: string): void {
    this._assertMapping(this.idToDocument, nativeId, documentId)
  }

  private _assertMapping(
    mappings: Map<bigint, string>,
    nativeId: bigint,
    documentId: string
  ): void {
    const existing = mappings.get(nativeId)
    if (existing && existing !== documentId) {
      throw this._nativeIdCollision(nativeId.toString(16).padStart(16, '0'), existing, documentId)
    }
    mappings.set(nativeId, documentId)
  }

  private _nativeIdCollision(nativeId: string, existing: string, incoming: string): QvacErrorRAG {
    return new QvacErrorRAG({
      code: ERR_CODES.DB_OPERATION_FAILED,
      adds: `Native id collision ${nativeId} between '${existing}' and '${incoming}'`
    })
  }

  private _resolveCandidateIds(results: TurboVecIndexSearchResult): string[] {
    const ids: string[] = []
    for (const nativeId of results.ids) {
      if (nativeId === UINT64_MAX) continue
      const documentId = this.idToDocument.get(nativeId)
      if (documentId) ids.push(documentId)
    }
    return ids
  }

  private async _loadRuntimeMappings(): Promise<void> {
    const records = await this.storage.withSnapshot((snapshot) =>
      this.storage.findEntries<NativeIdRecord>(snapshot, this.nativeIdsTable)
    )
    const mappings = new Map<bigint, string>()
    for (const record of records) {
      if (record.mappingVersion !== ID_MAPPING_VERSION) {
        throw new QvacErrorRAG({
          code: ERR_CODES.DB_OPERATION_FAILED,
          adds: `Unsupported native id mapping version ${record.mappingVersion}`
        })
      }
      const nativeId = BigInt(`0x${record.nativeId}`)
      const existing = mappings.get(nativeId)
      if (existing && existing !== record.documentId) {
        throw this._nativeIdCollision(record.nativeId, existing, record.documentId)
      }
      mappings.set(nativeId, record.documentId)
    }
    this.idToDocument = mappings
  }

  private async _persistMissingMappings(
    nativeIds: Map<string, NativeId>,
    runtimeMappings: Map<bigint, string>
  ): Promise<void> {
    if (nativeIds.size === 0) return
    const tx = await this.storage.db!.exclusiveTransaction()
    const now = new Date()
    try {
      // These writes share a transaction and do not depend on each other.
      await Promise.all(
        Array.from(nativeIds, ([documentId, nativeId]) =>
          this._ensureNativeIdRecord(tx, documentId, nativeId, now, runtimeMappings)
        )
      )
      await tx.flush()
    } finally {
      await tx.close()
    }
  }

  private async _readCurrentRevision(reader: HyperDBReader): Promise<number> {
    const state = await reader.get<WorkspaceStateRecord>(this.workspaceStateTable, {
      key: WORKSPACE_STATE_KEY
    })
    return state?.revision || 0
  }

  private _markDirty(): void {
    this.dirty = true
    this.mutationsSinceCheckpoint++
    if (
      this.checkpointDir &&
      this.mutationsSinceCheckpoint >= this.checkpointEveryMutations &&
      !this.checkpointScheduled
    ) {
      this.checkpointScheduled = true
      void Promise.resolve().then(() => {
        this.checkpointScheduled = false
        if (this.isClosingIndex) return
        void this._enqueue(() => this._checkpoint()).catch((error) => {
          this.logger.warn('Scheduled TurboVec checkpoint failed:', error)
        })
      })
    }
  }

  private async _checkpoint(): Promise<boolean> {
    if (
      !this.checkpointDir ||
      !this.index ||
      !this.dirty ||
      !this.activeStorage ||
      this.needsRecovery
    ) {
      return false
    }
    this._assertWriterOwnership()
    fs.mkdirSync(this.checkpointDir, { recursive: true })
    const checkpointId = `${this.lockOwner.slice(0, 12)}-${Date.now()}`
    const snapshot = `index-${this.indexRevision}-${checkpointId}.tvim`
    const snapshotPath = path.join(this.checkpointDir, snapshot)
    const temporarySnapshot = `${snapshotPath}.tmp`
    const manifestPath = this._manifestPath()
    const temporaryManifest = `${manifestPath}.tmp-${checkpointId}`
    let manifestInstalled = false
    try {
      this.index.write(temporarySnapshot)
      this._assertWriterOwnership()
      fs.renameSync(temporarySnapshot, snapshotPath)

      const manifest: CheckpointManifest = {
        version: MANIFEST_VERSION,
        revision: this.indexRevision,
        dimension: this.index.dim,
        storage: this.activeStorage,
        mappingVersion: ID_MAPPING_VERSION,
        snapshot
      }
      fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest)}\n`)
      const manifestFd = fs.openSync(temporaryManifest, 'r')
      try {
        fs.fsyncSync(manifestFd)
      } finally {
        fs.closeSync(manifestFd)
      }
      this._assertWriterOwnership()
      fs.renameSync(temporaryManifest, manifestPath)
      manifestInstalled = true

      this._assertWriterOwnership()
      if (this._syncCheckpointDirectory()) {
        await this._pruneMutations(manifest.revision)
      }
      this._assertWriterOwnership()
      this._removeOldSnapshots(snapshot)
      this.dirty = false
      this.mutationsSinceCheckpoint = 0
      return true
    } finally {
      if (fs.existsSync(temporaryManifest)) fs.unlinkSync(temporaryManifest)
      if (fs.existsSync(temporarySnapshot)) fs.unlinkSync(temporarySnapshot)
      if (!manifestInstalled && fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath)
    }
  }

  private _readManifest(): CheckpointManifest | null {
    const manifestPath = this._manifestPath()
    if (!fs.existsSync(manifestPath)) return null
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CheckpointManifest
    if (
      parsed.version !== MANIFEST_VERSION ||
      !Number.isInteger(parsed.revision) ||
      !Number.isInteger(parsed.dimension) ||
      typeof parsed.snapshot !== 'string' ||
      typeof parsed.storage !== 'string' ||
      parsed.mappingVersion !== ID_MAPPING_VERSION
    ) {
      return null
    }
    if (!fs.existsSync(path.join(this.checkpointDir!, parsed.snapshot))) return null
    return parsed
  }

  private _manifestPath(): string {
    return path.join(this.checkpointDir!, 'manifest.json')
  }

  private _syncCheckpointDirectory(): boolean {
    let directoryFd: number | null = null
    try {
      directoryFd = fs.openSync(this.checkpointDir!, 'r')
      fs.fsyncSync(directoryFd)
      return true
    } catch (error) {
      this.logger.warn(
        'Checkpoint directory durability could not be confirmed; retaining mutation history:',
        error
      )
      return false
    } finally {
      if (directoryFd !== null) fs.closeSync(directoryFd)
    }
  }

  private async _pruneMutations(revision: number): Promise<void> {
    const covered = await this.storage.withSnapshot((snapshot) =>
      this.storage.findEntries<MutationRecord>(snapshot, this.mutationsTable, {
        lte: { revision }
      })
    )
    if (covered.length === 0) return
    this._assertWriterOwnership()
    const tx = await this.storage.db!.exclusiveTransaction()
    try {
      await Promise.all(
        covered.map((mutation) => tx.delete(this.mutationsTable, { revision: mutation.revision }))
      )
      this._assertWriterOwnership()
      await tx.flush()
    } finally {
      await tx.close()
    }
  }

  private _removeOldSnapshots(current: string): void {
    for (const entry of fs.readdirSync(this.checkpointDir!)) {
      if (entry.startsWith('index-') && entry.endsWith('.tvim') && entry !== current) {
        this._assertWriterOwnership()
        fs.unlinkSync(path.join(this.checkpointDir!, entry))
      }
    }
  }

  private _acquireLock(): void {
    if (!this.checkpointDir) return
    fs.mkdirSync(this.checkpointDir, { recursive: true })
    const lockPath = path.join(this.checkpointDir, 'writer.lock')
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.mkdirSync(lockPath)
        try {
          this._writeLockRecord(lockPath, false)
          this.ownsLock = true
          this._startLockHeartbeat(lockPath)
        } catch (error) {
          this._removeLockArtifact(lockPath)
          throw error
        }
        return
      } catch (error) {
        lastError = error
        if (!fs.existsSync(lockPath)) continue
        const updatedAt = this._readLockTimestamp(lockPath)
        if (Date.now() - updatedAt < this.lockStaleMs) {
          throw new QvacErrorRAG({
            code: ERR_CODES.DB_OPERATION_FAILED,
            adds: `TurboVec workspace is already locked: ${lockPath}`
          })
        }
        const stalePath = `${lockPath}.stale-${this.lockOwner}-${attempt}`
        try {
          fs.renameSync(lockPath, stalePath)
          this._removeLockArtifact(stalePath)
        } catch (recoveryError) {
          lastError = recoveryError
        }
      }
    }

    throw new QvacErrorRAG({
      code: ERR_CODES.DB_OPERATION_FAILED,
      adds: `Failed to acquire the TurboVec writer lock: ${lockPath}`,
      cause: lastError instanceof Error ? lastError : undefined
    })
  }

  private _releaseLock(): void {
    if (this.lockHeartbeat !== null) {
      timerRuntime.clearInterval(this.lockHeartbeat)
      this.lockHeartbeat = null
    }
    if (!this.checkpointDir || !this.ownsLock) return
    const lockPath = path.join(this.checkpointDir, 'writer.lock')
    this.ownsLock = false
    if (this._readLockRecord(lockPath)?.owner === this.lockOwner) {
      this._removeLockArtifact(lockPath)
    }
  }

  private _startLockHeartbeat(lockPath: string): void {
    const heartbeat = timerRuntime.setInterval(() => {
      try {
        this._assertWriterOwnership()
        this._writeLockRecord(lockPath)
      } catch (error) {
        this.logger.warn('TurboVec writer lock heartbeat failed:', error)
      }
    }, this.lockHeartbeatMs)
    heartbeat.unref?.()
    this.lockHeartbeat = heartbeat
  }

  private _writeLockRecord(lockPath: string, verifyOwnership = true): void {
    const record: LockRecord = {
      owner: this.lockOwner,
      updatedAt: Date.now()
    }
    const ownerPath = path.join(lockPath, 'owner.json')
    const temporaryOwnerPath = path.join(lockPath, `owner.json.tmp-${this.lockOwner}`)
    if (verifyOwnership) this._assertWriterOwnership()
    try {
      fs.writeFileSync(temporaryOwnerPath, `${JSON.stringify(record)}\n`)
      const ownerFd = fs.openSync(temporaryOwnerPath, 'r')
      try {
        fs.fsyncSync(ownerFd)
      } finally {
        fs.closeSync(ownerFd)
      }
      if (verifyOwnership) this._assertWriterOwnership()
      fs.renameSync(temporaryOwnerPath, ownerPath)
    } finally {
      if (fs.existsSync(temporaryOwnerPath)) fs.unlinkSync(temporaryOwnerPath)
    }
  }

  private _readLockRecord(lockPath: string): LockRecord | null {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')
      ) as LockRecord
      if (typeof parsed.owner !== 'string' || !Number.isFinite(parsed.updatedAt)) return null
      return parsed
    } catch {
      return null
    }
  }

  private _readLockTimestamp(lockPath: string): number {
    const record = this._readLockRecord(lockPath)
    if (record) return record.updatedAt
    try {
      return fs.statSync(lockPath).mtimeMs
    } catch {
      return 0
    }
  }

  private _removeLockArtifact(lockPath: string): void {
    try {
      for (const entry of fs.readdirSync(lockPath)) {
        if (entry === 'owner.json' || entry.startsWith('owner.json.tmp-')) {
          fs.unlinkSync(path.join(lockPath, entry))
        }
      }
      fs.rmdirSync(lockPath)
    } catch {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath)
    }
  }

  private _assertWriterOwnership(): void {
    if (!this.checkpointDir) return
    const lockPath = path.join(this.checkpointDir, 'writer.lock')
    if (
      this.writerFenced ||
      !this.ownsLock ||
      this._readLockRecord(lockPath)?.owner !== this.lockOwner
    ) {
      this._fenceWriter()
      throw this._lockLostError()
    }
  }

  private _fenceWriter(): void {
    if (this.lockHeartbeat !== null) {
      timerRuntime.clearInterval(this.lockHeartbeat)
      this.lockHeartbeat = null
    }
    this.ownsLock = false
    this.writerFenced = true
    this.needsRecovery = true
  }

  private _lockLostError(): QvacErrorRAG {
    return new QvacErrorRAG({
      code: ERR_CODES.DB_OPERATION_FAILED,
      adds: 'TurboVec writer lock ownership was lost'
    })
  }
}
