import { parseRagMetadata } from 'rag-extract/chunk'
import qvacCrypto from '#crypto'

import { QvacErrorRAG, ERR_CODES, toRagError } from './errors.js'
import {
  DEFAULT_VECTOR_ENCODING,
  F16_MAX,
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
  TOMBSTONES,
  type ChunkRecord,
  type DocumentRecord,
  type NamespaceRecord,
  type SpaceRecord
} from './db/records.js'
import { DEFAULT_INDEX_STORAGE, type IndexRegistry } from './vector-index/registry.js'
import { TURBOVEC_MAX_COMPONENT } from './vector-index/native.js'
import type { ValidDocument } from './input.js'
import type { HyperDBInstance, HyperDBReader, HyperDBTransaction } from './db/db-types.js'
import type { IndexStorage, VectorEncoding } from './types.js'

// Writes `document` as `generation`, replacing `previous` when there is one,
// and commits the batch. Shared by ingest and import, so both keep native
// IDs, mutations and the open index in step.
export async function writeGeneration(
  tx: HyperDBTransaction,
  indexes: IndexRegistry,
  ns: NamespaceRecord,
  document: ValidDocument,
  contentHash: string,
  generation: number,
  previous: DocumentRecord | null
): Promise<{ revision: number; removedChunks: number }> {
  const namespace = ns.name
  const encoding = encodingOf(ns)
  const removed = previous ? await deleteGeneration(tx, previous) : []

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
      vector: encodeVector(chunk.embedding, encoding)
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
    contentHash,
    metadata: document.metadata,
    updatedAt: new Date(),
    revision: ns.revision + 1
  })
  const revision = await appendMutation(tx, ns, added, removed, encodeNativeId(nextId))
  await indexes.prune(tx, namespace)
  await tx.flush()
  await indexes.apply(namespace, revision, added, () => concatEmbeddings(document), removed)
  return { revision, removedChunks: removed.length }
}

// Removes a document and records `generation` (its own unless a later one is
// known) so the ID never goes back below it. Returns the removed native IDs.
export async function deleteDocument(
  tx: HyperDBTransaction,
  document: DocumentRecord,
  generation: number = document.generation
): Promise<bigint[]> {
  const { namespace, documentId } = document
  const removed = await deleteGeneration(tx, document)
  await tx.delete(DOCUMENTS, { namespace, documentId })
  await tx.insert(TOMBSTONES, { namespace, documentId, generation, deletedAt: new Date() })
  return removed
}

// Deletes a document's current chunks and their native IDs; returns the IDs.
export async function deleteGeneration(
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

export async function appendMutation(
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
  // Namespaces from before lineages existed get theirs on their first write.
  const lineageId = ns.lineageId ?? newLineageId()
  await tx.insert(NAMESPACES, { ...ns, revision, nextNativeId, lineageId })
  return revision
}

export function newLineageId(): Uint8Array {
  if (qvacCrypto.randomBytes) return qvacCrypto.randomBytes(16)
  if (qvacCrypto.getRandomValues) return qvacCrypto.getRandomValues(new Uint8Array(16))
  throw new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: 'crypto.randomBytes or crypto.getRandomValues is needed to create a namespace'
  })
}

export function concatEmbeddings(document: ValidDocument): Float32Array {
  const dims = document.chunks[0]?.embedding.length ?? 0
  const vectors = new Float32Array(document.chunks.length * dims)
  document.chunks.forEach((chunk, i) => vectors.set(chunk.embedding, i * dims))
  return vectors
}

export function storageOf(ns: NamespaceRecord): IndexStorage {
  return (ns.indexStorage as IndexStorage | undefined) ?? DEFAULT_INDEX_STORAGE
}

export function encodingOf(ns: NamespaceRecord): VectorEncoding {
  return (ns.vectorEncoding as VectorEncoding | null | undefined) ?? DEFAULT_VECTOR_ENCODING
}

export function checkChunks(
  namespace: string,
  ns: NamespaceRecord,
  space: SpaceRecord,
  document: ValidDocument
): void {
  const turbovec = storageOf(ns).startsWith('turbovec-')
  const f16 = encodingOf(ns) === 'f16'
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
    if (f16 && chunk.embedding.some((value) => Math.abs(value) > F16_MAX)) {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: `chunk '${chunk.id}' has a component above ${F16_MAX} in magnitude, which 'f16' vectors can't hold`
      })
    }
  }
}

export async function getNamespace(reader: HyperDBReader, name: string): Promise<NamespaceRecord> {
  const ns = await reader.get<NamespaceRecord>(NAMESPACES, { name })
  if (!ns) throw new QvacErrorRAG({ code: ERR_CODES.NAMESPACE_NOT_FOUND, adds: name })
  return ns
}

export async function readNamespace(
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

export async function withSnapshot<T>(
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
export async function withTransaction<T>(
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

export function sameLineage(
  a: Uint8Array | null | undefined,
  b: Uint8Array | null | undefined
): boolean {
  if (!a || !b || a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

// Text documents are hashed after chunking, so new chunking options are a
// change. Vectors are hashed only when precomputed; a port's are fixed by its space.
export function hashContent(
  spaceId: string,
  metadata: Record<string, unknown> | undefined,
  chunks: Array<{ id: string; content: string; metadataJson?: string }>,
  vectors: Array<Float32Array | undefined>
): string {
  const hash = qvacCrypto.createHash('sha256')
  hash.update(JSON.stringify(['qvac-rag-content-v1', spaceId, metadata ?? null]))
  chunks.forEach((chunk, ordinal) => {
    hash.update(JSON.stringify([chunk.id, chunk.content, comparableMetadata(chunk.metadataJson)]))
    const vector = vectors[ordinal]
    if (vector) hash.update(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength))
  })
  return hash.digest('hex') as string
}

// rag-extract stamps every chunk with the time it was chunked, which would make
// the same text a change on every ingest. Other metadata is compared as is.
function comparableMetadata(metadataJson: string | undefined): string | null {
  if (metadataJson === undefined) return null
  if (!parseRagMetadata(metadataJson)) return metadataJson
  const { indexedAt: _indexedAt, ...rest } = JSON.parse(metadataJson) as Record<string, unknown>
  return JSON.stringify(rest)
}
