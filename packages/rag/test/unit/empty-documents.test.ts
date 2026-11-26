import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'

import { ERR_CODES, createRag } from '../../src/index.js'
import { doc, fakePort, openRag, rejectsWithCode, useScan, SPACE } from './helpers.js'
import type { Rag } from '../../src/types.js'

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

async function* source(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

async function chunkCounts(rag: Rag, namespace = 'ns'): Promise<Array<[string, number]>> {
  const { documents } = await rag.listDocuments({ namespace })
  return documents.map((document) => [document.documentId, document.chunkCount])
}

function documentIdsOf(hits: Array<{ documentId: string }>): string[] {
  return hits.map((hit) => hit.documentId)
}

for (const mode of ['index', 'scan'] as const) {
  test(`a document without chunks is listed and never returned by search (${mode})`, async (t) => {
    if (mode === 'scan') useScan(t)
    const { rag, spaceId } = await openRag(t)
    const result = await rag.ingest({
      namespace: 'ns',
      documents: [{ id: 'empty', chunks: [] }, doc('a', spaceId, [['a', [1, 0, 0]]])]
    })
    t.alike(
      result.documents.map((document) => [document.id, document.chunkCount, document.status]),
      [
        ['empty', 0, 'created'],
        ['a', 1, 'created']
      ]
    )
    t.alike(await chunkCounts(rag), [
      ['a', 1],
      ['empty', 0]
    ])

    const page = await rag.readDocument({ namespace: 'ns', documentId: 'empty' })
    t.is(page.chunkCount, 0)
    t.alike(page.chunks, [])
    t.is(page.nextOrdinal, null)

    const [summary] = await rag.listNamespaces()
    t.is(summary.documentCount, 2)
    t.is(summary.chunkCount, 1)

    const query = { vector: [1, 1, 1], spaceId, k: 10 }
    t.alike(documentIdsOf(await rag.search({ ...query, scope: { namespace: 'ns' } })), ['a'])
    t.alike(
      await rag.search({ ...query, scope: { namespace: 'ns', documentIds: ['empty'] } }),
      [],
      'scoped to the empty document alone'
    )
    t.alike(
      documentIdsOf(
        await rag.search({
          ...query,
          perDocument: 1,
          scope: { namespace: 'ns', documentIds: ['empty', 'a'] }
        })
      ),
      ['a'],
      'perDocument seats only documents with chunks'
    )
    t.alike(documentIdsOf(await rag.scoped({ namespace: 'ns' }).search({ ...query })), ['a'])
  })
}

test('text and pre-chunked input with nothing to chunk become documents without chunks', async (t) => {
  const port = fakePort()
  const store = new Corestore(await tmp(t))
  const rag = createRag({ corestore: store, embeddings: port })
  await rag.ready()
  t.teardown(async () => {
    await rag.close()
    await store.close()
  })
  await rag.createNamespace({ name: 'ns', space: SPACE })

  const result = await rag.ingest({
    namespace: 'ns',
    documents: [
      { id: 'blank', text: '   ' },
      { id: 'empty', text: '' },
      { id: 'chunked', chunks: [] }
    ]
  })
  t.alike(
    result.documents.map((document) => [document.id, document.chunkCount, document.status]),
    [
      ['blank', 0, 'created'],
      ['empty', 0, 'created'],
      ['chunked', 0, 'created']
    ]
  )
  t.is(port.batches.length, 0, 'nothing sent to the port')
  t.alike(await chunkCounts(rag), [
    ['blank', 0],
    ['chunked', 0],
    ['empty', 0]
  ])
})

test('re-ingesting a document to and from no chunks', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const query = { vector: [1, 0, 0], spaceId, k: 10, scope: { namespace: 'ns' } }
  await rag.ingest({ namespace: 'ns', documents: [{ id: 'd', chunks: [] }] })

  const unchanged = await rag.ingest({ namespace: 'ns', documents: [{ id: 'd', chunks: [] }] })
  t.alike(unchanged.documents[0], { id: 'd', generation: 1, chunkCount: 0, status: 'unchanged' })

  const filled = await rag.ingest({
    namespace: 'ns',
    documents: [doc('d', spaceId, [['d0', [1, 0, 0]]])]
  })
  t.alike(filled.documents[0], {
    id: 'd',
    generation: 2,
    chunkCount: 1,
    status: 'replaced',
    removedChunks: 0
  })
  t.alike(documentIdsOf(await rag.search(query)), ['d'])

  const emptied = await rag.ingest({ namespace: 'ns', documents: [{ id: 'd', chunks: [] }] })
  t.alike(emptied.documents[0], {
    id: 'd',
    generation: 3,
    chunkCount: 0,
    status: 'replaced',
    removedChunks: 1
  })
  t.alike(await rag.search(query), [], 'the old chunk is gone from search')
  t.alike(await chunkCounts(rag), [['d', 0]])
})

test('a document without chunks is deleted and re-created past its delete record', async (t) => {
  const { rag } = await openRag(t)
  await rag.ingest({ namespace: 'ns', documents: [{ id: 'd', chunks: [] }] })
  const deleted = await rag.deleteDocuments({ namespace: 'ns', documentIds: ['d'] })
  t.alike(deleted.deleted, ['d'])
  t.alike(await chunkCounts(rag), [])
  const [summary] = await rag.listNamespaces()
  t.is(summary.documentCount, 0)

  const again = await rag.ingest({ namespace: 'ns', documents: [{ id: 'd', chunks: [] }] })
  t.is(again.documents[0].generation, 2, 'generation continues after the delete record')
})

test('documents without chunks survive export and import', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      { id: 'empty', chunks: [], metadata: { kind: 'binary' } },
      { id: 'gone', chunks: [] },
      doc('a', spaceId, [['a', [1, 0, 0]]])
    ]
  })
  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['gone'] })
  const bytes = await collect(rag.exportNamespace({ namespace: 'ns' }))

  const target = await openRag(t, [])
  const result = await target.rag.importNamespace({ namespace: 'copy', source: source(bytes) })
  t.alike(result.documents.map((document) => [document.id, document.status]).sort(), [
    ['a', 'created'],
    ['empty', 'created']
  ])
  t.alike(await chunkCounts(target.rag, 'copy'), [
    ['a', 1],
    ['empty', 0]
  ])
  const page = await target.rag.readDocument({ namespace: 'copy', documentId: 'empty' })
  t.alike(page.metadata, { kind: 'binary' })
  t.alike(page.chunks, [])

  const recreated = await target.rag.ingest({
    namespace: 'copy',
    documents: [{ id: 'gone', chunks: [] }]
  })
  t.is(recreated.documents[0].generation, 2, 'the delete record came across')
  await target.rag.deleteDocuments({ namespace: 'copy', documentIds: ['gone'] })

  const again = await target.rag.importNamespace({ namespace: 'copy', source: source(bytes) })
  t.ok(
    again.documents.every((document) => document.status !== 'created'),
    'a second import changes nothing'
  )
})

test('a document without chunks is checked against the namespace space', async (t) => {
  const { rag } = await openRag(t)
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [{ id: 'd', spaceId: 'other', chunks: [] }] }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'document-level spaceId'
  )
  t.alike(await chunkCounts(rag), [], 'nothing written')
})

test('dropNamespace counts documents without chunks', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [{ id: 'empty', chunks: [] }, doc('a', spaceId, [['a', [1, 0, 0]]])]
  })
  t.alike(await rag.dropNamespace({ name: 'ns' }), {
    name: 'ns',
    documentCount: 2,
    chunkCount: 1
  })
})
