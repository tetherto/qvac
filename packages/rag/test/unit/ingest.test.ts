import test from 'brittle'

import { ERR_CODES } from '../../src/index.js'
import { decodeNativeId, unpackNativeIds } from '../../src/db/encoding.js'
import {
  CHUNKS,
  DOCUMENTS,
  MUTATIONS,
  NAMESPACES,
  NATIVE_IDS,
  type ChunkRecord,
  type DocumentRecord,
  type MutationRecord,
  type NamespaceRecord,
  type NativeIdRecord
} from '../../src/db/records.js'
import { doc, inspect, openRag, rejectsWithCode } from './helpers.js'

const ALL_NS = { gte: { namespace: 'ns' }, lte: { namespace: 'ns' } }

test('ingest stores precomputed chunks with Float32 bytes and default chunk ids', async (t) => {
  const { rag, store, spaceId } = await openRag(t)

  const result = await rag.ingest({
    namespace: 'ns',
    documents: [
      {
        id: 'a',
        metadata: { title: 'A' },
        chunks: [
          { content: 'first', embedding: new Float32Array([1, 0.5, 0]), spaceId },
          {
            id: 'custom',
            content: 'second',
            metadataJson: '{"page":2}',
            embedding: [0, 1, 0],
            spaceId
          }
        ]
      }
    ]
  })
  t.alike(result, { documents: [{ id: 'a', generation: 1, chunkCount: 2 }], revision: 1 })
  await rag.close()

  await inspect(store, async (reader) => {
    const chunks = await reader.find<ChunkRecord>(CHUNKS, ALL_NS).toArray()
    t.is(chunks.length, 2)
    t.is(chunks[0].chunkId, 'a:0', 'default chunk id is <documentId>:<ordinal>')
    t.is(chunks[1].chunkId, 'custom')
    t.is(chunks[1].metadataJson, '{"page":2}')
    t.is(chunks[0].vector.byteLength, 12, 'vector is 3 float32 values')
    const view = new DataView(chunks[0].vector.buffer, chunks[0].vector.byteOffset, 12)
    t.is(view.getFloat32(4, true), 0.5)

    const document = await reader.get<DocumentRecord>(DOCUMENTS, {
      namespace: 'ns',
      documentId: 'a'
    })
    t.is(document?.generation, 1)
    t.is(document?.chunkCount, 2)
    t.alike(document?.metadata, { title: 'A' })
    t.ok(document?.contentHash, 'content hash is stored')
  })
})

test('native ids come from a monotonic per-namespace counter', async (t) => {
  const { rag, store, spaceId } = await openRag(t, ['ns', 'other'])

  await rag.ingest({
    namespace: 'ns',
    documents: [
      doc('a', spaceId, [
        ['a0', [1, 0, 0]],
        ['a1', [0, 1, 0]]
      ]),
      doc('b', spaceId, [['b0', [0, 0, 1]]])
    ]
  })
  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['b'] })
  await rag.ingest({ namespace: 'ns', documents: [doc('b', spaceId, [['b0', [0, 0, 1]]])] })
  await rag.ingest({ namespace: 'other', documents: [doc('x', spaceId, [['x0', [1, 0, 0]]])] })
  await rag.close()

  await inspect(store, async (reader) => {
    const ids = (await reader.find<NativeIdRecord>(NATIVE_IDS, ALL_NS).toArray()).map((row) =>
      decodeNativeId(row.nativeId)
    )
    t.alike(ids, [1n, 2n, 4n], 'a deleted id (3) is never reused')

    const ns = await reader.get<NamespaceRecord>(NAMESPACES, { name: 'ns' })
    t.is(decodeNativeId(ns!.nextNativeId), 5n)
    const other = await reader.get<NamespaceRecord>(NAMESPACES, { name: 'other' })
    t.is(decodeNativeId(other!.nextNativeId), 2n, 'each namespace has its own counter')
  })
})

test('identical text in two documents is stored twice', async (t) => {
  const { rag, spaceId } = await openRag(t)

  await rag.ingest({
    namespace: 'ns',
    documents: [
      doc('a', spaceId, [['same text', [1, 0, 0]]]),
      doc('b', spaceId, [['same text', [1, 0, 0]]])
    ]
  })

  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], k: 10 })
  t.alike(
    hits.map((hit) => [hit.documentId, hit.content]),
    [
      ['a', 'same text'],
      ['b', 'same text']
    ]
  )
})

test('re-ingest replaces a document and drops superseded chunks', async (t) => {
  const { rag, store, spaceId } = await openRag(t)

  await rag.ingest({
    namespace: 'ns',
    documents: [
      doc('a', spaceId, [
        ['old one', [1, 0, 0]],
        ['old two', [0, 1, 0]]
      ])
    ]
  })
  const result = await rag.ingest({
    namespace: 'ns',
    documents: [doc('a', spaceId, [['new', [0, 0, 1]]])]
  })
  t.alike(result.documents, [{ id: 'a', generation: 2, chunkCount: 1 }])

  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 1, 1], k: 10 })
  t.alike(
    hits.map((hit) => hit.content),
    ['new'],
    'only the new generation is searchable'
  )
  await rag.close()

  await inspect(store, async (reader) => {
    const chunks = await reader.find<ChunkRecord>(CHUNKS, ALL_NS).toArray()
    t.is(chunks.length, 1)
    t.is(chunks[0].generation, 2)

    const nativeIds = await reader.find<NativeIdRecord>(NATIVE_IDS, ALL_NS).toArray()
    t.alike(
      nativeIds.map((row) => decodeNativeId(row.nativeId)),
      [3n],
      'old native ids are deleted in the same batch'
    )

    const mutations = await reader.find<MutationRecord>(MUTATIONS, ALL_NS).toArray()
    t.is(mutations.length, 2)
    t.alike(unpackNativeIds(mutations[1].added), [3n])
    t.alike(unpackNativeIds(mutations[1].removed), [1n, 2n])
    const ns = await reader.get<NamespaceRecord>(NAMESPACES, { name: 'ns' })
    t.is(ns?.revision, 2)
  })
})

test('ingest validates everything before committing anything', async (t) => {
  const { rag, spaceId } = await openRag(t)

  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [
        doc('good', spaceId, [['ok', [1, 0, 0]]]),
        doc('bad', 'another-space', [['x', [1, 0, 0]]])
      ]
    }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'chunk spaceId differs from the namespace'
  )
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [doc('bad', spaceId, [['x', [1, 0]]])] }),
    ERR_CODES.EMBEDDING_DIMENSION_MISMATCH,
    'wrong dimensions'
  )
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [doc('bad', spaceId, [['x', [1, NaN, 0]]])] }),
    ERR_CODES.INVALID_INPUT,
    'non-finite value'
  )
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [doc('dup', spaceId, [['x', [1, 0, 0]]]), doc('dup', spaceId, [['y', [1, 0, 0]]])]
    }),
    ERR_CODES.DUPLICATE_DOCUMENT_ID,
    'duplicate document id'
  )
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [
        {
          id: 'dup-chunks',
          chunks: [
            { id: 'c', content: 'x', embedding: [1, 0, 0], spaceId },
            { id: 'c', content: 'y', embedding: [1, 0, 0], spaceId }
          ]
        }
      ]
    }),
    ERR_CODES.INVALID_INPUT,
    'duplicate chunk id'
  )
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [{ id: 'empty', chunks: [] }] }),
    ERR_CODES.INVALID_INPUT,
    'document without chunks'
  )
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [{ id: 't', text: 'raw text', chunks: [] } as never]
    }),
    ERR_CODES.INVALID_INPUT,
    'text input is not accepted yet'
  )
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'missing', documents: [doc('a', spaceId, [['x', [1, 0, 0]]])] }),
    ERR_CODES.NAMESPACE_NOT_FOUND,
    'unknown namespace'
  )

  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], k: 10 })
  t.is(hits.length, 0, 'nothing was written by the rejected calls')
})

test('deleteDocuments removes chunks and native ids and ignores unknown ids', async (t) => {
  const { rag, store, spaceId } = await openRag(t)

  await rag.ingest({
    namespace: 'ns',
    documents: [doc('a', spaceId, [['a0', [1, 0, 0]]]), doc('b', spaceId, [['b0', [0, 1, 0]]])]
  })
  const result = await rag.deleteDocuments({ namespace: 'ns', documentIds: ['a', 'missing'] })
  t.alike(result, { deleted: ['a'], revision: 3 })

  const noop = await rag.deleteDocuments({ namespace: 'ns', documentIds: ['missing'] })
  t.alike(noop, { deleted: [], revision: 3 }, 'nothing to delete leaves the revision alone')

  await rejectsWithCode(
    t,
    rag.deleteDocuments({ namespace: 'missing', documentIds: ['a'] }),
    ERR_CODES.NAMESPACE_NOT_FOUND,
    'unknown namespace'
  )

  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 1, 0], k: 10 })
  t.alike(
    hits.map((hit) => hit.documentId),
    ['b']
  )
  await rag.close()

  await inspect(store, async (reader) => {
    t.is(await reader.get(DOCUMENTS, { namespace: 'ns', documentId: 'a' }), null)
    const nativeIds = await reader.find<NativeIdRecord>(NATIVE_IDS, ALL_NS).toArray()
    t.alike(
      nativeIds.map((row) => row.documentId),
      ['b']
    )
    const mutations = await reader.find<MutationRecord>(MUTATIONS, ALL_NS).toArray()
    t.alike(unpackNativeIds(mutations[2].removed), [1n])
  })
})
