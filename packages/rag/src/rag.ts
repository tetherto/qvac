import HyperDB from 'hyperdb'
import qvacCrypto from '#crypto'

import dbSpec from './db/hyperspec/hyperdb/index.js'
import { QvacErrorRAG, ERR_CODES, toRagError } from './errors.js'
import {
  FIRST_NATIVE_ID,
  MAX_NATIVE_ID,
  decodeNativeId,
  encodeNativeId,
  encodeVector,
  packNativeIds
} from './db/encoding.js'
import {
  CHUNKS,
  DOCUMENTS,
  MUTATIONS,
  NAMESPACES,
  NATIVE_IDS,
  SPACES,
  type ChunkRecord,
  type DocumentRecord,
  type NamespaceRecord,
  type SpaceRecord
} from './db/records.js'
import {
  parseDelete,
  parseIngest,
  parseNamespaceName,
  parseSearch,
  type ValidDocument
} from './input.js'
import { intersectScope, parseScope } from './scope.js'
import { checkQuery, scanSearch, type SearchQuery } from './search.js'
import { computeSpaceId, parseEmbeddingSpace } from './space.js'
import { parseIndexOptions, parseIndexStorage } from './vector-index/options.js'
import {
  DEFAULT_INDEX_STORAGE,
  createIndexRegistry,
  type IndexConfig,
  type IndexRegistry
} from './vector-index/registry.js'
import { indexSearch } from './vector-index/search.js'
import type {
  Hypercore,
  HyperDBInstance,
  HyperDBReader,
  HyperDBTransaction
} from './db/db-types.js'
import type {
  CreateNamespaceParams,
  CreateRagOptions,
  DeleteDocumentsParams,
  DeleteDocumentsResult,
  IngestedDocument,
  IngestParams,
  IndexStorage,
  IngestResult,
  NamespaceInfo,
  Rag,
  ScopedRag,
  ScopedSearchParams,
  SearchHit,
  SearchParams,
  SearchScope
} from './types.js'

const CORE_NAME = 'qvac-rag'
const SEARCH_INDEX_ATTEMPTS = 3

// One HyperDB per core, shared by every RAG opened on it. Separate instances
// would each serialize only their own transactions and overwrite each other.
// Databases are keyed by the state every session of one core shares, so a
// Corestore session or wrapper finds the same writer, and two directories
// holding a core with the same key do not.
interface OpenDatabase {
  db: HyperDBInstance
  indexes: IndexRegistry
}

interface SharedDatabase {
  opening: Promise<OpenDatabase>
  refs: number
}

const sharedDatabases = new WeakMap<object, SharedDatabase>()

async function acquireDatabase(
  core: Hypercore
): Promise<OpenDatabase & { release: () => Promise<void> }> {
  let identity: object | null = null
  try {
    await core.ready()
    identity = core.core ?? null
    if (!identity) {
      throw new QvacErrorRAG({
        code: ERR_CODES.DB_OPERATION_FAILED,
        adds: 'the Corestore did not return a Hypercore with shared core state'
      })
    }
  } catch (error) {
    await core.close().catch(() => {})
    throw error
  }

  const key = identity
  let entry = sharedDatabases.get(key)
  const reused = entry !== undefined
  if (!entry) {
    const created: SharedDatabase = { opening: openDatabase(core), refs: 0 }
    created.opening.catch(() => {
      if (sharedDatabases.get(key) === created) sharedDatabases.delete(key)
    })
    sharedDatabases.set(key, created)
    entry = created
  }
  const acquired = entry
  acquired.refs++
  try {
    if (reused) await core.close()
    const { db, indexes } = await acquired.opening
    return { db, indexes, release: () => releaseDatabase(key, acquired) }
  } catch (error) {
    acquired.refs--
    throw error
  }
}

async function releaseDatabase(key: object, entry: SharedDatabase): Promise<void> {
  if (--entry.refs > 0) return
  if (sharedDatabases.get(key) === entry) sharedDatabases.delete(key)
  const { db, indexes } = await entry.opening
  // Snapshots on close prune mutations, which needs the database still open.
  await indexes.close()
  await db.close()
}

async function openDatabase(core: Hypercore): Promise<OpenDatabase> {
  const instance = HyperDB.bee(core, dbSpec, { autoUpdate: true })
  try {
    await instance.ready()
  } catch (error) {
    await instance.close().catch(() => {})
    throw error
  }
  return { db: instance, indexes: createIndexRegistry(instance, toHex(core.key)) }
}

function toHex(bytes: Uint8Array | null | undefined): string {
  if (!bytes) return 'unknown'
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createRag(options: CreateRagOptions): Rag {
  const corestore = options?.corestore
  if (!corestore || typeof corestore.get !== 'function') {
    throw new QvacErrorRAG({
      code: ERR_CODES.INVALID_INPUT,
      adds: 'createRag needs a Corestore instance'
    })
  }

  const indexConfig: IndexConfig = parseIndexOptions(options.index)
  let db: HyperDBInstance | null = null
  let indexes: IndexRegistry | null = null
  let release: (() => Promise<void>) | null = null
  let opening: Promise<void> | null = null
  let closed = false
  let closing: Promise<void> | null = null
  const inflight = new Set<Promise<unknown>>()

  // A failed open is not cached, so ready() can be retried.
  function ready(): Promise<void> {
    if (closed) return Promise.reject(notReady('it has been closed'))
    if (!opening) {
      opening = open().catch((error) => {
        opening = null
        throw toRagError(error)
      })
    }
    return opening
  }

  async function open(): Promise<void> {
    await corestore.ready()
    const acquired = await acquireDatabase(corestore.get({ name: CORE_NAME }))
    db = acquired.db
    indexes = acquired.indexes
    release = acquired.release
  }

  // The Corestore belongs to the caller and stays open. Every caller gets the
  // same promise, so a repeated close() also waits for the drain.
  function close(): Promise<void> {
    if (!closing) {
      closed = true
      closing = drain()
    }
    return closing
  }

  async function drain(): Promise<void> {
    if (opening) await opening.catch(() => {})
    await Promise.allSettled(inflight)
    db = null
    indexes = null
    const releasing = release
    release = null
    if (releasing) await releasing()
  }

  // close() waits for every call started before it. Each call checks
  // database() before its first await, so nothing starts once close() runs.
  function track<T>(run: () => Promise<T>): Promise<T> {
    const pending = run()
    inflight.add(pending)
    const settle = () => inflight.delete(pending)
    pending.then(settle, settle)
    return pending
  }

  function database(): HyperDBInstance {
    if (closed) throw notReady('it has been closed')
    if (!db) throw notReady('call ready() first')
    return db
  }

  function registry(): IndexRegistry {
    database()
    return indexes as IndexRegistry
  }

  async function createNamespace(params: CreateNamespaceParams): Promise<NamespaceInfo> {
    const name = parseNamespaceName(params?.name)
    const space = parseEmbeddingSpace(params?.space)
    const spaceId = computeSpaceId(space)
    const requested = parseIndexStorage(params?.index, space.dimensions)

    return await withTransaction(database(), async (tx) => {
      const existing = await tx.get<NamespaceRecord>(NAMESPACES, { name })
      if (existing) {
        if (existing.spaceId !== spaceId) {
          throw new QvacErrorRAG({
            code: ERR_CODES.NAMESPACE_EXISTS,
            adds: `'${name}' is bound to embedding space ${existing.spaceId}`
          })
        }
        const storage = storageOf(existing)
        if (requested !== undefined && requested !== storage) {
          throw new QvacErrorRAG({
            code: ERR_CODES.NAMESPACE_EXISTS,
            adds: `'${name}' uses index storage '${storage}'`
          })
        }
        return { name, spaceId, revision: existing.revision, index: { storage } }
      }
      const storage = requested ?? DEFAULT_INDEX_STORAGE
      if (!(await tx.get<SpaceRecord>(SPACES, { spaceId }))) {
        await tx.insert(SPACES, { spaceId, ...space })
      }
      await tx.insert(NAMESPACES, {
        name,
        spaceId,
        revision: 0,
        nextNativeId: encodeNativeId(FIRST_NATIVE_ID),
        createdAt: new Date(),
        indexStorage: storage
      })
      await tx.flush()
      return { name, spaceId, revision: 0, index: { storage } }
    })
  }

  // Each document commits in its own batch. A failure leaves earlier documents
  // committed and the failing one at its previous generation.
  async function ingest(params: IngestParams): Promise<IngestResult> {
    const { namespace, documents } = parseIngest(params)
    const instance = database()
    const indexRegistry = registry()
    const { ns, space } = await withSnapshot(instance, (reader) => readNamespace(reader, namespace))
    for (const document of documents) checkChunks(namespace, ns, space, document)

    const results: IngestedDocument[] = []
    let revision = 0
    for (const document of documents) {
      const committed = await withTransaction(instance, (tx) =>
        commitDocument(tx, indexRegistry, namespace, document)
      )
      results.push(committed.document)
      revision = committed.revision
    }
    return { documents: results, revision }
  }

  async function deleteDocuments(params: DeleteDocumentsParams): Promise<DeleteDocumentsResult> {
    const { namespace, documentIds } = parseDelete(params)
    const indexRegistry = registry()
    return await withTransaction(database(), async (tx) => {
      const ns = await getNamespace(tx, namespace)
      const deleted: string[] = []
      const removed: bigint[] = []
      for (const documentId of documentIds) {
        const document = await tx.get<DocumentRecord>(DOCUMENTS, { namespace, documentId })
        if (!document) continue
        // A spread push would exceed the argument limit on large documents.
        for (const nativeId of await deleteGeneration(tx, document)) removed.push(nativeId)
        await tx.delete(DOCUMENTS, { namespace, documentId })
        deleted.push(documentId)
      }
      if (deleted.length === 0) return { deleted, revision: ns.revision }

      const revision = await appendMutation(tx, ns, [], removed, ns.nextNativeId)
      await indexRegistry.prune(tx, namespace)
      await tx.flush()
      await indexRegistry.apply(namespace, revision, [], new Float32Array(0), removed)
      return { deleted, revision }
    })
  }

  // A direct caller names documents explicitly, so an unknown one is an error.
  async function search(params: SearchParams): Promise<SearchHit[]> {
    const { scope, vector, spaceId, k, signal } = parseSearch(params)
    return await runSearch(parseScope(scope), { vector, spaceId }, k, { strict: true, signal })
  }

  // A handle's documents are granted, not chosen per request: an ID the
  // namespace no longer has is skipped, so the handle keeps working with what
  // remains and fails closed to no hits. Only the scope's shape can error.
  function scoped(scope: SearchScope): ScopedRag {
    const bound = parseScope(scope)
    return {
      async search(params: ScopedSearchParams): Promise<SearchHit[]> {
        const {
          scope: request,
          vector,
          spaceId,
          k,
          signal
        } = parseSearch({
          scope: undefined,
          ...params
        })
        const query = { vector, spaceId }
        return await runSearch(intersectScope(bound, request), query, k, { strict: false, signal })
      }
    }
  }

  // A commit landing between the reader's snapshot and the index lookup makes
  // the index stale for that reader; a few retries on a fresh snapshot usually
  // line them up, and the scan is always consistent with its reader.
  async function runSearch(
    scope: SearchScope,
    query: SearchQuery,
    k: number,
    options: { strict: boolean; signal?: AbortSignal }
  ): Promise<SearchHit[]> {
    const indexRegistry = registry()
    const instance = database()
    const open = () => indexRegistry.open(scope.namespace, indexConfig)
    for (let attempt = 0; ; attempt++) {
      const result = await withSnapshot(instance, async (reader) => {
        const { ns, space } = await readNamespace(reader, scope.namespace)
        // A bad query fails before it can trigger an index rebuild.
        checkQuery(space, scope, query)
        const scan = () => scanSearch(reader, space, scope, query, k, options)
        if (attempt === SEARCH_INDEX_ATTEMPTS) return await scan()
        const hits = await indexSearch(reader, ns.revision, space, scope, query, k, open, options)
        if (hits === 'unavailable') return await scan()
        return hits
      })
      if (result !== 'stale') return result
    }
  }

  return {
    ready,
    close,
    createNamespace: (params) => track(() => createNamespace(params)),
    ingest: (params) => track(() => ingest(params)),
    deleteDocuments: (params) => track(() => deleteDocuments(params)),
    search: (params) => track(() => search(params)),
    scoped: (scope) => {
      const handle = scoped(scope)
      return { search: (params) => track(() => handle.search(params)) }
    }
  }
}

async function commitDocument(
  tx: HyperDBTransaction,
  indexes: IndexRegistry,
  namespace: string,
  document: ValidDocument
): Promise<{ document: IngestedDocument; revision: number }> {
  const ns = await getNamespace(tx, namespace)
  const previous = await tx.get<DocumentRecord>(DOCUMENTS, { namespace, documentId: document.id })
  const removed = previous ? await deleteGeneration(tx, previous) : []
  const generation = previous ? previous.generation + 1 : 1

  let nextId = decodeNativeId(ns.nextNativeId)
  if (MAX_NATIVE_ID - nextId + 1n < BigInt(document.chunks.length)) {
    throw new QvacErrorRAG({ code: ERR_CODES.NATIVE_ID_EXHAUSTED, adds: namespace })
  }

  const added: bigint[] = []
  for (let ordinal = 0; ordinal < document.chunks.length; ordinal++) {
    const chunk = document.chunks[ordinal]
    const nativeId = encodeNativeId(nextId)
    added.push(nextId)
    nextId++
    await tx.insert(CHUNKS, {
      namespace,
      documentId: document.id,
      generation,
      ordinal,
      chunkId: chunk.id,
      content: chunk.content,
      metadataJson: chunk.metadataJson,
      nativeId,
      vector: encodeVector(chunk.embedding)
    })
    await tx.insert(NATIVE_IDS, {
      namespace,
      nativeId,
      documentId: document.id,
      generation,
      ordinal
    })
  }

  await tx.insert(DOCUMENTS, {
    namespace,
    documentId: document.id,
    generation,
    chunkCount: document.chunks.length,
    contentHash: hashDocument(document),
    metadata: document.metadata,
    updatedAt: new Date()
  })
  const revision = await appendMutation(tx, ns, added, removed, encodeNativeId(nextId))
  await indexes.prune(tx, namespace)
  await tx.flush()
  await indexes.apply(namespace, revision, added, concatEmbeddings(document), removed)

  return {
    document: { id: document.id, generation, chunkCount: document.chunks.length },
    revision
  }
}

// Deletes a document's current chunks and their native IDs; returns the IDs.
async function deleteGeneration(
  tx: HyperDBTransaction,
  document: DocumentRecord
): Promise<bigint[]> {
  const { namespace, documentId, generation } = document
  const key = { namespace, documentId, generation }
  const chunks = await tx.find<ChunkRecord>(CHUNKS, { gte: key, lte: key }).toArray()
  const removed: bigint[] = []
  for (const chunk of chunks) {
    await tx.delete(CHUNKS, chunk)
    await tx.delete(NATIVE_IDS, { namespace, nativeId: chunk.nativeId })
    removed.push(decodeNativeId(chunk.nativeId))
  }
  return removed
}

async function appendMutation(
  tx: HyperDBTransaction,
  ns: NamespaceRecord,
  added: bigint[],
  removed: bigint[],
  nextNativeId: Uint8Array
): Promise<number> {
  const revision = ns.revision + 1
  await tx.insert(MUTATIONS, {
    namespace: ns.name,
    revision,
    added: packNativeIds(added),
    removed: packNativeIds(removed),
    createdAt: new Date()
  })
  await tx.insert(NAMESPACES, { ...ns, revision, nextNativeId })
  return revision
}

function concatEmbeddings(document: ValidDocument): Float32Array {
  const dims = document.chunks[0]?.embedding.length ?? 0
  const vectors = new Float32Array(document.chunks.length * dims)
  document.chunks.forEach((chunk, i) => vectors.set(chunk.embedding, i * dims))
  return vectors
}

function storageOf(ns: NamespaceRecord): IndexStorage {
  return (ns.indexStorage as IndexStorage | undefined) ?? DEFAULT_INDEX_STORAGE
}

// TurboVec quantization rejects components at or above this magnitude.
const TURBOVEC_MAX_COMPONENT = 1e16

function checkChunks(
  namespace: string,
  ns: NamespaceRecord,
  space: SpaceRecord,
  document: ValidDocument
): void {
  const turbovec = storageOf(ns).startsWith('turbovec-')
  for (const chunk of document.chunks) {
    if (chunk.spaceId !== space.spaceId) {
      throw new QvacErrorRAG({
        code: ERR_CODES.EMBEDDING_SPACE_MISMATCH,
        adds: `chunk '${chunk.id}' is in space ${chunk.spaceId}, namespace '${namespace}' is in ${space.spaceId}`
      })
    }
    if (chunk.embedding.length !== space.dimensions) {
      throw new QvacErrorRAG({
        code: ERR_CODES.EMBEDDING_DIMENSION_MISMATCH,
        adds: `chunk '${chunk.id}' has ${chunk.embedding.length} dimensions, namespace '${namespace}' expects ${space.dimensions}`
      })
    }
    if (turbovec && chunk.embedding.some((value) => Math.abs(value) >= TURBOVEC_MAX_COMPONENT)) {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: `chunk '${chunk.id}' has a component of magnitude 1e16 or more, which '${storageOf(ns)}' storage can't index`
      })
    }
  }
}

function hashDocument(document: ValidDocument): string {
  const hash = qvacCrypto.createHash('sha256')
  for (const chunk of document.chunks) {
    hash.update(JSON.stringify([chunk.id, chunk.content, chunk.metadataJson ?? null]))
  }
  return hash.digest('hex') as string
}

async function getNamespace(reader: HyperDBReader, name: string): Promise<NamespaceRecord> {
  const ns = await reader.get<NamespaceRecord>(NAMESPACES, { name })
  if (!ns) throw new QvacErrorRAG({ code: ERR_CODES.NAMESPACE_NOT_FOUND, adds: name })
  return ns
}

async function readNamespace(
  reader: HyperDBReader,
  name: string
): Promise<{ ns: NamespaceRecord; space: SpaceRecord }> {
  const ns = await getNamespace(reader, name)
  const space = await reader.get<SpaceRecord>(SPACES, { spaceId: ns.spaceId })
  if (!space) {
    throw new QvacErrorRAG({
      code: ERR_CODES.DB_OPERATION_FAILED,
      adds: `embedding space ${ns.spaceId} of namespace '${name}' is missing`
    })
  }
  return { ns, space }
}

async function withSnapshot<T>(
  db: HyperDBInstance,
  operation: (reader: HyperDBReader) => Promise<T>
): Promise<T> {
  const snapshot = db.snapshot()
  try {
    return await operation(snapshot)
  } catch (error) {
    throw toRagError(error)
  } finally {
    await snapshot.close()
  }
}

// Unflushed writes are dropped when the transaction closes.
async function withTransaction<T>(
  db: HyperDBInstance,
  operation: (tx: HyperDBTransaction) => Promise<T>
): Promise<T> {
  const tx = await db.exclusiveTransaction()
  try {
    return await operation(tx)
  } catch (error) {
    throw toRagError(error)
  } finally {
    await tx.close()
  }
}

function notReady(reason: string): QvacErrorRAG {
  return new QvacErrorRAG({ code: ERR_CODES.NOT_READY, adds: reason })
}
