import { z } from 'zod'

import { QvacErrorRAG, ERR_CODES } from '../errors.js'
import { FIRST_NATIVE_ID, decodeVectorInto, encodeNativeId } from '../db/encoding.js'
import {
  DOCUMENTS,
  DROPPED_LINEAGES,
  NAMESPACES,
  SPACES,
  TOMBSTONES,
  type DocumentRecord,
  type DroppedLineageRecord,
  type NamespaceRecord,
  type SpaceRecord,
  type TombstoneRecord
} from '../db/records.js'
import { computeSpaceId, parseEmbeddingSpace } from '../space.js'
import { parseIndexStorage } from '../vector-index/options.js'
import { DEFAULT_INDEX_STORAGE, type IndexRegistry } from '../vector-index/registry.js'
import {
  appendMutation,
  checkChunks,
  deleteDocument,
  getNamespace,
  withTransaction,
  writeGeneration
} from '../writes.js'
import { fromHex, toHex } from './export.js'
import {
  FORMAT_VERSION,
  FRAME,
  createFrameReader,
  invalid,
  parseJson,
  splitChunkPayload,
  type Frame,
  type FrameReader
} from './frames.js'
import type { ValidChunk, ValidDocument } from '../input.js'
import type { HyperDBInstance, HyperDBTransaction } from '../db/db-types.js'
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
}

interface Header {
  space: EmbeddingSpace
  spaceId: string
  lineageId: Uint8Array
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
  revision: z.number().int().nonnegative()
})

const documentSchema = z.object({
  id: z.string().min(1),
  generation: z.number().int().positive(),
  contentHash: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  chunkCount: z.number().int().positive()
})

const chunkSchema = z.object({
  chunkId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  content: z.string(),
  metadataJson: z.string().min(1).optional()
})

const tombstoneSchema = z.object({
  id: z.string().min(1),
  generation: z.number().int().positive()
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
export async function importStream(
  target: ImportTarget,
  source: AsyncIterable<Uint8Array>,
  options: ImportOptions
): Promise<ImportResult> {
  const frames = createFrameReader(source)
  try {
    return await run(target, frames, options)
  } finally {
    await frames.close().catch(() => {})
  }
}

async function run(
  target: ImportTarget,
  frames: FrameReader,
  { signal, onProgress }: ImportOptions
): Promise<ImportResult> {
  const { instance, namespace } = target
  await frames.readMagic()
  const first = await frames.next()
  if (!first || first.type !== FRAME.HEADER) throw invalid('the stream has no header')
  const header = parseHeader(first.payload)
  const storage = parseIndexStorage(target.index, header.space.dimensions)

  const prepared = await withTransaction(instance, (tx) =>
    prepareNamespace(tx, namespace, header, storage ?? DEFAULT_INDEX_STORAGE)
  )
  const spaceRecord: SpaceRecord = { spaceId: header.spaceId, ...header.space }

  const documents: ImportedDocument[] = []
  const skipped: ImportSkip[] = []
  const seen = new Set<string>()
  const counts = { documents: 0, chunks: 0, tombstones: 0 }
  let revision = prepared.revision

  function record(outcome: Outcome): void {
    revision = outcome.revision
    if ('document' in outcome) documents.push(outcome.document)
    if ('skip' in outcome) skipped.push(outcome.skip)
    onProgress?.({ documents: counts.documents, deletes: counts.tombstones })
  }

  for (;;) {
    const frame = await frames.next()
    if (!frame) throw invalid('the stream ends before its trailer')
    if (frame.type === FRAME.DOCUMENT) {
      const incoming = await readDocument(frame, frames, header, seen)
      counts.documents++
      counts.chunks += incoming.document.chunks.length
      try {
        checkChunks(namespace, prepared, spaceRecord, incoming.document)
      } catch (error) {
        throw invalid(`document '${incoming.document.id}': ${(error as Error).message}`)
      }
      if (signal?.aborted) return { documents, skipped, cancelled: true, revision }
      record(await withTransaction(instance, (tx) => applyDocument(tx, target, header, incoming)))
    } else if (frame.type === FRAME.TOMBSTONE) {
      const tombstone = parse(tombstoneSchema, parseJson(frame.payload), 'delete record')
      counts.tombstones++
      if (signal?.aborted) return { documents, skipped, cancelled: true, revision }
      record(await withTransaction(instance, (tx) => applyTombstone(tx, target, header, tombstone)))
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
  return { space, spaceId: fields.spaceId, lineageId: fromHex(fields.lineageId) }
}

// Creates the namespace with the export's space and lineage, or checks an
// existing one. An empty namespace from another lineage takes the export's.
async function prepareNamespace(
  tx: HyperDBTransaction,
  namespace: string,
  header: Header,
  storage: string
): Promise<NamespaceRecord> {
  const dropped = await tx.get<DroppedLineageRecord>(DROPPED_LINEAGES, {
    lineageId: header.lineageId
  })
  if (dropped) {
    throw new QvacErrorRAG({
      code: ERR_CODES.IMPORT_LINEAGE_MISMATCH,
      adds: `the export is from namespace '${dropped.namespace}', which was dropped`
    })
  }

  const ns = await tx.get<NamespaceRecord>(NAMESPACES, { name: namespace })
  if (!ns) {
    if (!(await tx.get<SpaceRecord>(SPACES, { spaceId: header.spaceId }))) {
      await tx.insert(SPACES, { spaceId: header.spaceId, ...header.space })
    }
    const created: NamespaceRecord = {
      name: namespace,
      spaceId: header.spaceId,
      revision: 0,
      nextNativeId: encodeNativeId(FIRST_NATIVE_ID),
      createdAt: new Date(),
      indexStorage: storage,
      lineageId: header.lineageId
    }
    await tx.insert(NAMESPACES, created)
    await tx.flush()
    return created
  }

  checkSpace(ns, header)
  if (sameBytes(ns.lineageId, header.lineageId)) return ns
  const range = { gte: { namespace }, lte: { namespace } }
  const hasDocuments = (await tx.find(DOCUMENTS, range, { limit: 1 }).toArray()).length > 0
  const hasTombstones = (await tx.find(TOMBSTONES, range, { limit: 1 }).toArray()).length > 0
  if (hasDocuments || hasTombstones) throw lineageMismatch(namespace)
  const adopted = { ...ns, lineageId: header.lineageId }
  await tx.insert(NAMESPACES, adopted)
  await tx.flush()
  return adopted
}

async function readDocument(
  frame: Frame,
  frames: FrameReader,
  header: Header,
  seen: Set<string>
): Promise<IncomingDocument> {
  const fields = parse(documentSchema, parseJson(frame.payload), 'document')
  if (seen.has(fields.id)) throw invalid(`document '${fields.id}' appears twice`)
  seen.add(fields.id)

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
  return {
    document: { id: fields.id, metadata: fields.metadata, chunks },
    generation: fields.generation,
    contentHash: fields.contentHash
  }
}

// The target keeps whatever is newer: a delete record at or past this
// generation, or a later generation, wins over the export.
async function applyDocument(
  tx: HyperDBTransaction,
  target: ImportTarget,
  header: Header,
  { document, generation, contentHash }: IncomingDocument
): Promise<Outcome> {
  const { namespace } = target
  const ns = await getNamespace(tx, namespace)
  checkTarget(ns, header)
  const key = { namespace, documentId: document.id }
  const current = await tx.get<DocumentRecord>(DOCUMENTS, key)
  const skip = (reason: ImportSkip['reason']): Outcome => ({
    skip: { id: document.id, generation, reason },
    revision: ns.revision
  })

  if (current) {
    if (current.generation > generation) return skip('superseded')
    if (current.generation === generation) {
      if (current.contentHash !== contentHash) return skip('conflict')
      return {
        document: { id: document.id, generation, status: 'unchanged' },
        revision: ns.revision
      }
    }
  } else {
    const tombstone = await tx.get<TombstoneRecord>(TOMBSTONES, key)
    if (tombstone && tombstone.generation >= generation) return skip('deleted')
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
  header: Header,
  { id, generation }: { id: string; generation: number }
): Promise<Outcome> {
  const { namespace, indexes } = target
  const ns = await getNamespace(tx, namespace)
  checkTarget(ns, header)
  const key = { namespace, documentId: id }
  const current = await tx.get<DocumentRecord>(DOCUMENTS, key)
  if (current) {
    if (current.generation > generation) {
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
    await tx.flush()
  }
  return { revision: ns.revision }
}

// The namespace may have been dropped and re-created since the import began.
function checkTarget(ns: NamespaceRecord, header: Header): void {
  checkSpace(ns, header)
  if (!sameBytes(ns.lineageId, header.lineageId)) throw lineageMismatch(ns.name)
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

function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array): boolean {
  return !!a && a.byteLength === b.byteLength && toHex(a) === toHex(b)
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalid(`${what}: ${issue.path.join('.') || 'value'} ${issue.message}`)
  }
  return parsed.data
}
