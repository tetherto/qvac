import type { LoggerInterface } from '@qvac/logging'

import fs from '#fs'
import path from '#path'
import qvacCrypto from '#crypto'
import { HyperDBAdapter, type HyperDBAdapterInput, type PreparedDoc } from './HyperDBAdapter.js'
import type { HyperDBReader, HyperDBTransaction } from './db-types.js'
import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import { calculateTextScore, cosineSimilarity } from '../../utils/helper.js'
import type {
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

interface VectorRecord {
  docId: string
  vector: number[]
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

export interface TurboVecAdapterInput extends HyperDBAdapterInput {
  indexProvider: TurboVecIndexProvider
  checkpointDir?: string
  storage?: 'turbovec-q4' | 'turbovec-q2'
  fallbackStorage?: 'f32' | 'q8' | 'q4'
  candidateMultiplier?: number
  checkpointEveryMutations?: number
  recoverStaleLock?: boolean
  workspaceStateTable?: string
  mutationsTable?: string
  nativeIdsTable?: string
  logger?: LoggerInterface
}

export class TurboVecAdapter extends HyperDBAdapter {
  readonly checkpointDir: string | undefined
  readonly preferredStorage: 'turbovec-q4' | 'turbovec-q2'
  readonly fallbackStorage: 'f32' | 'q8' | 'q4'
  readonly candidateMultiplier: number
  readonly checkpointEveryMutations: number
  readonly recoverStaleLock: boolean
  readonly workspaceStateTable: string
  readonly mutationsTable: string
  readonly nativeIdsTable: string

  private index: TurboVecIndex | null = null
  private indexRevision = 0
  private activeStorage: TurboVecIndexStorage | null = null
  private idToDocument = new Map<bigint, string>()
  private pendingRevision: number | null = null
  private operationTail: Promise<void> = Promise.resolve()
  private checkpointScheduled = false
  private dirty = false
  private needsRecovery = false
  private mutationsSinceCheckpoint = 0
  private lockFd: number | null = null
  private readonly lockOwner: string
  private readonly indexProvider: TurboVecIndexProvider
  private isClosingIndex = false

  constructor(config: TurboVecAdapterInput) {
    super(config)
    if (!config.indexProvider) {
      throw new QvacErrorRAG({
        code: ERR_CODES.DEPENDENCY_REQUIRED,
        adds: 'TurboVecAdapter requires a vector index provider'
      })
    }
    this.indexProvider = config.indexProvider
    this.checkpointDir = config.checkpointDir
    this.preferredStorage = config.storage || 'turbovec-q4'
    this.fallbackStorage = config.fallbackStorage || 'q8'
    this.candidateMultiplier = config.candidateMultiplier || 10
    this.checkpointEveryMutations = config.checkpointEveryMutations || 1000
    this.recoverStaleLock = config.recoverStaleLock || false
    this.workspaceStateTable = config.workspaceStateTable || '@rag/workspaceState'
    this.mutationsTable = config.mutationsTable || '@rag/mutations'
    this.nativeIdsTable = config.nativeIdsTable || '@rag/nativeIds'
    this.lockOwner = qvacCrypto
      .createHash('sha256')
      .update(`${Date.now()}:${Math.random()}:${this.dbName}`)
      .digest('hex') as string
  }

  get vectorStorage(): TurboVecIndexStorage | null {
    return this.activeStorage
  }

  get revision(): number {
    return this.indexRevision
  }

  override saveEmbeddings(
    embeddedDocs: Parameters<HyperDBAdapter['saveEmbeddings']>[0],
    opts: SaveEmbeddingsOpts = {}
  ): Promise<SaveEmbeddingsResult[]> {
    return this._enqueue(() => super.saveEmbeddings(embeddedDocs, opts))
  }

  override deleteEmbeddings(ids: string[]): Promise<boolean> {
    return this._enqueue(() => super.deleteEmbeddings(ids))
  }

  override search(
    query: string,
    queryVector: number[],
    params: SearchParams = {}
  ): Promise<SearchResult[]> {
    return this._enqueue(async () => {
      const { topK = 5, signal } = params
      if (!this.isInitialized) {
        throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED })
      }
      if (signal?.aborted) {
        throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
      }

      await this._refreshIndex()
      if (!this.index || this.index.length === 0) return []

      const candidateCount = Math.min(
        this.index.length,
        Math.max(topK, topK * this.candidateMultiplier)
      )
      const nativeResults = this.index.search(
        new Float32Array(this._normalizeVector(queryVector)),
        candidateCount
      )
      const candidateIds = this._resolveCandidateIds(nativeResults)
      const [vectorMap, contentMap] = await this._withSnapshot((snapshot) =>
        Promise.all([
          this._getVectors(snapshot, candidateIds),
          this._getDocumentContents(snapshot, candidateIds)
        ])
      )

      if (signal?.aborted) {
        throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
      }

      const results: SearchResult[] = []
      for (const id of candidateIds) {
        const vector = vectorMap.get(id)
        const content = contentMap.get(id)
        if (!vector || !content) continue
        const vectorScore = cosineSimilarity(queryVector, vector)
        const textScore = calculateTextScore(query, content)
        results.push({ id, content, score: vectorScore * 0.7 + textScore * 0.3 })
      }
      return results.sort((a, b) => b.score - a.score).slice(0, topK)
    })
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

  override async _open(): Promise<void> {
    await super._open()
    try {
      this._acquireLock()
      const config = await this.getConfig()
      if (config) {
        await this._recoverIndex(config.dimension)
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
        await super._close()
      } catch (closeError) {
        this.logger.warn('HyperDB cleanup after TurboVec open failure failed:', closeError)
      }
      throw error
    }
  }

  override async _close(): Promise<void> {
    this.isClosingIndex = true
    await this.operationTail
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
      await super._close()
    }
  }

  protected override async _beforeSaveFlush(
    tx: HyperDBTransaction,
    docs: PreparedDoc[],
    now: Date
  ): Promise<void> {
    for (const doc of docs) {
      await this._ensureNativeIdRecord(tx, doc.id, now)
    }
    this.pendingRevision = await this._appendMutation(
      tx,
      UPSERT_OPERATION,
      docs.map((doc) => doc.id),
      now
    )
  }

  protected override _afterSaveFlush(docs: PreparedDoc[]): Promise<void> {
    const revision = this.pendingRevision
    this.pendingRevision = null
    if (revision === null) return Promise.resolve()

    try {
      this._ensureIndex(docs[0].dimension)
      const ids = new BigUint64Array(docs.length)
      const vectors = new Float32Array(docs.length * docs[0].dimension)
      for (let index = 0; index < docs.length; index++) {
        const doc = docs[index]
        const nativeId = this._nativeIdForDocument(doc.id)
        this._assertRuntimeMapping(nativeId.value, doc.id)
        if (this.index!.contains(nativeId.value)) {
          this.index!.remove(nativeId.value)
        }
        ids[index] = nativeId.value
        vectors.set(this._normalizeVector(doc.vector), index * doc.dimension)
      }
      this.index!.addWithIds(vectors, ids)
      this.indexRevision = revision
      this._markDirty()
    } catch (error) {
      this.needsRecovery = true
      this.logger.error('TurboVec update failed after HyperDB commit; rebuild required:', error)
    }
    return Promise.resolve()
  }

  protected override async _beforeDeleteFlush(
    tx: HyperDBTransaction,
    ids: string[],
    now: Date
  ): Promise<void> {
    this.pendingRevision = await this._appendMutation(tx, DELETE_OPERATION, ids, now)
  }

  protected override _afterDeleteFlush(ids: string[]): Promise<void> {
    const revision = this.pendingRevision
    this.pendingRevision = null
    if (revision === null) return Promise.resolve()

    try {
      if (this.index) {
        for (const id of ids) {
          this.index.remove(this._nativeIdForDocument(id).value)
        }
      }
      this.indexRevision = revision
      this._markDirty()
    } catch (error) {
      this.needsRecovery = true
      this.logger.error('TurboVec delete failed after HyperDB commit; rebuild required:', error)
    }
    return Promise.resolve()
  }

  private _enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isClosingIndex) {
      return Promise.reject(
        new QvacErrorRAG({
          code: ERR_CODES.DB_ADAPTER_NOT_INITIALIZED,
          adds: 'TurboVec adapter is closing'
        })
      )
    }
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
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
    now: Date
  ): Promise<void> {
    const nativeId = this._nativeIdForDocument(documentId)
    this._assertRuntimeMapping(nativeId.value, documentId)
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
    const config = await this.getConfig()
    if (!config) return
    const currentRevision = await this._withSnapshot((snapshot) =>
      this._readCurrentRevision(snapshot)
    )

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
    const currentRevision = await this._withSnapshot((snapshot) =>
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
    const [vectors, currentRevision] = await this._withSnapshot((snapshot) =>
      Promise.all([
        this._getAllEntries<VectorRecord>(snapshot, this.vectorsTable),
        this._readCurrentRevision(snapshot)
      ])
    )
    const nextIndex = this._createIndex(config.dimension)
    const nextMappings = new Map<bigint, string>()
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

    this.index?.dispose()
    this.index = nextIndex
    this.idToDocument = nextMappings
    this.indexRevision = currentRevision
    this.needsRecovery = false
    this.dirty = true
    await this._persistMissingMappings(vectors)
    return vectors.length
  }

  private _replayMutations(fromRevision: number, toRevision: number): Promise<boolean> {
    if (!this.index || fromRevision === toRevision) {
      return Promise.resolve(fromRevision === toRevision)
    }
    return this._withSnapshot(async (snapshot) => {
      const mutations = (await this._getAllEntries<MutationRecord>(snapshot, this.mutationsTable))
        .filter((mutation) => mutation.revision > fromRevision && mutation.revision <= toRevision)
        .sort((left, right) => left.revision - right.revision)

      if (
        mutations.length === 0 ||
        mutations[0].revision !== fromRevision + 1 ||
        mutations[mutations.length - 1].revision !== toRevision
      ) {
        return false
      }

      let expectedRevision = fromRevision + 1
      try {
        for (const mutation of mutations) {
          if (mutation.revision !== expectedRevision) return false
          if (mutation.operation === DELETE_OPERATION) {
            for (const documentId of mutation.documentIds) {
              this.index!.remove(this._nativeIdForDocument(documentId).value)
            }
          } else if (mutation.operation === UPSERT_OPERATION) {
            for (const documentId of mutation.documentIds) {
              await this._replayUpsert(snapshot, documentId)
            }
          } else {
            return false
          }
          this.indexRevision = mutation.revision
          expectedRevision++
        }
        this.dirty = this.indexRevision > fromRevision
        this.needsRecovery = false
        return true
      } catch (error) {
        this.needsRecovery = true
        this.logger.warn('TurboVec mutation replay failed:', error)
        return false
      }
    })
  }

  private async _replayUpsert(snapshot: HyperDBReader, documentId: string): Promise<void> {
    const nativeId = this._nativeIdForDocument(documentId)
    const vector = await snapshot.get<VectorRecord>(this.vectorsTable, { docId: documentId })
    if (this.index!.contains(nativeId.value)) {
      this.index!.remove(nativeId.value)
    }
    if (!vector) return
    this._assertRuntimeMapping(nativeId.value, documentId)
    this.index!.addWithIds(
      new Float32Array(this._normalizeVector(vector.vector)),
      new BigUint64Array([nativeId.value])
    )
  }

  private _ensureIndex(dimension: number): void {
    if (this.index && this.index.dim === dimension) return
    this.index?.dispose()
    this.index = this._createIndex(dimension)
    this.indexRevision = 0
    this.idToDocument.clear()
  }

  private _createIndex(dimension: number): TurboVecIndex {
    if (dimension <= 1024 && dimension % 8 === 0) {
      try {
        const index = this.indexProvider.create({
          dim: dimension,
          storage: this.preferredStorage
        })
        this.activeStorage = this.preferredStorage
        return index
      } catch (error) {
        this.logger.warn(
          `TurboVec ${this.preferredStorage} is unavailable; using ${this.fallbackStorage}:`,
          error
        )
      }
    }
    const fallback = this.indexProvider.create({
      dim: dimension,
      storage: this.fallbackStorage
    })
    this.activeStorage = this.fallbackStorage
    return fallback
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
    const existing = this.idToDocument.get(nativeId)
    if (existing && existing !== documentId) {
      throw this._nativeIdCollision(nativeId.toString(16).padStart(16, '0'), existing, documentId)
    }
    this.idToDocument.set(nativeId, documentId)
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
    const records = await this._withSnapshot((snapshot) =>
      this._getAllEntries<NativeIdRecord>(snapshot, this.nativeIdsTable)
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

  private async _persistMissingMappings(vectors: VectorRecord[]): Promise<void> {
    if (vectors.length === 0) return
    const tx = await this.db!.exclusiveTransaction()
    const now = new Date()
    try {
      for (const vector of vectors) {
        await this._ensureNativeIdRecord(tx, vector.docId, now)
      }
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
    if (!this.checkpointDir || !this.index || !this.dirty || !this.activeStorage) return false
    fs.mkdirSync(this.checkpointDir, { recursive: true })
    const snapshot = `index-${this.indexRevision}.tvim`
    const snapshotPath = path.join(this.checkpointDir, snapshot)
    this.index.write(snapshotPath)

    const manifest: CheckpointManifest = {
      version: MANIFEST_VERSION,
      revision: this.indexRevision,
      dimension: this.index.dim,
      storage: this.activeStorage,
      mappingVersion: ID_MAPPING_VERSION,
      snapshot
    }
    const manifestPath = this._manifestPath()
    const temporaryManifest = `${manifestPath}.tmp-${Date.now()}`
    fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest)}\n`)
    const manifestFd = fs.openSync(temporaryManifest, 'r')
    try {
      fs.fsyncSync(manifestFd)
    } finally {
      fs.closeSync(manifestFd)
    }
    fs.renameSync(temporaryManifest, manifestPath)

    this.dirty = false
    this.mutationsSinceCheckpoint = 0
    if (this._syncCheckpointDirectory()) {
      await this._pruneMutations(manifest.revision)
    }
    this._removeOldSnapshots(snapshot)
    return true
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
    const mutations = await this._withSnapshot((snapshot) =>
      this._getAllEntries<MutationRecord>(snapshot, this.mutationsTable)
    )
    const covered = mutations.filter((mutation) => mutation.revision <= revision)
    if (covered.length === 0) return
    const tx = await this.db!.exclusiveTransaction()
    try {
      for (const mutation of covered) {
        await tx.delete(this.mutationsTable, { revision: mutation.revision })
      }
      await tx.flush()
    } finally {
      await tx.close()
    }
  }

  private _removeOldSnapshots(current: string): void {
    for (const entry of fs.readdirSync(this.checkpointDir!)) {
      if (entry.startsWith('index-') && entry.endsWith('.tvim') && entry !== current) {
        fs.unlinkSync(path.join(this.checkpointDir!, entry))
      }
    }
  }

  private _acquireLock(): void {
    if (!this.checkpointDir) return
    fs.mkdirSync(this.checkpointDir, { recursive: true })
    const lockPath = path.join(this.checkpointDir, 'writer.lock')
    if (fs.existsSync(lockPath)) {
      if (!this.recoverStaleLock) {
        throw new QvacErrorRAG({
          code: ERR_CODES.DB_OPERATION_FAILED,
          adds: `TurboVec workspace is already locked: ${lockPath}`
        })
      }
      fs.unlinkSync(lockPath)
    }
    this.lockFd = fs.openSync(lockPath, 'wx')
    try {
      fs.writeFileSync(lockPath, `${this.lockOwner}\n`)
    } catch (error) {
      fs.closeSync(this.lockFd)
      this.lockFd = null
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath)
      throw error
    }
  }

  private _releaseLock(): void {
    if (!this.checkpointDir || this.lockFd === null) return
    const lockPath = path.join(this.checkpointDir, 'writer.lock')
    fs.closeSync(this.lockFd)
    this.lockFd = null
    if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8').trim() === this.lockOwner) {
      fs.unlinkSync(lockPath)
    }
  }
}
