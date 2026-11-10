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
  EMBED_BATCH_SIZE,
  createChunker,
  createEmbedder,
  type Chunker,
  type Embedder
} from './embeddings.js'
import {
  parseDelete,
  parseIngest,
  parseIngestOptions,
  parseNamespaceName,
  parseSearch,
  type ParsedDocument,
  type ValidDocument,
  type ValidSearch,
  type ValidTextChunk
} from './input.js'
import { intersectScope, parseScope } from './scope.js'
import { checkQuery, scanSearch, throwIfAborted, type SearchQuery } from './search.js'
import { computeSpaceId, parseEmbeddingSpace } from './space.js'
import { parseIndexOptions, parseIndexStorage } from './vector-index/options.js'
import {
  DEFAULT_INDEX_STORAGE,
  createIndexRegistry,
  type IndexConfig,
  type IndexRegistry
} from './vector-index/registry.js'
import { indexSearch } from './vector-index/search.js'
import { TURBOVEC_MAX_COMPONENT } from './vector-index/native.js'
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
  IngestOptions,
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

interface SearchHandles {
  instance: HyperDBInstance
  indexRegistry: IndexRegistry
}

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
  const embedder = createEmbedder(options.embeddings)
  const chunker = createChunker(options.chunking)

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

  function searchHandles(): SearchHandles {
    return { instance: database(), indexRegistry: registry() }
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

  // Each document commits in its own batch, in input order, as soon as all of
  // its chunks are embedded. A failure leaves earlier documents committed and
  // the failing one at its previous generation; an abort skips the rest.
  async function ingest(params: IngestParams, options?: IngestOptions): Promise<IngestResult> {
    const { namespace, documents } = parseIngest(params)
    const { signal, onProgress } = parseIngestOptions(options)
    const instance = database()
    const indexRegistry = registry()
    const { ns, space } = await withSnapshot(instance, (reader) => readNamespace(reader, namespace))
    const port = documents.some((entry) => entry.kind !== 'embedded')
      ? requireEmbedder(namespace, space)
      : null
    for (const entry of documents) {
      if (entry.kind === 'embedded') checkChunks(namespace, ns, space, entry.document)
    }

    const jobs = prepareJobs(documents, chunker, onProgress)
    // The jobs hold everything still needed; committed ones are released below.
    documents.length = 0
    const queue: Array<{ job: IngestJob; ordinal: number }> = []
    for (const job of jobs) {
      job.vectors.forEach((vector, ordinal) => {
        if (!vector) queue.push({ job, ordinal })
      })
    }

    const results: IngestedDocument[] = []
    let revision = ns.revision
    let next = 0
    let cancelled = false

    // Returns false once the signal has aborted.
    async function commitReady(): Promise<boolean> {
      while (next < jobs.length && jobs[next].missing === 0) {
        // Checked once the lock is held, so an abort while waiting for another
        // write still skips this document.
        const job = jobs[next]
        const document = toValidDocument(job, space.spaceId)
        checkChunks(namespace, ns, space, document)
        const committed = await withTransaction(instance, (tx) =>
          signal?.aborted
            ? Promise.resolve(null)
            : commitDocument(tx, indexRegistry, namespace, document)
        )
        if (!committed) return false
        // A large call would otherwise hold every vector it embedded until it returns.
        job.chunks = []
        job.vectors = []
        results.push(committed.document)
        revision = committed.revision
        next++
        onProgress?.({ stage: 'commit', done: next, total: jobs.length })
      }
      return true
    }

    try {
      cancelled = !(await commitReady())
      for (let start = 0; !cancelled && start < queue.length; start += EMBED_BATCH_SIZE) {
        if (signal?.aborted) {
          cancelled = true
          break
        }
        const batch = queue.slice(start, start + EMBED_BATCH_SIZE)
        const rows = await (port as Embedder).embedDocuments(
          batch.map(({ job, ordinal }) => job.chunks[ordinal].content),
          signal
        )
        batch.forEach(({ job, ordinal }, row) => {
          job.vectors[ordinal] = rows[row]
          job.missing--
        })
        onProgress?.({ stage: 'embed', done: start + batch.length, total: queue.length })
        cancelled = !(await commitReady())
      }
    } catch (error) {
      if (!(error instanceof QvacErrorRAG && error.code === ERR_CODES.OPERATION_CANCELLED)) {
        throw error
      }
      cancelled = true
    }

    const skipped = jobs.slice(next).map((job) => job.id)
    return { documents: results, skipped, cancelled, revision }
  }

  function requireEmbedder(namespace: string, space: SpaceRecord): Embedder {
    if (!embedder) {
      throw new QvacErrorRAG({
        code: ERR_CODES.DEPENDENCY_REQUIRED,
        adds: 'text ingest and query search need createRag({ embeddings })'
      })
    }
    if (embedder.spaceId !== space.spaceId) {
      throw new QvacErrorRAG({
        code: ERR_CODES.EMBEDDING_SPACE_MISMATCH,
        adds: `the embeddings port is in space ${embedder.spaceId}, namespace '${namespace}' is in ${space.spaceId}`
      })
    }
    return embedder
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
      await indexRegistry.apply(namespace, revision, [], () => new Float32Array(0), removed)
      return { deleted, revision }
    })
  }

  // A direct caller names documents explicitly, so an unknown one is an error.
  async function search(params: SearchParams): Promise<SearchHit[]> {
    const request = parseSearch(params)
    const scope = parseScope(request.scope)
    const handles = searchHandles()
    const query = await resolveQuery(handles.instance, scope, request)
    if (!query) return []
    return await runSearch(handles, scope, query, request.k, {
      strict: true,
      signal: request.signal
    })
  }

  // A handle's documents are granted, not chosen per request: an ID the
  // namespace no longer has is skipped, so the handle keeps working with what
  // remains and fails closed to no hits. Only the scope's shape can error.
  function scoped(scope: SearchScope): ScopedRag {
    const bound = parseScope(scope)
    return {
      async search(params: ScopedSearchParams): Promise<SearchHit[]> {
        const request = parseSearch({ scope: undefined, ...params })
        const narrowed = intersectScope(bound, request.scope)
        const handles = searchHandles()
        const query = await resolveQuery(handles.instance, narrowed, request)
        if (!query) return []
        return await runSearch(handles, narrowed, query, request.k, {
          strict: false,
          signal: request.signal
        })
      }
    }
  }

  // A text query is embedded once, before the search, and only after the
  // namespace's space is known to match the port's. Returns null when the
  // scope is empty, since no embedding could produce a hit.
  async function resolveQuery(
    instance: HyperDBInstance,
    scope: SearchScope,
    request: ValidSearch
  ): Promise<SearchQuery | null> {
    if (request.query === undefined) return { vector: request.vector, spaceId: request.spaceId }
    const { space } = await withSnapshot(instance, (reader) =>
      readNamespace(reader, scope.namespace)
    )
    const port = requireEmbedder(scope.namespace, space)
    if (scope.documentIds?.length === 0) {
      throwIfAborted(request.signal)
      return null
    }
    return { vector: await port.embedQuery(request.query, request.signal), spaceId: port.spaceId }
  }

  // A commit landing between the reader's snapshot and the index lookup makes
  // the index stale for that reader; a few retries on a fresh snapshot usually
  // line them up, and the scan is always consistent with its reader. The
  // handles are taken before the call's first await, so close() can't drain
  // between resolving the query and the search.
  async function runSearch(
    { instance, indexRegistry }: SearchHandles,
    scope: SearchScope,
    query: SearchQuery,
    k: number,
    options: { strict: boolean; signal?: AbortSignal }
  ): Promise<SearchHit[]> {
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
    ingest: (params, options) => track(() => ingest(params, options)),
    deleteDocuments: (params) => track(() => deleteDocuments(params)),
    search: (params) => track(() => search(params)),
    scoped: (scope) => {
      const handle = scoped(scope)
      return { search: (params) => track(() => handle.search(params)) }
    }
  }
}

interface IngestJob {
  id: string
  metadata?: Record<string, unknown>
  chunks: ValidTextChunk[]
  // Precomputed vectors are set up front; the rest are filled by the port.
  vectors: Array<Float32Array | undefined>
  missing: number
}

// Chunks every text document before anything is written, so text that yields
// no chunks fails the whole call.
function prepareJobs(
  documents: ParsedDocument[],
  chunker: Chunker,
  onProgress: IngestOptions['onProgress']
): IngestJob[] {
  const textTotal = documents.filter((entry) => entry.kind === 'text').length
  let chunked = 0
  return documents.map((entry): IngestJob => {
    const { id, metadata } = entry.document
    if (entry.kind === 'embedded') {
      const vectors = entry.document.chunks.map((chunk) => chunk.embedding)
      return { id, metadata, chunks: entry.document.chunks, vectors, missing: 0 }
    }
    let chunks = entry.kind === 'chunked' ? entry.document.chunks : []
    if (entry.kind === 'text') {
      chunks = entry.document.text.trim() === '' ? [] : chunker(id, entry.document.text)
      if (chunks.length === 0) {
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: `document '${id}' has no text to chunk`
        })
      }
      chunked++
      onProgress?.({ stage: 'chunk', done: chunked, total: textTotal })
    }
    return { id, metadata, chunks, vectors: chunks.map(() => undefined), missing: chunks.length }
  })
}

function toValidDocument(job: IngestJob, spaceId: string): ValidDocument {
  return {
    id: job.id,
    metadata: job.metadata,
    chunks: job.chunks.map((chunk, ordinal) => ({
      id: chunk.id,
      content: chunk.content,
      metadataJson: chunk.metadataJson,
      embedding: job.vectors[ordinal] as Float32Array,
      spaceId
    }))
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
  await indexes.apply(namespace, revision, added, () => concatEmbeddings(document), removed)

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
