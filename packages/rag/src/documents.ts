import { QvacErrorRAG, ERR_CODES } from './errors.js'
import { CHUNKS, DOCUMENTS, type ChunkRecord, type DocumentRecord } from './db/records.js'
import type { HyperDBReader } from './db/db-types.js'
import type { ValidList, ValidRead } from './input.js'
import type { DocumentChunk, DocumentListPage, DocumentPage, DocumentSummary } from './types.js'

// One page of one generation, read from a single snapshot. Vectors stay out.
export async function readDocumentPage(
  reader: HyperDBReader,
  namespace: string,
  request: ValidRead
): Promise<DocumentPage> {
  const { documentId, generation, fromOrdinal, limit } = request
  const document = await reader.get<DocumentRecord>(DOCUMENTS, { namespace, documentId })
  if (!document) {
    if (generation !== undefined) {
      throw changed(`'${documentId}' in '${namespace}' was deleted`)
    }
    throw outOfScope(namespace, documentId)
  }
  if (generation !== undefined && generation !== document.generation) {
    throw changed(
      `'${documentId}' in '${namespace}' is at generation ${document.generation}, not ${generation}`
    )
  }

  const end = Math.min(document.chunkCount, fromOrdinal + limit)
  const chunks: DocumentChunk[] = []
  if (fromOrdinal < end) {
    const key = { namespace, documentId, generation: document.generation }
    const range = { gte: { ...key, ordinal: fromOrdinal }, lt: { ...key, ordinal: end } }
    for await (const chunk of reader.find<ChunkRecord>(CHUNKS, range)) {
      chunks.push({
        chunkId: chunk.chunkId,
        ordinal: chunk.ordinal,
        content: chunk.content,
        ...(chunk.metadataJson ? { metadataJson: chunk.metadataJson } : {})
      })
    }
  }
  return {
    namespace,
    documentId,
    generation: document.generation,
    chunkCount: document.chunkCount,
    ...(document.metadata ? { metadata: document.metadata } : {}),
    chunks,
    nextOrdinal: end < document.chunkCount ? end : null
  }
}

// Without `documentIds`, every document in the namespace, in key order. With
// them, only those that exist, in the same order, so a bound handle never
// learns about the rest.
export async function listDocumentPage(
  reader: HyperDBReader,
  namespace: string,
  request: ValidList,
  documentIds?: string[]
): Promise<DocumentListPage> {
  const { after, limit } = request
  const found: DocumentRecord[] = []
  if (documentIds === undefined) {
    const range =
      after === undefined
        ? { gte: { namespace }, lte: { namespace } }
        : { gt: { namespace, documentId: after }, lte: { namespace } }
    for await (const document of reader.find<DocumentRecord>(DOCUMENTS, range, {
      limit: limit + 1
    })) {
      found.push(document)
    }
  } else {
    const ids = Array.from(new Set(documentIds))
      .filter((id) => after === undefined || compareKeys(id, after) > 0)
      .sort(compareKeys)
    for (const documentId of ids) {
      if (found.length > limit) break
      const document = await reader.get<DocumentRecord>(DOCUMENTS, { namespace, documentId })
      if (document) found.push(document)
    }
  }

  const page = found.slice(0, limit)
  return {
    documents: page.map(toSummary),
    next: found.length > limit ? page[page.length - 1].documentId : null
  }
}

function toSummary(document: DocumentRecord): DocumentSummary {
  return {
    documentId: document.documentId,
    generation: document.generation,
    chunkCount: document.chunkCount,
    revision: document.revision ?? 0,
    ...(document.metadata ? { metadata: document.metadata } : {})
  }
}

// Code point order, which is the UTF-8 byte order HyperDB sorts keys in.
function compareKeys(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0)
    if (diff !== 0) return diff
  }
  return left.length - right.length
}

// Same code and message as a document the namespace doesn't have, so a scoped
// handle can't tell an ungranted document from a missing one.
export function outOfScope(namespace: string, documentId: string): QvacErrorRAG {
  return new QvacErrorRAG({
    code: ERR_CODES.DOCUMENT_OUT_OF_SCOPE,
    adds: `'${documentId}' in '${namespace}'`
  })
}

function changed(message: string): QvacErrorRAG {
  return new QvacErrorRAG({ code: ERR_CODES.DOCUMENT_CHANGED, adds: message })
}
