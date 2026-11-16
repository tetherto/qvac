import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'
import { AbortController } from 'bare-abort-controller'

import { createRag } from '../../src/index.js'
import { decodeNativeId } from '../../src/db/encoding.js'
import {
  CHUNKS,
  DOCUMENTS,
  MUTATIONS,
  NAMESPACES,
  type ChunkRecord,
  type DocumentRecord,
  type MutationRecord,
  type NamespaceRecord
} from '../../src/db/records.js'
import { SPACE, countNativeCalls, doc, fakePort, inspect, openRag, type Test } from './helpers.js'
import type { HyperDBReader } from '../../src/db/db-types.js'
import type { ChunkingOptions, EmbeddingsPort, Rag } from '../../src/types.js'
import type { Corestore as Store } from '../../src/db/db-types.js'

const ALL_NS = { gte: { namespace: 'ns' }, lte: { namespace: 'ns' } }

const LONG_TEXT = Array.from({ length: 400 }, (_, i) => (i % 50 === 0 ? 'cat' : `word${i}`)).join(
  ' '
)

async function openWithPort(
  t: Test,
  store: Store,
  port: EmbeddingsPort,
  chunking?: ChunkingOptions
): Promise<Rag> {
  const rag = createRag({ corestore: store, embeddings: port, chunking })
  await rag.ready()
  await rag.createNamespace({ name: 'ns', space: SPACE })
  t.teardown(() => rag.close())
  return rag
}

async function openStore(t: Test): Promise<Store> {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close(), { order: 1 })
  return store
}

// Every row the namespace holds, so a no-op can be checked as "nothing changed".
async function rows(reader: HyperDBReader) {
  const ns = await reader.get<NamespaceRecord>(NAMESPACES, { name: 'ns' })
  const documents = await reader.find<DocumentRecord>(DOCUMENTS, ALL_NS).toArray()
  const chunks = await reader.find<ChunkRecord>(CHUNKS, ALL_NS).toArray()
  const mutations = await reader.find<MutationRecord>(MUTATIONS, ALL_NS).toArray()
  return {
    revision: ns?.revision,
    nextNativeId: ns ? decodeNativeId(ns.nextNativeId) : null,
    documents: documents.map((row) => [row.documentId, row.generation, row.contentHash]),
    chunks: chunks.map((row) => [row.documentId, row.generation, decodeNativeId(row.nativeId)]),
    mutations: mutations.map((row) => row.revision)
  }
}

test('re-ingesting unchanged precomputed documents writes nothing', async (t) => {
  const calls = await countNativeCalls(t)
  const { rag, store, spaceId } = await openRag(t)
  const input = {
    id: 'a',
    metadata: { title: 'A' },
    chunks: [
      { content: 'one', embedding: [1, 0, 0], spaceId },
      { content: 'two', embedding: [0, 1, 0], spaceId }
    ]
  }
  const first = await rag.ingest({ namespace: 'ns', documents: [input] })
  t.is(first.revision, 1)
  t.alike(
    (await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 1 }))[0].content,
    'one'
  )
  t.is(calls.creates, 1, 'the search built the index')

  const again = await rag.ingest({ namespace: 'ns', documents: [structuredClone(input)] })
  t.alike(again, {
    documents: [{ id: 'a', generation: 1, chunkCount: 2, status: 'unchanged' }],
    skipped: [],
    cancelled: false,
    revision: 1
  })
  t.alike(
    (await rag.search({ scope: { namespace: 'ns' }, vector: [0, 1, 0], spaceId, k: 1 }))[0].content,
    'two',
    'the open index still serves the document'
  )
  t.is(calls.creates, 1, 'and was not rebuilt')
  await rag.close()

  const before = await inspect(store, rows)
  t.is(before.revision, 1, 'no revision bump')
  t.alike(before.mutations, [1], 'no mutation row')
  t.alike(
    before.chunks.map(([, generation, nativeId]) => [generation, nativeId]),
    [
      [1, 1n],
      [1, 2n]
    ],
    'chunks and native ids untouched'
  )
  t.is(before.nextNativeId, 3n, 'no native ids allocated')
})

test('a changed vector, chunk or metadata replaces the document', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const base = doc('a', spaceId, [['one', [1, 0, 0]]])
  await rag.ingest({ namespace: 'ns', documents: [base] })

  const changes = [
    { label: 'vector', document: doc('a', spaceId, [['one', [0, 1, 0]]]) },
    { label: 'content', document: doc('a', spaceId, [['uno', [0, 1, 0]]]) },
    {
      label: 'chunk metadata',
      document: {
        id: 'a',
        chunks: [{ content: 'uno', embedding: [0, 1, 0], spaceId, metadataJson: '{"p":1}' }]
      }
    },
    {
      label: 'document metadata',
      document: {
        id: 'a',
        metadata: { title: 'A' },
        chunks: [{ content: 'uno', embedding: [0, 1, 0], spaceId, metadataJson: '{"p":1}' }]
      }
    }
  ]
  let generation = 1
  for (const { label, document } of changes) {
    const result = await rag.ingest({ namespace: 'ns', documents: [document] })
    generation++
    t.alike(
      result.documents,
      [{ id: 'a', generation, chunkCount: 1, status: 'replaced', removedChunks: 1 }],
      label
    )
    t.is(result.revision, generation, `${label}: revision bumped`)
  }
})

test('unchanged text is not embedded again, and new chunking options count as a change', async (t) => {
  const store = await openStore(t)
  const port = fakePort()
  const rag = await openWithPort(t, store, port)

  const first = await rag.ingest({ namespace: 'ns', documents: [{ id: 'long', text: LONG_TEXT }] })
  const chunkCount = first.documents[0].chunkCount
  t.ok(chunkCount > 1, 'the text spans several chunks')
  const embedded = port.batches.flat().length

  const again = await rag.ingest({ namespace: 'ns', documents: [{ id: 'long', text: LONG_TEXT }] })
  t.alike(again.documents, [{ id: 'long', generation: 1, chunkCount, status: 'unchanged' }])
  t.is(again.revision, 1)
  t.is(port.batches.flat().length, embedded, 'nothing was sent to the port')

  await rag.close()

  // The same chunks as text and as pre-chunked input are the same content.
  const stored = await inspect(store, (reader) =>
    reader.find<ChunkRecord>(CHUNKS, ALL_NS).toArray()
  )
  const chunks = stored
    .sort((x, y) => x.ordinal - y.ordinal)
    .map((chunk) => ({
      id: chunk.chunkId,
      content: chunk.content,
      metadataJson: chunk.metadataJson
    }))
  const reopened = await openWithPort(t, store, port)
  const asChunks = await reopened.ingest({ namespace: 'ns', documents: [{ id: 'long', chunks }] })
  t.is(asChunks.documents[0].status, 'unchanged', 'pre-chunked input with the same chunks')
  await reopened.close()

  const rechunked = await openWithPort(t, store, port, { chunkSize: 64, chunkOverlap: 8 })
  const result = await rechunked.ingest({
    namespace: 'ns',
    documents: [{ id: 'long', text: LONG_TEXT }]
  })
  const [document] = result.documents
  t.is(document.status, 'replaced', 'smaller chunks are a change')
  t.is(document.generation, 2)
  t.ok(document.chunkCount > chunkCount, 'into more chunks')
  t.is(
    document.status === 'replaced' && document.removedChunks,
    chunkCount,
    'reports the old chunks'
  )
  t.is(result.revision, 2)
})

test('a mixed batch reports created, replaced and unchanged in input order', async (t) => {
  const { rag, store, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      doc('same', spaceId, [['same', [1, 0, 0]]]),
      doc('edit', spaceId, [
        ['old one', [0, 1, 0]],
        ['old two', [0, 1, 0]],
        ['old three', [0, 1, 0]]
      ])
    ]
  })

  const result = await rag.ingest({
    namespace: 'ns',
    documents: [
      doc('new', spaceId, [['new', [0, 0, 1]]]),
      doc('same', spaceId, [['same', [1, 0, 0]]]),
      doc('edit', spaceId, [['new one', [0, 1, 0]]])
    ]
  })
  t.alike(result, {
    documents: [
      { id: 'new', generation: 1, chunkCount: 1, status: 'created' },
      { id: 'same', generation: 1, chunkCount: 1, status: 'unchanged' },
      { id: 'edit', generation: 2, chunkCount: 1, status: 'replaced', removedChunks: 3 }
    ],
    skipped: [],
    cancelled: false,
    revision: 4
  })
  await rag.close()

  const state = await inspect(store, rows)
  t.alike(
    state.mutations,
    [1, 2, 3, 4],
    'one mutation per written document, none for the unchanged one'
  )
})

test('an unchanged document is skipped like any other on abort, and comes back after a delete', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const input = doc('a', spaceId, [['a', [1, 0, 0]]])
  await rag.ingest({ namespace: 'ns', documents: [input] })

  const controller = new AbortController()
  controller.abort(new Error('stop'))
  const aborted = await rag.ingest(
    { namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] },
    { signal: controller.signal as AbortSignal }
  )
  t.alike(aborted, { documents: [], skipped: ['a'], cancelled: true, revision: 1 })

  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['a'] })
  const result = await rag.ingest({
    namespace: 'ns',
    documents: [doc('a', spaceId, [['a', [1, 0, 0]]])]
  })
  t.alike(result.documents, [{ id: 'a', generation: 1, chunkCount: 1, status: 'created' }])
  t.is(result.revision, 3)
})

// After pause(), holds the next embedDocuments call until release() so another
// call can write meanwhile.
function pausingPort() {
  const port = fakePort()
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const paused = new Promise<void>((resolve) => (entered = resolve))
  let armed = false
  const embedDocuments = port.embedDocuments.bind(port)
  port.embedDocuments = async (texts, options) => {
    if (armed) {
      armed = false
      entered()
      await gate
    }
    return embedDocuments(texts, options)
  }
  function pause() {
    armed = true
  }
  return { port, pause, paused, release }
}

test('a document found unchanged is rechecked at commit', async (t) => {
  const store = await openStore(t)
  const { port, pause, paused, release } = pausingPort()
  const rag = await openWithPort(t, store, port)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      { id: 'gone', text: 'cat' },
      { id: 'edited', text: 'dog' },
      { id: 'kept', text: 'fish' }
    ]
  })

  pause()
  const pending = rag.ingest({
    namespace: 'ns',
    documents: [
      { id: 'new', text: 'bird' },
      { id: 'gone', text: 'cat' },
      { id: 'edited', text: 'dog' },
      { id: 'kept', text: 'fish' }
    ]
  })
  await paused
  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['gone'] })
  await rag.ingest({ namespace: 'ns', documents: [{ id: 'edited', text: 'horse' }] })
  release()

  const result = await pending
  t.alike(result.documents, [
    { id: 'new', generation: 1, chunkCount: 1, status: 'created' },
    { id: 'gone', generation: 1, chunkCount: 1, status: 'created' },
    { id: 'edited', generation: 3, chunkCount: 1, status: 'replaced', removedChunks: 1 },
    { id: 'kept', generation: 1, chunkCount: 1, status: 'unchanged' }
  ])
  t.is(result.revision, 8, 'the latest revision, including the concurrent writes')
  t.alike(
    port.batches.slice(1).flat().sort(),
    ['bird', 'cat', 'dog', 'horse'],
    'only the changed documents were embedded'
  )

  const hits = await rag.search({ scope: { namespace: 'ns' }, query: 'dog', k: 1 })
  t.is(hits[0].documentId, 'edited')
  t.is(hits[0].content, 'dog', 'this call wrote its content back')
})

test('a document that changed before its commit is embedded next', async (t) => {
  const store = await openStore(t)
  const { port, pause, paused, release } = pausingPort()
  const rag = await openWithPort(t, store, port)
  await rag.ingest({ namespace: 'ns', documents: [{ id: 'a', text: 'cat' }] })
  const before = port.batches.length

  const later = Array.from({ length: 40 }, (_, i) => ({ id: `doc${i}`, text: `fish ${i}` }))
  pause()
  // 'a' waits behind doc0, so it is still uncommitted when the delete lands.
  const [first, ...rest] = later
  const pending = rag.ingest({
    namespace: 'ns',
    documents: [first, { id: 'a', text: 'cat' }, ...rest]
  })
  await paused
  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['a'] })
  release()

  const result = await pending
  t.is(result.documents.length, 41)
  const batches = port.batches.slice(before)
  t.is(batches.length, 2)
  t.is(batches[1][0], 'cat', 'ahead of the documents still waiting')
})

test('an unchanged result reports the revision a concurrent call reached', async (t) => {
  const store = await openStore(t)
  const { port, pause, paused, release } = pausingPort()
  const rag = await openWithPort(t, store, port)

  pause()
  const pending = rag.ingest({ namespace: 'ns', documents: [{ id: 'a', text: 'cat' }] })
  await paused
  const other = await rag.ingest({ namespace: 'ns', documents: [{ id: 'a', text: 'cat' }] })
  t.is(other.revision, 1)
  release()

  const result = await pending
  t.alike(result.documents, [{ id: 'a', generation: 1, chunkCount: 1, status: 'unchanged' }])
  t.is(result.revision, 1)
})

test("a rag-extract chunk's indexedAt alone is not a change", async (t) => {
  const store = await openStore(t)
  const port = fakePort()
  const rag = await openWithPort(t, store, port)
  function chunk(indexedAt: string, title = 'Guide') {
    const metadata = { documentId: 'guide', title, chunkIndex: 0, tokenCount: 1, indexedAt }
    return { id: 'guide:0', content: 'cat', metadataJson: JSON.stringify(metadata) }
  }

  await rag.ingest({ namespace: 'ns', documents: [{ id: 'guide', chunks: [chunk('2026-01-01')] }] })
  const later = await rag.ingest({
    namespace: 'ns',
    documents: [{ id: 'guide', chunks: [chunk('2026-02-01')] }]
  })
  t.is(later.documents[0].status, 'unchanged', 'only indexedAt differs')

  const retitled = await rag.ingest({
    namespace: 'ns',
    documents: [{ id: 'guide', chunks: [chunk('2026-02-01', 'Handbook')] }]
  })
  t.is(retitled.documents[0].status, 'replaced', 'any other metadata field is a change')
})

test('indexedAt in metadata rag-extract did not write is a change', async (t) => {
  const store = await openStore(t)
  const port = fakePort()
  const rag = await openWithPort(t, store, port)
  function chunk(indexedAt: string) {
    return { id: 'own:0', content: 'cat', metadataJson: JSON.stringify({ indexedAt, src: 'x' }) }
  }

  await rag.ingest({ namespace: 'ns', documents: [{ id: 'own', chunks: [chunk('t1')] }] })
  const result = await rag.ingest({
    namespace: 'ns',
    documents: [{ id: 'own', chunks: [chunk('t2')] }]
  })
  t.is(result.documents[0].status, 'replaced')
  const [hit] = await rag.search({ scope: { namespace: 'ns' }, query: 'cat', k: 1 })
  t.is(hit.metadataJson, JSON.stringify({ indexedAt: 't2', src: 'x' }))
})
