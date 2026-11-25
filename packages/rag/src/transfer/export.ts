import {
  CHUNKS,
  DOCUMENTS,
  TOMBSTONES,
  type ChunkRecord,
  type DocumentRecord,
  type NamespaceRecord,
  type SpaceRecord,
  type TombstoneRecord
} from '../db/records.js'
import {
  FORMAT_VERSION,
  FORMAT_VERSION_ENCODED,
  FRAME,
  MAGIC,
  chunkFrame,
  jsonFrame
} from './frames.js'
import { encodingOf } from '../writes.js'
import type { HyperDBReader } from '../db/db-types.js'
import type { VectorEncoding } from '../types.js'

export interface ExportHeader {
  format: number
  namespace: string
  spaceId: string
  space: Omit<SpaceRecord, 'spaceId'>
  lineageId: string
  revision: number
  // Format 2 only; format 1 vectors are 'f32'.
  vectorEncoding?: VectorEncoding
}

// Yields one frame at a time from `reader`, so memory holds a single chunk;
// the consumer's pace is the backpressure. `check` runs before every frame.
export async function* exportFrames(
  reader: HyperDBReader,
  ns: NamespaceRecord,
  space: SpaceRecord,
  documentIds: string[] | undefined,
  check: () => void
): AsyncGenerator<Uint8Array> {
  const namespace = ns.name
  const { spaceId, ...fingerprint } = space
  const vectorEncoding = encodingOf(ns)
  const header: ExportHeader = {
    format: vectorEncoding === 'f32' ? FORMAT_VERSION : FORMAT_VERSION_ENCODED,
    namespace,
    spaceId,
    space: fingerprint,
    lineageId: toHex(ns.lineageId as Uint8Array),
    revision: ns.revision,
    ...(vectorEncoding === 'f32' ? {} : { vectorEncoding })
  }
  check()
  yield MAGIC.slice()
  check()
  yield jsonFrame(FRAME.HEADER, header)

  let documents = 0
  let chunks = 0
  for await (const document of selectDocuments(reader, namespace, documentIds)) {
    check()
    yield jsonFrame(
      FRAME.DOCUMENT,
      {
        id: document.documentId,
        generation: document.generation,
        contentHash: document.contentHash,
        ...(document.metadata ? { metadata: document.metadata } : {}),
        chunkCount: document.chunkCount
      },
      `document '${document.documentId}'`
    )
    documents++
    const key = { namespace, documentId: document.documentId, generation: document.generation }
    for await (const chunk of reader.find<ChunkRecord>(CHUNKS, { gte: key, lte: key })) {
      check()
      yield chunkFrame(
        {
          chunkId: chunk.chunkId,
          ordinal: chunk.ordinal,
          content: chunk.content,
          ...(chunk.metadataJson ? { metadataJson: chunk.metadataJson } : {})
        },
        chunk.vector,
        `chunk ${chunk.ordinal} of document '${document.documentId}'`
      )
      chunks++
    }
  }

  const wanted = documentIds && new Set(documentIds)
  let tombstones = 0
  const range = { gte: { namespace }, lte: { namespace } }
  for await (const tombstone of reader.find<TombstoneRecord>(TOMBSTONES, range)) {
    if (wanted && !wanted.has(tombstone.documentId)) continue
    check()
    yield jsonFrame(FRAME.TOMBSTONE, { id: tombstone.documentId, generation: tombstone.generation })
    tombstones++
  }

  check()
  yield jsonFrame(FRAME.TRAILER, { documents, chunks, tombstones })
}

async function* selectDocuments(
  reader: HyperDBReader,
  namespace: string,
  documentIds: string[] | undefined
): AsyncGenerator<DocumentRecord> {
  if (documentIds === undefined) {
    yield* reader.find<DocumentRecord>(DOCUMENTS, { gte: { namespace }, lte: { namespace } })
    return
  }
  for (const documentId of documentIds) {
    const document = await reader.get<DocumentRecord>(DOCUMENTS, { namespace, documentId })
    if (document) yield document
  }
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
