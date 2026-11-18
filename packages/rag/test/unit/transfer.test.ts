import test from 'brittle'
import { AbortController } from 'bare-abort-controller'

import { ERR_CODES, createRag } from '../../src/index.js'
import { NAMESPACES, type NamespaceRecord } from '../../src/db/records.js'
import { FRAME, jsonFrame } from '../../src/transfer/frames.js'
import { SPACE, doc, inspect, mutate, openRag, rejectsWithCode, type Test } from './helpers.js'
import type { EmbeddedDocumentInput, Rag } from '../../src/types.js'

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const part of stream) parts.push(part)
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

// Re-chunks the bytes, so frames straddle source chunks.
async function* source(bytes: Uint8Array, size = 7): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.slice(offset, offset + size)
  }
}

interface FrameSpan {
  type: number
  start: number
  end: number
}

function frames(bytes: Uint8Array): FrameSpan[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const spans: FrameSpan[] = []
  let offset = 8
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true)
    spans.push({ type: view.getUint8(offset + 4), start: offset, end: offset + 5 + length })
    offset += 5 + length
  }
  return spans
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function one(id: string, spaceId: string, content: string, x = 1): EmbeddedDocumentInput {
  return doc(id, spaceId, [[content, [x, 0, 0]]])
}

async function exportOf(rag: Rag, namespace = 'ns', documentIds?: string[]): Promise<Uint8Array> {
  return await collect(rag.exportNamespace({ namespace, documentIds }))
}

function load(rag: Rag, bytes: Uint8Array, namespace = 'ns') {
  return rag.importNamespace({ namespace, source: source(bytes) })
}

async function ids(rag: Rag, namespace = 'ns'): Promise<Array<[string, number]>> {
  const { documents } = await rag.listDocuments({ namespace })
  return documents.map((entry) => [entry.documentId, entry.generation])
}

async function openTarget(t: Test): Promise<Rag> {
  return (await openRag(t, [])).rag
}

test('an export imports into an empty RAG with the same content, generations and scores', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({
    namespace: 'ns',
    documents: [
      {
        id: 'a',
        metadata: { title: 'Ä manual' },
        chunks: [
          { content: 'first ✓', embedding: [1, 0.5, 0], spaceId, metadataJson: '{"page":1}' },
          { id: 'custom', content: 'second', embedding: [0, 1, 0], spaceId }
        ]
      },
      one('b', spaceId, 'b'),
      one('gone', spaceId, 'gone')
    ]
  })
  await from.ingest({ namespace: 'ns', documents: [one('b', spaceId, 'b again', 0.5)] })
  await from.deleteDocuments({ namespace: 'ns', documentIds: ['gone'] })
  const bytes = await exportOf(from)

  const to = await openTarget(t)
  const progress: unknown[] = []
  const result = await to.importNamespace(
    { namespace: 'copy', source: source(bytes) },
    { onProgress: (p) => progress.push(p) }
  )
  t.alike(result.documents, [
    { id: 'a', generation: 1, status: 'created' },
    { id: 'b', generation: 2, status: 'created' }
  ])
  t.alike(result.skipped, [])
  t.is(result.cancelled, false)
  t.alike(progress.at(-1), { documents: 2, deletes: 1 })

  const original = await from.readDocument({ namespace: 'ns', documentId: 'a' })
  const copied = await to.readDocument({ namespace: 'copy', documentId: 'a' })
  t.alike({ ...copied, namespace: 'ns' }, original, 'chunks, IDs, metadata and generation')

  const query = { vector: [1, 1, 0], spaceId, k: 5 }
  const before = await from.search({ ...query, scope: { namespace: 'ns' } })
  const after = await to.search({ ...query, scope: { namespace: 'copy' } })
  t.alike(
    after.map((hit) => [hit.chunkId, hit.score]),
    before.map((hit) => [hit.chunkId, hit.score]),
    'same vectors, same scores'
  )

  // The delete record came along: an older 'gone' can't be imported later.
  await rejectsWithCode(
    t,
    to.readDocument({ namespace: 'copy', documentId: 'gone' }),
    ERR_CODES.DOCUMENT_OUT_OF_SCOPE,
    'deleted documents stay deleted'
  )

  const again = await to.importNamespace({ namespace: 'copy', source: source(bytes, 64) })
  t.alike(
    again.documents.map((entry) => entry.status),
    ['unchanged', 'unchanged'],
    're-importing the same export writes nothing'
  )
  t.is(again.revision, result.revision)
})

test('import applies each row of the generation table', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({
    namespace: 'ns',
    documents: [one('a', spaceId, 'a1'), one('b', spaceId, 'b1'), one('c', spaceId, 'c1')]
  })
  const v1 = await exportOf(from)
  const to = await openTarget(t)
  await load(to, v1)

  // current generation < exported: replace
  await from.ingest({ namespace: 'ns', documents: [one('a', spaceId, 'a2')] })
  const v2 = await exportOf(from, 'ns', ['a'])
  const replaced = await load(to, v2)
  t.alike(replaced.documents, [{ id: 'a', generation: 2, status: 'replaced' }])

  // current generation > exported: superseded
  const stale = await load(to, v1)
  t.alike(stale.skipped, [{ id: 'a', generation: 1, reason: 'superseded' }])
  t.alike(
    stale.documents.map((entry) => [entry.id, entry.status]),
    [
      ['b', 'unchanged'],
      ['c', 'unchanged']
    ]
  )

  // same generation, different content: conflict
  await to.ingest({ namespace: 'ns', documents: [one('b', spaceId, 'b2 local')] })
  await from.ingest({ namespace: 'ns', documents: [one('b', spaceId, 'b2 remote')] })
  const conflict = await load(to, await exportOf(from, 'ns', ['b']))
  t.alike(conflict.skipped, [{ id: 'b', generation: 2, reason: 'conflict' }])
  const kept = await to.readDocument({ namespace: 'ns', documentId: 'b' })
  t.is(kept.chunks[0].content, 'b2 local', 'the target keeps its own write')

  // target deleted that generation or later: deleted
  await to.deleteDocuments({ namespace: 'ns', documentIds: ['c'] })
  const deleted = await load(to, v1)
  t.ok(deleted.skipped.some((skip) => skip.id === 'c' && skip.reason === 'deleted'))

  // a delete record removes the target's copy, and an older export can't revive it
  const fresh = await openTarget(t)
  await load(fresh, v1)
  await from.deleteDocuments({ namespace: 'ns', documentIds: ['c'] })
  const withDelete = await load(fresh, await exportOf(from, 'ns', ['c']))
  t.alike(withDelete.documents, [{ id: 'c', generation: 1, status: 'deleted' }])
  const revived = await load(fresh, v1)
  t.alike(revived.skipped, [{ id: 'c', generation: 1, reason: 'deleted' }])
  t.alike(await ids(fresh), [
    ['a', 1],
    ['b', 1]
  ])

  // a delete record older than the target's document: superseded
  await fresh.ingest({ namespace: 'ns', documents: [one('c', spaceId, 'c back')] })
  const late = await load(fresh, await exportOf(from, 'ns', ['c']))
  t.alike(late.skipped, [{ id: 'c', generation: 1, reason: 'superseded' }])
  t.alike(await ids(fresh), [
    ['a', 1],
    ['b', 1],
    ['c', 2]
  ])
})

test('import refuses another space or lineage before writing anything', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({ namespace: 'ns', documents: [one('a', spaceId, 'a')] })
  const bytes = await exportOf(from)

  const { rag: to, spaceId: targetSpace } = await openRag(t, [])
  await to.createNamespace({ name: 'other-space', space: { ...SPACE, model: 'another' } })
  await rejectsWithCode(
    t,
    load(to, bytes, 'other-space'),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'another space'
  )
  const [summary] = await to.listNamespaces()
  t.is(summary.revision, 0, 'nothing written')
  t.is(summary.documentCount, 0)

  await to.createNamespace({ name: 'unrelated', space: SPACE })
  await to.ingest({ namespace: 'unrelated', documents: [one('x', spaceId, 'x')] })
  await rejectsWithCode(
    t,
    load(to, bytes, 'unrelated'),
    ERR_CODES.IMPORT_LINEAGE_MISMATCH,
    'a namespace with its own documents'
  )
  t.alike(await ids(to, 'unrelated'), [['x', 1]])

  await to.createNamespace({ name: 'empty', space: SPACE })
  const adopted = await load(to, bytes, 'empty')
  t.alike(
    adopted.documents.map((entry) => entry.status),
    ['created'],
    'an empty namespace takes the lineage'
  )
  t.is(targetSpace, '', 'the target opened with no namespace')
})

test('a truncated stream fails with IMPORT_INVALID and never commits a partial document', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({
    namespace: 'ns',
    documents: [
      one('a', spaceId, 'a'),
      doc('b', spaceId, [
        ['b0', [1, 0, 0]],
        ['b1', [0, 1, 0]]
      ])
    ]
  })
  const bytes = await exportOf(from)
  const spans = frames(bytes)
  const header = spans[0]
  const bChunk = spans.filter((span) => span.type === FRAME.CHUNK)[1]
  const trailer = spans[spans.length - 1]
  t.is(trailer.type, FRAME.TRAILER)

  const to = await openTarget(t)
  await rejectsWithCode(
    t,
    load(to, bytes.slice(0, header.end - 3), 'cut-header'),
    ERR_CODES.IMPORT_INVALID,
    'cut in the header'
  )
  t.alike(await to.listNamespaces(), [], 'no namespace before the header is read')

  await rejectsWithCode(
    t,
    load(to, bytes.slice(0, bChunk.end), 'cut-document'),
    ERR_CODES.IMPORT_INVALID,
    'cut inside a document',
    /inside document 'b'/
  )
  t.alike(await ids(to, 'cut-document'), [['a', 1]], 'earlier documents stay, b is not partial')

  await rejectsWithCode(
    t,
    load(to, bytes.slice(0, trailer.start), 'no-trailer'),
    ERR_CODES.IMPORT_INVALID,
    'missing trailer',
    /before its trailer/
  )
  t.is((await ids(to, 'no-trailer')).length, 2, 'complete documents stay committed')

  await rejectsWithCode(
    t,
    load(to, bytes.slice(0, trailer.end - 1), 'cut-trailer'),
    ERR_CODES.IMPORT_INVALID,
    'cut inside the trailer'
  )
})

test('a corrupt stream fails with IMPORT_INVALID', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({ namespace: 'ns', documents: [one('a', spaceId, 'a')] })
  const bytes = await exportOf(from)
  const spans = frames(bytes)
  const to = await openTarget(t)
  const fails = (name: string, corrupt: Uint8Array, pattern?: RegExp) =>
    rejectsWithCode(t, load(to, corrupt, name), ERR_CODES.IMPORT_INVALID, name, pattern)

  const badMagic = bytes.slice()
  badMagic[0] = 0
  await fails('bad-magic', badMagic, /not a QVRAGX1 stream/)

  const huge = bytes.slice()
  new DataView(huge.buffer).setUint32(spans[1].start, 0xffffffff, true)
  await fails('huge-frame', huge, /byte limit/)

  const header = JSON.parse(
    String.fromCharCode(...bytes.subarray(spans[0].start + 5, spans[0].end))
  ) as { spaceId: string }
  const forged = concat(
    bytes.subarray(0, 8),
    jsonFrame(FRAME.HEADER, { ...header, spaceId: 'f'.repeat(64) }),
    bytes.subarray(spans[0].end)
  )
  await fails('forged-space', forged, /hashes to/)
  t.absent(
    (await to.listNamespaces()).some((ns) => ns.name === 'forged-space'),
    'header checks run before any write'
  )

  const chunk = spans.find((span) => span.type === FRAME.CHUNK) as FrameSpan
  const nan = bytes.slice()
  new DataView(nan.buffer).setFloat32(chunk.end - 4, Number.NaN, true)
  await fails('nan-vector', nan, /non-finite/)

  const trailer = spans[spans.length - 1]
  const wrongCount = concat(
    bytes.subarray(0, trailer.start),
    jsonFrame(FRAME.TRAILER, { documents: 2, chunks: 1, tombstones: 0 })
  )
  await fails('wrong-count', wrongCount, /trailer counts/)
  await fails('trailing-data', concat(bytes, new Uint8Array([1, 2, 3])))
  await fails('unknown-frame', concat(bytes.subarray(0, trailer.start), jsonFrame(9, {})))
})

test('export takes a document subset, honours its signal and ends on close', async (t) => {
  const { rag, store, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [one('a', spaceId, 'a'), one('b', spaceId, 'b'), one('c', spaceId, 'c')]
  })
  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['c'] })

  const subset = frames(await exportOf(rag, 'ns', ['b', 'c', 'missing']))
  t.alike(
    subset.map((span) => span.type),
    [FRAME.HEADER, FRAME.DOCUMENT, FRAME.CHUNK, FRAME.TOMBSTONE, FRAME.TRAILER],
    'only b and the delete record of c'
  )

  await rejectsWithCode(
    t,
    () => rag.exportNamespace({ namespace: 'ns', vectors: true } as never),
    ERR_CODES.INVALID_INPUT,
    'bad input throws at the call'
  )

  const controller = new AbortController()
  const aborted = rag.exportNamespace(
    { namespace: 'ns' },
    { signal: controller.signal as AbortSignal }
  )
  const iterator = aborted[Symbol.asyncIterator]()
  await iterator.next()
  controller.abort(new Error('stop'))
  await rejectsWithCode(t, iterator.next(), ERR_CODES.OPERATION_CANCELLED, 'abort mid-export')

  const pending = rag.exportNamespace({ namespace: 'ns' })[Symbol.asyncIterator]()
  await pending.next()
  await rag.close()
  await rejectsWithCode(t, pending.next(), ERR_CODES.NOT_READY, 'close ends an open export')

  // A namespace from before lineages gets one when first exported.
  await mutate(store, async (tx) => {
    const ns = await tx.get<NamespaceRecord>(NAMESPACES, { name: 'ns' })
    const { lineageId, ...legacy } = ns!
    t.ok(lineageId)
    await tx.insert(NAMESPACES, legacy)
  })
  const reopened = createRag({ corestore: store })
  await reopened.ready()
  t.teardown(() => reopened.close())
  await collect(reopened.exportNamespace({ namespace: 'ns' }))
  await reopened.close()
  const ns = await inspect(store, (reader) =>
    reader.get<NamespaceRecord>(NAMESPACES, { name: 'ns' })
  )
  t.is(ns!.lineageId!.byteLength, 16)
})

test('an aborted import stops before the next document', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({
    namespace: 'ns',
    documents: [one('a', spaceId, 'a'), one('b', spaceId, 'b')]
  })
  const bytes = await exportOf(from)
  const to = await openTarget(t)
  const controller = new AbortController()
  const result = await to.importNamespace(
    { namespace: 'ns', source: source(bytes) },
    {
      signal: controller.signal as AbortSignal,
      onProgress: () => controller.abort(new Error('stop'))
    }
  )
  t.is(result.cancelled, true)
  t.alike(
    result.documents.map((entry) => entry.id),
    ['a']
  )
  t.alike(await ids(to), [['a', 1]])
})
