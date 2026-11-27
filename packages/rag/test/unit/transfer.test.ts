import test from 'brittle'
import { AbortController } from 'bare-abort-controller'

import tmp from 'test-tmp'
import Corestore from 'corestore'

import { ERR_CODES, QvacErrorRAG, createRag } from '../../src/index.js'
import { NAMESPACES, type NamespaceRecord } from '../../src/db/records.js'
import { MAX_GENERATION, MAX_ROW_BYTES } from '../../src/limits.js'
import { deleteCheck, documentCheck } from '../../src/transfer/export.js'
import { FRAME, MAGIC, chunkFrame, jsonFrame } from '../../src/transfer/frames.js'
import { hashContent } from '../../src/writes.js'
import {
  SPACE,
  delay,
  doc,
  inspect,
  mutate,
  openRag,
  realNativeIndex,
  rejectsWithCode,
  type Test
} from './helpers.js'
import type { EmbeddedDocumentInput, IndexProvider, Rag } from '../../src/types.js'

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

  const text = bytes.slice()
  const marker = Array.from('"content":"', (char) => char.charCodeAt(0))
  let at = chunk.start
  while (!marker.every((byte, i) => text[at + i] === byte)) at++
  text[at + marker.length] ^= 1
  await fails('tampered-text', text, /content hash/)

  const vector = bytes.slice()
  new DataView(vector.buffer).setFloat32(chunk.end - 4, 0.5, true)
  await fails('tampered-vector', vector, /content hash/)
  t.absent(
    (await to.listNamespaces()).find((ns) => ns.name === 'tampered-text')?.documentCount,
    'a document that fails its hash is not committed'
  )

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

// Sends `bytes`, then never sends again. `stalled` resolves once the importer
// asks for more.
function stalls(bytes: Uint8Array): {
  source: AsyncIterable<Uint8Array>
  stalled: Promise<void>
} {
  let reached = () => {}
  const stalled = new Promise<void>((resolve) => {
    reached = resolve
  })
  async function* source(): AsyncGenerator<Uint8Array> {
    yield bytes
    reached()
    await new Promise(() => {})
  }
  return { source: source(), stalled }
}

test('an abort or close ends an import whose source stops sending', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({
    namespace: 'ns',
    documents: [one('a', spaceId, 'a'), one('b', spaceId, 'b')]
  })
  const bytes = await exportOf(from)
  const spans = frames(bytes)
  const to = await openTarget(t)

  const afterFirst = stalls(bytes.subarray(0, spans[2].end))
  const controller = new AbortController()
  const aborted = to.importNamespace(
    { namespace: 'ns', source: afterFirst.source },
    { signal: controller.signal as AbortSignal }
  )
  await afterFirst.stalled
  controller.abort(new Error('stop'))
  const result = await aborted
  t.is(result.cancelled, true, 'abort while waiting on the source')
  t.alike(
    result.documents.map((entry) => entry.id),
    ['a']
  )

  const beforeHeader = stalls(MAGIC)
  const early = new AbortController()
  const rejected = to.importNamespace(
    { namespace: 'other', source: beforeHeader.source },
    { signal: early.signal as AbortSignal }
  )
  await beforeHeader.stalled
  early.abort(new Error('stop'))
  await rejectsWithCode(t, rejected, ERR_CODES.OPERATION_CANCELLED, 'abort before the header')

  const own = new AbortController()
  async function* abortsItself(): AsyncGenerator<Uint8Array> {
    yield bytes.subarray(0, spans[2].end)
    own.abort(new Error('stop'))
    await new Promise(() => {})
  }
  const selfAborted = await to.importNamespace(
    { namespace: 'self', source: abortsItself() },
    { signal: own.signal as AbortSignal }
  )
  t.is(selfAborted.cancelled, true, 'an abort raised by the source itself')

  const afterHeader = stalls(bytes.subarray(0, spans[0].end))
  const pending = to.importNamespace({ namespace: 'ns', source: afterHeader.source })
  await afterHeader.stalled
  await to.close()
  t.is((await pending).cancelled, true, 'close() returns and ends the import')
})

test('an export read one byte at a time imports', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({
    namespace: 'ns',
    documents: [one('a', spaceId, 'alpha'), one('b', spaceId, 'b')]
  })
  const bytes = await exportOf(from)
  const to = await openTarget(t)
  const result = await to.importNamespace({ namespace: 'ns', source: source(bytes, 1) })
  t.is(result.cancelled, false)
  t.alike(await ids(to), [
    ['a', 1],
    ['b', 1]
  ])
})

function jsonOf(bytes: Uint8Array, span: FrameSpan): Record<string, unknown> {
  return JSON.parse(String.fromCharCode(...bytes.subarray(span.start + 5, span.end))) as Record<
    string,
    unknown
  >
}

// A stream with the header of `bytes` and the given frames after it.
function withHeader(bytes: Uint8Array, ...rest: Uint8Array[]): Uint8Array {
  return concat(bytes.subarray(0, frames(bytes)[0].end), ...rest)
}

function documentFrame(id: string, generation: number, contentHash: string, chunkCount: number) {
  const check = documentCheck(id, generation, contentHash, chunkCount)
  return jsonFrame(FRAME.DOCUMENT, { id, generation, contentHash, chunkCount, check })
}

function vectorBytes(values: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer)
}

async function namespaceNames(rag: Rag): Promise<string[]> {
  return (await rag.listNamespaces()).map((ns) => ns.name)
}

test('import checks document IDs and delete records', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({
    namespace: 'ns',
    documents: [one('a', spaceId, 'a'), one('b', spaceId, 'b'), one('c', spaceId, 'c')]
  })
  await from.deleteDocuments({ namespace: 'ns', documentIds: ['c'] })
  const bytes = await exportOf(from)
  const spans = frames(bytes)
  const [header, docA] = spans
  const tombstone = spans.find((span) => span.type === FRAME.TOMBSTONE) as FrameSpan
  const idAt = (span: FrameSpan) => span.start + 5 + '{"id":"'.length
  const to = await openTarget(t)

  const renamed = bytes.slice()
  renamed[idAt(docA)] = 'z'.charCodeAt(0)
  await rejectsWithCode(t, load(to, renamed, 'renamed'), ERR_CODES.IMPORT_INVALID, 'id', /check/)
  t.absent((await namespaceNames(to)).includes('renamed'), 'nothing was written')

  await load(to, bytes)
  const wrongDelete = bytes.slice()
  wrongDelete[idAt(tombstone)] = 'b'.charCodeAt(0)
  await rejectsWithCode(t, load(to, wrongDelete), ERR_CODES.IMPORT_INVALID, 'delete', /check/)
  t.alike(await ids(to), [
    ['a', 1],
    ['b', 1]
  ])

  // 0.11.0 exports carry no checks and still import.
  const { checks: _checks, ...legacyHeader } = jsonOf(bytes, header)
  const legacy = [MAGIC, jsonFrame(FRAME.HEADER, legacyHeader)]
  for (const span of spans.slice(1)) {
    if (span.type === FRAME.DOCUMENT || span.type === FRAME.TOMBSTONE) {
      const { check: _check, ...fields } = jsonOf(bytes, span)
      legacy.push(jsonFrame(span.type, fields))
    } else {
      legacy.push(bytes.subarray(span.start, span.end))
    }
  }
  await load(to, concat(...legacy), 'legacy')
  t.alike(await ids(to, 'legacy'), [
    ['a', 1],
    ['b', 1]
  ])
})

test('import rejects generations past the cap, lone surrogates and oversized rows', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({ namespace: 'ns', documents: [one('a', spaceId, 'a')] })
  const bytes = await exportOf(from)
  const to = await openTarget(t)
  const chunk = (id: string, content: string) =>
    chunkFrame({ chunkId: `${id}:0`, ordinal: 0, content }, vectorBytes([1, 0, 0]))
  const single = (id: string, content: string, generation = 1) => {
    const hash = hashContent(spaceId, undefined, [{ id: `${id}:0`, content }], [])
    return withHeader(
      bytes,
      documentFrame(id, generation, hash, 1),
      chunk(id, content),
      jsonFrame(FRAME.TRAILER, { documents: 1, chunks: 1, tombstones: 0 })
    )
  }

  await rejectsWithCode(
    t,
    load(to, single('a', 'a', MAX_GENERATION + 1), 'past-cap'),
    ERR_CODES.IMPORT_INVALID,
    'document generation'
  )
  const generation = MAX_GENERATION + 1
  const pastCapDelete = withHeader(
    bytes,
    jsonFrame(FRAME.TOMBSTONE, { id: 'a', generation, check: deleteCheck('a', generation) }),
    jsonFrame(FRAME.TRAILER, { documents: 0, chunks: 0, tombstones: 1 })
  )
  await rejectsWithCode(
    t,
    load(to, pastCapDelete, 'past-cap'),
    ERR_CODES.IMPORT_INVALID,
    'delete generation'
  )

  await load(to, single('a', 'a', MAX_GENERATION), 'at-cap')
  await rejectsWithCode(
    t,
    to.ingest({ namespace: 'at-cap', documents: [one('a', spaceId, 'changed')] }),
    ERR_CODES.INVALID_INPUT,
    'replacing a document at the cap',
    /highest/
  )
  await load(to, await exportOf(to, 'at-cap'), 'restored')
  t.alike(
    await ids(to, 'restored'),
    [['a', MAX_GENERATION]],
    'a store at the cap exports and restores'
  )

  await rejectsWithCode(
    t,
    load(to, single('a\ud800', 'a'), 'lone-id'),
    ERR_CODES.IMPORT_INVALID,
    'lone surrogate in a document id'
  )
  await rejectsWithCode(
    t,
    load(to, single('big', 'a'.repeat(MAX_ROW_BYTES)), 'big'),
    ERR_CODES.IMPORT_INVALID,
    'oversized chunk',
    /row limit/
  )
  t.alike(
    (await namespaceNames(to)).sort(),
    ['at-cap', 'restored'],
    'failed imports created no namespace'
  )
})

test('a failed import leaves no namespace it created', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({ namespace: 'ns', documents: [one('a', spaceId, 'a')] })
  const bytes = await exportOf(from)
  const spans = frames(bytes)
  const to = await openTarget(t)

  await rejectsWithCode(
    t,
    load(to, bytes.slice(0, spans[2].end - 1), 'cut'),
    ERR_CODES.IMPORT_INVALID,
    'cut inside the first document'
  )
  t.alike(await namespaceNames(to), [], 'no namespace')
  await to.createNamespace({ name: 'cut', space: { ...SPACE, model: 'another' } })

  const failure = new Error('disk gone')
  async function* failing(): AsyncGenerator<Uint8Array> {
    yield bytes.subarray(0, spans[0].end)
    throw failure
  }
  try {
    await to.importNamespace({ namespace: 'failing', source: failing() })
    t.fail('expected the import to fail')
  } catch (error) {
    t.ok(error instanceof QvacErrorRAG)
    t.is((error as QvacErrorRAG).code, ERR_CODES.IMPORT_SOURCE_FAILED, 'source error')
    t.is((error as Error).cause, failure, 'the source error is the cause')
  }
  t.alike(await namespaceNames(to), ['cut'])
})

test("a namespace emptied by deletes takes the export's lineage", async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({
    namespace: 'ns',
    documents: [one('x', spaceId, 'x'), one('y', spaceId, 'y')]
  })
  const bytes = await exportOf(from)

  const { rag: to } = await openRag(t)
  await to.ingest({
    namespace: 'ns',
    documents: [one('x', spaceId, 'local'), one('z', spaceId, 'z')]
  })
  await to.deleteDocuments({ namespace: 'ns', documentIds: ['x', 'z'] })
  const result = await load(to, bytes)
  t.alike(
    result.documents.map((entry) => [entry.id, entry.status]),
    [
      ['x', 'created'],
      ['y', 'created']
    ],
    "the old lineage's delete records don't apply"
  )
  t.alike(await ids(to), [
    ['x', 1],
    ['y', 1]
  ])
  await load(to, bytes)
  t.pass('a second import of the same export matches the adopted lineage')
})

test('an ingest during an import into its empty namespace commits', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({ namespace: 'ns', documents: [one('a', spaceId, 'a')] })
  const bytes = await exportOf(from)

  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = () => {}
  const embedding = new Promise<void>((resolve) => {
    started = resolve
  })
  const store = new Corestore(await tmp(t))
  const to = createRag({
    corestore: store,
    embeddings: {
      space: SPACE,
      async embedDocuments(texts) {
        started()
        await gate
        return new Float32Array(texts.length * SPACE.dimensions).fill(0.5)
      },
      embedQuery: () => Promise.resolve(new Float32Array(SPACE.dimensions))
    }
  })
  await to.ready()
  t.teardown(async () => {
    await to.close()
    await store.close()
  })
  await to.createNamespace({ name: 'ns', space: SPACE })

  const pending = to.ingest({ namespace: 'ns', documents: [{ id: 'local', text: 'local text' }] })
  await embedding
  await load(to, bytes)
  release()
  const { documents } = await pending
  t.is(documents[0].status, 'created')
  t.alike(await ids(to), [
    ['a', 1],
    ['local', 1]
  ])
})

test('an import whose namespace gains documents before its first write fails with the lineage', async (t) => {
  const { rag: from, spaceId } = await openRag(t)
  await from.ingest({ namespace: 'ns', documents: [one('a', spaceId, 'a')] })
  const bytes = await exportOf(from)
  const spans = frames(bytes)
  const { rag: to } = await openRag(t)

  let resume = () => {}
  const resumed = new Promise<void>((resolve) => {
    resume = resolve
  })
  let reached = () => {}
  const waiting = new Promise<void>((resolve) => {
    reached = resolve
  })
  async function* paused(): AsyncGenerator<Uint8Array> {
    yield bytes.subarray(0, spans[0].end)
    reached()
    await resumed
    yield bytes.subarray(spans[0].end)
  }
  const importing = to.importNamespace({ namespace: 'ns', source: paused() })
  await waiting
  await to.ingest({ namespace: 'ns', documents: [one('local', spaceId, 'local')] })
  resume()
  await rejectsWithCode(t, importing, ERR_CODES.IMPORT_LINEAGE_MISMATCH, 'import')
  t.alike(await ids(to), [['local', 1]], 'the ingest stays')
})

test('an import stopped while it waits for the write lock writes nothing', async (t) => {
  const { rag: from } = await openRag(t, ['empty'])
  const bytes = await exportOf(from, 'empty')

  // A native add that waits on `gate` holds the write lock for its ingest.
  const real = await realNativeIndex()
  let hold = false
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  let entered = () => {}
  const holding = new Promise<void>((resolve) => (entered = resolve))
  const provider: IndexProvider = {
    create(dim, storage) {
      const index = real.create(dim, storage)
      const add = index.addWithIds.bind(index)
      index.addWithIds = async (vectors, ids) => {
        if (hold) {
          entered()
          await gate
        }
        await add(vectors, ids)
      }
      return index
    }
  }
  const { rag, spaceId } = await openRag(t, ['ns'], { provider })
  await rag.ingest({ namespace: 'ns', documents: [one('a', spaceId, 'a')] })
  await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 1 })

  hold = true
  const ingesting = rag.ingest({ namespace: 'ns', documents: [one('b', spaceId, 'b')] })
  await holding
  const controller = new AbortController()
  const importing = rag.importNamespace(
    { namespace: 'copy', source: source(bytes) },
    { signal: controller.signal as AbortSignal }
  )
  // Every frame is in memory, so the import reaches the lock within a few ticks.
  await delay(50)
  controller.abort(new Error('stop'))
  release()
  await ingesting
  const result = await importing
  t.is(result.cancelled, true)
  t.absent((await namespaceNames(rag)).includes('copy'), 'no namespace was created')
})

test('import checks chunks against a namespace created while it read', async (t) => {
  const space8 = { ...SPACE, dimensions: 8, model: 'test-8' }
  const { rag: from } = await openRag(t, [])
  const { spaceId } = await from.createNamespace({ name: 'ns', space: space8 })
  const huge = [2e16, 0, 0, 0, 0, 0, 0, 0]
  await from.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', huge]])] })
  const bytes = await exportOf(from)
  const headerEnd = frames(bytes)[0].end

  let resume = () => {}
  const resumed = new Promise<void>((resolve) => (resume = resolve))
  let paused = () => {}
  const reachedPause = new Promise<void>((resolve) => (paused = resolve))
  async function* pausing(): AsyncGenerator<Uint8Array> {
    yield bytes.slice(0, headerEnd)
    paused()
    await resumed
    yield bytes.slice(headerEnd)
  }

  const to = await openTarget(t)
  const importing = to.importNamespace({ namespace: 'copy', source: pausing() })
  await reachedPause
  await to.createNamespace({ name: 'copy', space: space8, index: { storage: 'turbovec-q4' } })
  resume()
  await rejectsWithCode(t, importing, ERR_CODES.IMPORT_INVALID, 'turbovec storage', /1e16/)
  t.alike(await ids(to, 'copy'), [], 'nothing was written')
})

test('a source whose iterator cannot open fails as the source', async (t) => {
  const to = await openTarget(t)
  const cause = new Error('cannot open')
  const broken = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      throw cause
    }
  }
  try {
    await to.importNamespace({ namespace: 'ns', source: broken })
    t.fail('expected IMPORT_SOURCE_FAILED')
  } catch (error) {
    t.is((error as QvacErrorRAG).code, ERR_CODES.IMPORT_SOURCE_FAILED)
    t.is((error as Error).cause, cause, 'the source error is the cause')
  }
})
