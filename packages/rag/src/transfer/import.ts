import { z } from 'zod'

import { QvacErrorRAG, ERR_CODES } from '../errors.js'
import { FIRST_NATIVE_ID, decodeVectorInto, encodeNativeId } from '../db/encoding.js'
import {
  DOCUMENTS,
  NAMESPACES,
  SPACES,
  TOMBSTONES,
  type DocumentRecord,
  type NamespaceRecord,
  type SpaceRecord,
  type TombstoneRecord
} from '../db/records.js'
import {
  MAX_GENERATION,
  hasProtoKey,
  metadataProblem,
  name,
  optionalJson,
  rowSizeProblem,
  text
} from '../limits.js'
import { computeSpaceId, parseEmbeddingSpace } from '../space.js'
import { parseIndexStorage } from '../vector-index/options.js'
import { DEFAULT_INDEX_STORAGE, type IndexRegistry } from '../vector-index/registry.js'
import {
  appendMutation,
  checkChunks,
  deleteDocument,
  getNamespace,
  hashContent,
  newCreatedAt,
  sameLineage,
  withSnapshot,
  writeGeneration
} from '../writes.js'
import { withTransaction } from '../db/transactions.js'
import { deleteCheck, documentCheck, fromHex } from './export.js'
import {
  FORMAT_VERSION,
  FRAME,
  createFrameReader,
  invalid,
  parseJson,
  splitChunkPayload,
  type Frame,
  type FrameReader,
  type ReadStop
} from './frames.js'
import type { ValidChunk, ValidDocument } from '../input.js'
import type { HyperDBInstance, HyperDBReader, HyperDBTransaction } from '../db/db-types.js'
import type {
  EmbeddingSpace,
  ImportedDocument,
  ImportOptions,
  ImportResult,
  ImportSkip
} from '../types.js'

export interface ImportTarget {
  instance: HyperDBInstance
  indexes: IndexRegistry
  namespace: string
  // The caller's `index` option, checked once the header gives the dimensions.
  index: unknown
  // Registers a callback that close() runs; returns its unregister.
  onClose: (halt: () => void) => () => void
}

interface Header {
  space: EmbeddingSpace
  spaceId: string
  lineageId: Uint8Array
  checks: boolean
}

interface IncomingDocument {
  document: ValidDocument
  generation: number
  contentHash: string
}

type Outcome =
  | { document: ImportedDocument; revision: number }
  | { skip: ImportSkip; revision: number }
  | { revision: number }

const headerSchema = z.object({
  format: z.literal(FORMAT_VERSION),
  spaceId: z.string().min(1),
  space: z.unknown(),
  lineageId: z.string().regex(/^[0-9a-f]{32}$/),
  revision: z.number().int().nonnegative(),
  checks: z.literal(1).optional()
})

const generationSchema = z.number().int().positive().max(MAX_GENERATION)

const documentSchema = z.object({
  id: name,
  generation: generationSchema,
  contentHash: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  chunkCount: z.number().int().nonnegative(),
  check: z.string().optional()
})

const chunkSchema = z.object({
  chunkId: name,
  ordinal: z.number().int().nonnegative(),
  content: text,
  metadataJson: optionalJson
})

const tombstoneSchema = z.object({
  id: name,
  generation: generationSchema,
  check: z.string().optional()
})

const trailerSchema = z.object({
  documents: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  tombstones: z.number().int().nonnegative()
})

// Reads one document at a time and commits it through the same path as
// ingest. Everything that can be checked without the documents is checked
// before the first write; a bad document later fails the import and leaves
// earlier ones committed, as ingest does.
//
// An abort or close() also ends a read the source never answers: before the
// header is applied it throws, after it the import returns cancelled.
export async function importStream(
  target: ImportTarget,
  source: AsyncIterable<Uint8Array>,
  options: ImportOptions
): Promise<ImportResult> {
  const stop: ReadStop = { stopped: false, wake: null }
  function halt(): void {
    stop.stopped = true
    stop.wake?.()
  }
  const { signal } = options
  signal?.addEventListener('abort', halt)
  const unregister = target.onClose(halt)
  if (signal?.aborted) halt()
  const frames = createFrameReader(source, stop)
  try {
    return await run(target, frames, stop, options)
  } finally {
    signal?.removeEventListener('abort', halt)
    unregister()
    await frames.close().catch(() => {})
  }
}

async function run(
  target: ImportTarget,
  frames: FrameReader,
  stop: ReadStop,
  { onProgress }: ImportOptions
): Promise<ImportResult> {
  const { instance, namespace } = target
  await frames.readMagic()
  const first = await frames.next()
  if (!first || first.type !== FRAME.HEADER) throw invalid('the stream has no header')
  const header = parseHeader(first.payload)
  const storage = parseIndexStorage(target.index, header.space.dimensions)

  const indexStorage = storage ?? DEFAULT_INDEX_STORAGE
  // Nothing is written until the first document or delete record commits, so
  // an import that fails before then leaves no namespace behind.
  const existing = await withSnapshot(instance, (reader) =>
    checkNamespace(reader, namespace, header)
  )
  let owned = existing !== null && sameLineage(existing.lineageId, header.lineageId)
  const planned = existing ?? newNamespace(namespace, header, indexStorage)
  const spaceRecord: SpaceRecord = { spaceId: header.spaceId, ...header.space }

  // Runs inside each write: creates or adopts the namespace on the first one.
  async function targetNamespace(tx: HyperDBTransaction): Promise<NamespaceRecord> {
    if (!owned) return await prepareNamespace(tx, namespace, header, indexStorage)
    const ns = await getNamespace(tx, namespace)
    checkTarget(ns, header)
    return ns
  }

  async function write(
    operation: (tx: HyperDBTransaction, ns: NamespaceRecord) => Promise<Outcome>
  ): Promise<Outcome | null> {
    // Checked once the lock is held, so an abort while waiting writes nothing.
    const outcome = await withTransaction(instance, async (tx) =>
      stop.stopped ? null : await operation(tx, await targetNamespace(tx))
    )
    if (outcome) owned = true
    return outcome
  }

  const documents: ImportedDocument[] = []
  const skipped: ImportSkip[] = []
  const seen = new Set<string>()
  const counts = { documents: 0, chunks: 0, tombstones: 0 }
  let revision = existing?.revision ?? 0

  function record(outcome: Outcome): void {
    revision = outcome.revision
    if ('document' in outcome) documents.push(outcome.document)
    if ('skip' in outcome) skipped.push(outcome.skip)
    onProgress?.({ documents: counts.documents, deletes: counts.tombstones })
  }

  try {
    return await apply()
  } catch (error) {
    if (error instanceof QvacErrorRAG && error.code === ERR_CODES.OPERATION_CANCELLED) {
      return { documents, skipped, cancelled: true, revision }
    }
    throw error
  }

  async function apply(): Promise<ImportResult> {
    for (;;) {
      const frame = await frames.next()
      if (!frame) throw invalid('the stream ends before its trailer')
      if (frame.type === FRAME.DOCUMENT) {
        const incoming = await readDocument(frame, frames, namespace, header, seen)
        counts.documents++
        counts.chunks += incoming.document.chunks.length
        checkIncoming(namespace, planned, spaceRecord, incoming)
        checkContentHash(header, incoming)
        const outcome = await write(async (tx, ns) => {
          // The namespace may have been created with other storage since the header.
          checkIncoming(namespace, ns, spaceRecord, incoming)
          return await applyDocument(tx, target, ns, incoming)
        })
        if (!outcome) return { documents, skipped, cancelled: true, revision }
        record(outcome)
      } else if (frame.type === FRAME.TOMBSTONE) {
        const tombstone = parse(tombstoneSchema, parseJson(frame.payload), 'delete record')
        if (header.checks && tombstone.check !== deleteCheck(tombstone.id, tombstone.generation)) {
          throw invalid(`delete record '${tombstone.id}' does not match its check`)
        }
        counts.tombstones++
        const outcome = await write((tx, ns) => applyTombstone(tx, target, ns, tombstone))
        if (!outcome) return { documents, skipped, cancelled: true, revision }
        record(outcome)
      } else if (frame.type === FRAME.TRAILER) {
        const trailer = parse(trailerSchema, parseJson(frame.payload), 'trailer')
        if (
          trailer.documents !== counts.documents ||
          trailer.chunks !== counts.chunks ||
          trailer.tombstones !== counts.tombstones
        ) {
          throw invalid(
            `the trailer counts ${JSON.stringify(trailer)}, the stream held ${JSON.stringify(counts)}`
          )
        }
        if (await frames.next()) throw invalid('the stream continues after its trailer')
        if (!owned) {
          // An export with nothing in it still creates or adopts the namespace,
          // unless the import was stopped while it waited for the lock.
          const ns = await withTransaction(instance, async (tx) => {
            if (stop.stopped) return null
            const prepared = await prepareNamespace(tx, namespace, header, indexStorage)
            await tx.flush()
            return prepared
          })
          if (!ns) return { documents, skipped, cancelled: true, revision }
          revision = ns.revision
        }
        return { documents, skipped, cancelled: false, revision }
      } else if (frame.type === FRAME.CHUNK) {
        throw invalid('a chunk frame outside a document')
      } else if (frame.type === FRAME.HEADER) {
        throw invalid('a second header')
      } else {
        throw invalid(`unknown frame type ${frame.type}`)
      }
    }
  }
}

function checkIncoming(
  namespace: string,
  ns: NamespaceRecord,
  space: SpaceRecord,
  incoming: IncomingDocument
): void {
  try {
    checkChunks(namespace, ns, space, incoming.document)
  } catch (error) {
    throw invalid(`document '${incoming.document.id}': ${(error as Error).message}`)
  }
}

function parseHeader(payload: Uint8Array): Header {
  const fields = parse(headerSchema, parseJson(payload), 'header')
  let space: EmbeddingSpace
  try {
    space = parseEmbeddingSpace(fields.space)
  } catch (error) {
    throw invalid(`header space: ${(error as Error).message}`)
  }
  if (computeSpaceId(space) !== fields.spaceId) {
    throw invalid(`the header space hashes to ${computeSpaceId(space)}, not ${fields.spaceId}`)
  }
  return {
    space,
    spaceId: fields.spaceId,
    lineageId: fromHex(fields.lineageId),
    checks: fields.checks === 1
  }
}

// Fails before anything is read past the header if the namespace can't take
// the export. Returns the existing namespace, or null when there is none.
async function checkNamespace(
  reader: HyperDBReader,
  namespace: string,
  header: Header
): Promise<NamespaceRecord | null> {
  const ns = await reader.get<NamespaceRecord>(NAMESPACES, { name: namespace })
  if (!ns) return null
  checkSpace(ns, header)
  if (!sameLineage(ns.lineageId, header.lineageId) && (await hasDocuments(reader, namespace))) {
    throw lineageMismatch(namespace)
  }
  return ns
}

function newNamespace(namespace: string, header: Header, storage: string): NamespaceRecord {
  return {
    name: namespace,
    spaceId: header.spaceId,
    revision: 0,
    nextNativeId: encodeNativeId(FIRST_NATIVE_ID),
    createdAt: newCreatedAt(),
    indexStorage: storage,
    lineageId: header.lineageId
  }
}

// Creates the namespace with the export's space and lineage, or checks an
// existing one. One without documents takes the export's lineage; its delete
// records belonged to the old lineage, so they go with it. Leaves the writes
// for the caller to flush.
async function prepareNamespace(
  tx: HyperDBTransaction,
  namespace: string,
  header: Header,
  storage: string
): Promise<NamespaceRecord> {
  const ns = await tx.get<NamespaceRecord>(NAMESPACES, { name: namespace })
  if (!ns) {
    if (!(await tx.get<SpaceRecord>(SPACES, { spaceId: header.spaceId }))) {
      await tx.insert(SPACES, { spaceId: header.spaceId, ...header.space })
    }
    const created = newNamespace(namespace, header, storage)
    await tx.insert(NAMESPACES, created)
    return created
  }

  checkSpace(ns, header)
  if (sameLineage(ns.lineageId, header.lineageId)) return ns
  if (await hasDocuments(tx, namespace)) throw lineageMismatch(namespace)
  const range = { gte: { namespace }, lte: { namespace } }
  for (const tombstone of await tx.find<TombstoneRecord>(TOMBSTONES, range).toArray()) {
    await tx.delete(TOMBSTONES, tombstone)
  }
  const adopted = { ...ns, lineageId: header.lineageId }
  await tx.insert(NAMESPACES, adopted)
  return adopted
}

async function hasDocuments(reader: HyperDBReader, namespace: string): Promise<boolean> {
  const range = { gte: { namespace }, lte: { namespace } }
  return (await reader.find(DOCUMENTS, range, { limit: 1 }).toArray()).length > 0
}

async function readDocument(
  frame: Frame,
  frames: FrameReader,
  namespace: string,
  header: Header,
  seen: Set<string>
): Promise<IncomingDocument> {
  const raw = parseJson(frame.payload) as { metadata?: unknown } | null
  if (hasProtoKey(raw?.metadata)) throw invalid(`a document's metadata has a '__proto__' key`)
  const fields = parse(documentSchema, raw, 'document')
  if (
    header.checks &&
    fields.check !==
      documentCheck(fields.id, fields.generation, fields.contentHash, fields.chunkCount)
  ) {
    throw invalid(`document '${fields.id}' does not match its check`)
  }
  if (seen.has(fields.id)) throw invalid(`document '${fields.id}' appears twice`)
  seen.add(fields.id)
  const metadata = fields.metadata && metadataProblem(fields.metadata)
  if (metadata) throw invalid(`document '${fields.id}' ${metadata}`)

  const dims = header.space.dimensions
  const chunkIds = new Set<string>()
  const chunks: ValidChunk[] = []
  for (let ordinal = 0; ordinal < fields.chunkCount; ordinal++) {
    const next = await frames.next()
    if (!next) throw invalid(`the stream ends inside document '${fields.id}'`)
    if (next.type !== FRAME.CHUNK) {
      throw invalid(`document '${fields.id}' has ${ordinal} chunks, expected ${fields.chunkCount}`)
    }
    const { fields: raw, vector } = splitChunkPayload(next.payload)
    const chunk = parse(chunkSchema, raw, `document '${fields.id}' chunk`)
    if (chunk.ordinal !== ordinal) {
      throw invalid(`document '${fields.id}' has chunk ${chunk.ordinal} where ${ordinal} belongs`)
    }
    if (chunkIds.has(chunk.chunkId)) {
      throw invalid(`document '${fields.id}' repeats chunk id '${chunk.chunkId}'`)
    }
    chunkIds.add(chunk.chunkId)
    if (vector.byteLength !== dims * 4) {
      throw invalid(
        `document '${fields.id}' chunk ${ordinal} has ${vector.byteLength} vector bytes, expected ${dims * 4}`
      )
    }
    const embedding = new Float32Array(dims)
    decodeVectorInto(vector, embedding, 0)
    if (!embedding.every(Number.isFinite)) {
      throw invalid(`document '${fields.id}' chunk ${ordinal} has a non-finite component`)
    }
    chunks.push({
      id: chunk.chunkId,
      content: chunk.content,
      metadataJson: chunk.metadataJson,
      embedding,
      spaceId: header.spaceId
    })
  }
  const size = rowSizeProblem(namespace, fields.id, fields.metadata, chunks, dims)
  if (size) throw invalid(size)
  return {
    document: { id: fields.id, metadata: fields.metadata, spaceId: header.spaceId, chunks },
    generation: fields.generation,
    contentHash: fields.contentHash
  }
}

// Ingest hashes vectors only when they were given, not when a port embedded
// the text, so either form matches.
function checkContentHash(header: Header, { document, contentHash }: IncomingDocument): void {
  const { id, metadata, chunks } = document
  const vectors = chunks.map((chunk) => chunk.embedding)
  if (
    contentHash !== hashContent(header.spaceId, metadata, chunks, vectors) &&
    contentHash !== hashContent(header.spaceId, metadata, chunks, [])
  ) {
    throw invalid(`document '${id}' does not match its content hash`)
  }
}

// The target keeps whatever is newer: a delete record at or past this
// generation, or a later generation, wins over the export.
async function applyDocument(
  tx: HyperDBTransaction,
  target: ImportTarget,
  ns: NamespaceRecord,
  { document, generation, contentHash }: IncomingDocument
): Promise<Outcome> {
  const { namespace } = target
  const key = { namespace, documentId: document.id }
  const current = await tx.get<DocumentRecord>(DOCUMENTS, key)
  // Flushes what creating or adopting the namespace wrote, if anything.
  async function skip(reason: ImportSkip['reason']): Promise<Outcome> {
    await tx.flush()
    return { skip: { id: document.id, generation, reason }, revision: ns.revision }
  }

  if (current) {
    if (current.generation > generation) return await skip('superseded')
    if (current.generation === generation) {
      if (current.contentHash !== contentHash) return await skip('conflict')
      await tx.flush()
      return {
        document: { id: document.id, generation, status: 'unchanged' },
        revision: ns.revision
      }
    }
  } else {
    const tombstone = await tx.get<TombstoneRecord>(TOMBSTONES, key)
    if (tombstone && tombstone.generation >= generation) return await skip('deleted')
    if (tombstone) await tx.delete(TOMBSTONES, key)
  }

  const { revision } = await writeGeneration(
    tx,
    target.indexes,
    ns,
    document,
    contentHash,
    generation,
    current
  )
  return {
    document: { id: document.id, generation, status: current ? 'replaced' : 'created' },
    revision
  }
}

// Deletes the target's document unless it holds a later generation, and keeps
// the record so an older export can't bring the document back.
async function applyTombstone(
  tx: HyperDBTransaction,
  target: ImportTarget,
  ns: NamespaceRecord,
  { id, generation }: { id: string; generation: number }
): Promise<Outcome> {
  const { namespace, indexes } = target
  const key = { namespace, documentId: id }
  const current = await tx.get<DocumentRecord>(DOCUMENTS, key)
  if (current) {
    if (current.generation > generation) {
      await tx.flush()
      return { skip: { id, generation, reason: 'superseded' }, revision: ns.revision }
    }
    const removed = await deleteDocument(tx, current, generation)
    const revision = await appendMutation(tx, ns, [], removed, ns.nextNativeId)
    await indexes.prune(tx, namespace)
    await tx.flush()
    await indexes.apply(namespace, revision, [], () => new Float32Array(0), removed)
    return { document: { id, generation, status: 'deleted' }, revision }
  }
  const known = await tx.get<TombstoneRecord>(TOMBSTONES, key)
  if (!known || known.generation < generation) {
    await tx.insert(TOMBSTONES, { namespace, documentId: id, generation, deletedAt: new Date() })
  }
  await tx.flush()
  return { revision: ns.revision }
}

// The namespace may have been dropped and re-created since the import began.
function checkTarget(ns: NamespaceRecord, header: Header): void {
  checkSpace(ns, header)
  if (!sameLineage(ns.lineageId, header.lineageId)) throw lineageMismatch(ns.name)
}

function checkSpace(ns: NamespaceRecord, header: Header): void {
  if (ns.spaceId !== header.spaceId) {
    throw new QvacErrorRAG({
      code: ERR_CODES.EMBEDDING_SPACE_MISMATCH,
      adds: `the export is in space ${header.spaceId}, namespace '${ns.name}' is in ${ns.spaceId}`
    })
  }
}

function lineageMismatch(namespace: string): QvacErrorRAG {
  return new QvacErrorRAG({
    code: ERR_CODES.IMPORT_LINEAGE_MISMATCH,
    adds: `namespace '${namespace}' holds documents from another lineage; ingest the exported chunks instead`
  })
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalid(`${what}: ${issue.path.join('.') || 'value'} ${issue.message}`)
  }
  return parsed.data
}
