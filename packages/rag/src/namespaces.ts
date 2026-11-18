import { QvacErrorRAG, ERR_CODES } from './errors.js'
import {
  CHUNKS,
  DOCUMENTS,
  DROPPED_LINEAGES,
  MUTATIONS,
  NAMESPACES,
  NATIVE_IDS,
  SPACES,
  TOMBSTONES,
  type DocumentRecord,
  type NamespaceRecord,
  type SpaceRecord
} from './db/records.js'
import { getNamespace, storageOf } from './writes.js'
import type { HyperDBReader, HyperDBTransaction } from './db/db-types.js'
import type { DropNamespaceResult, EmbeddingMetric, NamespaceSummary } from './types.js'

const DELETE_BATCH = 1024

// Counts come from the document rows, so this reads one row per document.
export async function listNamespaceSummaries(reader: HyperDBReader): Promise<NamespaceSummary[]> {
  const summaries: NamespaceSummary[] = []
  for await (const ns of reader.find<NamespaceRecord>(NAMESPACES, {})) {
    const space = await reader.get<SpaceRecord>(SPACES, { spaceId: ns.spaceId })
    if (!space) {
      throw new QvacErrorRAG({
        code: ERR_CODES.DB_OPERATION_FAILED,
        adds: `embedding space ${ns.spaceId} of namespace '${ns.name}' is missing`
      })
    }
    let documentCount = 0
    let chunkCount = 0
    const range = { gte: { namespace: ns.name }, lte: { namespace: ns.name } }
    for await (const document of reader.find<DocumentRecord>(DOCUMENTS, range)) {
      documentCount++
      chunkCount += document.chunkCount
    }
    const { spaceId, ...fingerprint } = space
    summaries.push({
      name: ns.name,
      spaceId,
      space: { ...fingerprint, metric: fingerprint.metric as EmbeddingMetric },
      index: { storage: storageOf(ns) },
      revision: ns.revision,
      documentCount,
      chunkCount
    })
  }
  return summaries
}

// Deletes every row of the namespace in one batch, and records its lineage so
// an export taken before the drop can't be imported back. The space record
// stays; other namespaces may share it.
export async function dropNamespaceRows(
  tx: HyperDBTransaction,
  name: string
): Promise<DropNamespaceResult> {
  const ns = await getNamespace(tx, name)
  const range = { gte: { namespace: name }, lte: { namespace: name } }

  let documentCount = 0
  let chunkCount = 0
  await deleteAll<DocumentRecord>(tx, DOCUMENTS, range, (document) => {
    documentCount++
    chunkCount += document.chunkCount
  })
  for (const collection of [CHUNKS, NATIVE_IDS, TOMBSTONES, MUTATIONS]) {
    await deleteAll(tx, collection, range)
  }
  if (ns.lineageId) {
    await tx.insert(DROPPED_LINEAGES, {
      lineageId: ns.lineageId,
      namespace: name,
      droppedAt: new Date()
    })
  }
  await tx.delete(NAMESPACES, { name })
  await tx.flush()
  return { name, documentCount, chunkCount }
}

// Reads in bounded batches; rows deleted in this transaction drop out of the
// next find.
async function deleteAll<T extends object>(
  tx: HyperDBTransaction,
  collection: string,
  range: object,
  visit?: (row: T) => void
): Promise<void> {
  for (;;) {
    const rows = await tx.find<T>(collection, range, { limit: DELETE_BATCH }).toArray()
    if (rows.length === 0) return
    for (const row of rows) {
      visit?.(row)
      await tx.delete(collection, row)
    }
  }
}
