import HyperDB from 'hyperdb'
import qvacCrypto from '#crypto'

import dbSpec from './db/hyperspec/hyperdb/index.js'
import { QvacErrorRAG, ERR_CODES } from './errors.js'
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
import { scanSearch } from './search.js'
import { computeSpaceId, parseEmbeddingSpace } from './space.js'
import type { HyperDBInstance, HyperDBReader, HyperDBTransaction } from './db/db-types.js'
import type {
  CreateNamespaceParams,
  CreateRagOptions,
  DeleteDocumentsParams,
  DeleteDocumentsResult,
  IngestedDocument,
  IngestParams,
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

export function createRag(options: CreateRagOptions): Rag {
  const corestore = options?.corestore
  if (!corestore || typeof corestore.get !== 'function') {
    throw new QvacErrorRAG({
      code: ERR_CODES.INVALID_INPUT,
      adds: 'createRag needs a Corestore instance'
    })
  }

  let db: HyperDBInstance | null = null
  let opening: Promise<void> | null = null
  let closed = false

  // A failed open is not cached, so ready() can be retried.
  function ready(): Promise<void> {
    if (closed) return Promise.reject(notReady('it has been closed'))
    if (!opening) {
      opening = open().catch((error) => {
        opening = null
        throw error
      })
    }
    return opening
  }

  async function open(): Promise<void> {
    await corestore.ready()
    const instance = HyperDB.bee(corestore.get({ name: CORE_NAME }), dbSpec, { autoUpdate: true })
    await instance.ready()
    db = instance
  }

  // The Corestore belongs to the caller and stays open.
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    if (opening) await opening.catch(() => {})
    if (db) await db.close()
    db = null
  }

  function database(): HyperDBInstance {
    if (closed) throw notReady('it has been closed')
    if (!db) throw notReady('call ready() first')
    return db
  }

  async function createNamespace(params: CreateNamespaceParams): Promise<NamespaceInfo> {
    const name = parseNamespaceName(params?.name)
    const space = parseEmbeddingSpace(params?.space)
    const spaceId = computeSpaceId(space)

    return await withTransaction(database(), async (tx) => {
      const existing = await tx.get<NamespaceRecord>(NAMESPACES, { name })
      if (existing) {
        if (existing.spaceId !== spaceId) {
          throw new QvacErrorRAG({
            code: ERR_CODES.NAMESPACE_EXISTS,
            adds: `'${name}' is bound to embedding space ${existing.spaceId}`
          })
        }
        return { name, spaceId, revision: existing.revision }
      }
      if (!(await tx.get<SpaceRecord>(SPACES, { spaceId }))) {
        await tx.insert(SPACES, { spaceId, ...space })
      }
      await tx.insert(NAMESPACES, {
        name,
        spaceId,
        revision: 0,
        nextNativeId: encodeNativeId(FIRST_NATIVE_ID),
        createdAt: new Date()
      })
      await tx.flush()
      return { name, spaceId, revision: 0 }
    })
  }

  // Each document commits in its own batch. A failure leaves earlier documents
  // committed and the failing one at its previous generation.
  async function ingest(params: IngestParams): Promise<IngestResult> {
    const { namespace, documents } = parseIngest(params)
    const instance = database()
    const { space } = await withSnapshot(instance, (reader) => readNamespace(reader, namespace))
    for (const document of documents) checkChunks(namespace, space, document)

    const results: IngestedDocument[] = []
    let revision = 0
    for (const document of documents) {
      const committed = await withTransaction(instance, (tx) =>
        commitDocument(tx, namespace, document)
      )
      results.push(committed.document)
      revision = committed.revision
    }
    return { documents: results, revision }
  }

  async function deleteDocuments(params: DeleteDocumentsParams): Promise<DeleteDocumentsResult> {
    const { namespace, documentIds } = parseDelete(params)
    return await withTransaction(database(), async (tx) => {
      const ns = await getNamespace(tx, namespace)
      const deleted: string[] = []
      const removed: bigint[] = []
      for (const documentId of documentIds) {
        const document = await tx.get<DocumentRecord>(DOCUMENTS, { namespace, documentId })
        if (!document) continue
        removed.push(...(await deleteGeneration(tx, document)))
        await tx.delete(DOCUMENTS, { namespace, documentId })
        deleted.push(documentId)
      }
      if (deleted.length === 0) return { deleted, revision: ns.revision }

      const revision = await appendMutation(tx, ns, [], removed, ns.nextNativeId)
      await tx.flush()
      return { deleted, revision }
    })
  }

  // A direct caller names documents explicitly, so an unknown one is an error.
  async function search(params: SearchParams): Promise<SearchHit[]> {
    const { scope, vector, k } = parseSearch(params)
    return await runSearch(parseScope(scope), vector, k, true)
  }

  // A handle's documents are granted, not chosen per request: an ID the
  // namespace no longer has is skipped, so the handle keeps working with what
  // remains and fails closed to no hits. Only the scope's shape can error.
  function scoped(scope: SearchScope): ScopedRag {
    const bound = parseScope(scope)
    return {
      async search(params: ScopedSearchParams): Promise<SearchHit[]> {
        const { scope: request, vector, k } = parseSearch({ scope: undefined, ...params })
        return await runSearch(intersectScope(bound, request), vector, k, false)
      }
    }
  }

  function runSearch(
    scope: SearchScope,
    vector: Float32Array,
    k: number,
    strict: boolean
  ): Promise<SearchHit[]> {
    return withSnapshot(database(), async (reader) => {
      const { space } = await readNamespace(reader, scope.namespace)
      return scanSearch(reader, space, scope, vector, k, { strict })
    })
  }

  return { ready, close, createNamespace, ingest, deleteDocuments, search, scoped }
}

async function commitDocument(
  tx: HyperDBTransaction,
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
  await tx.flush()

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

function checkChunks(namespace: string, space: SpaceRecord, document: ValidDocument): void {
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
    if (error instanceof QvacErrorRAG) throw error
    throw new QvacErrorRAG({
      code: ERR_CODES.DB_OPERATION_FAILED,
      adds: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error ? error : undefined
    })
  } finally {
    await tx.close()
  }
}

function notReady(reason: string): QvacErrorRAG {
  return new QvacErrorRAG({ code: ERR_CODES.NOT_READY, adds: reason })
}
