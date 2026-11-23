import test from 'brittle'

import { ERR_CODES, createRag } from '../../src/index.js'
import {
  NAMESPACES,
  TOMBSTONES,
  type NamespaceRecord,
  type TombstoneRecord
} from '../../src/db/records.js'
import { doc, inspect, mutate, openRag, rejectsWithCode } from './helpers.js'

const ALL_NS = { gte: { namespace: 'ns' }, lte: { namespace: 'ns' } }

test('an ingest after a delete continues the generation', async (t) => {
  const { rag, store, spaceId } = await openRag(t)
  const write = (content: string) =>
    rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [[content, [1, 0, 0]]])] })

  await write('one')
  await write('two')
  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['a', 'never'] })

  const again = await write('three')
  t.is(again.documents[0].generation, 3, 'not back to 1')
  t.is(again.documents[0].status, 'created')
  await rejectsWithCode(
    t,
    rag.readDocument({ namespace: 'ns', documentId: 'a', generation: 2 }),
    ERR_CODES.DOCUMENT_CHANGED,
    'a page of the deleted generation stays stale'
  )

  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['a'] })
  await rag.close()
  const tombstones = await inspect(store, (reader) =>
    reader.find<TombstoneRecord>(TOMBSTONES, ALL_NS).toArray()
  )
  t.alike(
    tombstones.map((row) => [row.documentId, row.generation]),
    [['a', 3]],
    'one tombstone per deleted ID, none for unknown IDs'
  )

  const reopened = createRag({ corestore: store })
  await reopened.ready()
  t.teardown(() => reopened.close())
  const last = await reopened.ingest({
    namespace: 'ns',
    documents: [doc('a', spaceId, [['four', [1, 0, 0]]])]
  })
  t.is(last.documents[0].generation, 4, 'the tombstone survives a reopen')
  await reopened.close()
  const cleared = await inspect(store, (reader) =>
    reader.find<TombstoneRecord>(TOMBSTONES, ALL_NS).toArray()
  )
  t.alike(cleared, [], 'the ingest clears the tombstone')
})

test('each namespace gets its own lineage, kept across writes', async (t) => {
  const { rag, store, spaceId } = await openRag(t, ['ns', 'other'])
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['x', [1, 0, 0]]])] })
  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['a'] })
  await rag.close()

  const [ns, other] = await inspect(store, async (reader) => [
    await reader.get<NamespaceRecord>(NAMESPACES, { name: 'ns' }),
    await reader.get<NamespaceRecord>(NAMESPACES, { name: 'other' })
  ])
  t.is(ns!.lineageId!.byteLength, 16)
  t.is(other!.lineageId!.byteLength, 16)
  t.unlike(ns!.lineageId, other!.lineageId, 'two namespaces, two lineages')
  t.is(ns!.revision, 2, 'written twice')
})

test('a namespace without a lineage gets one on its first write', async (t) => {
  const { rag, store, spaceId } = await openRag(t)
  await rag.close()
  await mutate(store, async (tx) => {
    const ns = await tx.get<NamespaceRecord>(NAMESPACES, { name: 'ns' })
    const { lineageId, ...legacy } = ns!
    t.ok(lineageId, 'new namespaces start with one')
    await tx.insert(NAMESPACES, legacy)
  })

  const reopened = createRag({ corestore: store })
  await reopened.ready()
  await reopened.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['x', [1, 0, 0]]])] })
  await reopened.close()
  const first = await inspect(store, (reader) =>
    reader.get<NamespaceRecord>(NAMESPACES, { name: 'ns' })
  )
  t.is(first!.lineageId!.byteLength, 16)

  const again = createRag({ corestore: store })
  await again.ready()
  await again.ingest({ namespace: 'ns', documents: [doc('b', spaceId, [['y', [0, 1, 0]]])] })
  await again.close()
  const second = await inspect(store, (reader) =>
    reader.get<NamespaceRecord>(NAMESPACES, { name: 'ns' })
  )
  t.alike(second!.lineageId, first!.lineageId, 'set once, then kept')
})
