import test from 'brittle'

import { ERR_CODES } from '../../src/index.js'
import { doc, openRag, rejectsWithCode, type Test } from './helpers.js'

async function setup(t: Test) {
  const fixture = await openRag(t, ['ns', 'other'])
  const { rag, spaceId } = fixture
  await rag.ingest({
    namespace: 'ns',
    documents: [
      doc('a', spaceId, [['a', [1, 0, 0]]]),
      doc('b', spaceId, [['b', [0.8, 0, 0]]]),
      doc('c', spaceId, [['c', [0.6, 0, 0]]])
    ]
  })
  await rag.ingest({ namespace: 'other', documents: [doc('x', spaceId, [['x', [1, 0, 0]]])] })
  return fixture
}

const query = { vector: [1, 0, 0], k: 10 }

function ids(hits: Array<{ documentId: string }>): string[] {
  return hits.map((hit) => hit.documentId)
}

test('scoped handle searches only its bound scope', async (t) => {
  const { rag } = await setup(t)
  const reader = rag.scoped({ namespace: 'ns', documentIds: ['b', 'c'] })

  t.alike(Object.keys(reader), ['search'], 'the handle exposes search only')
  t.alike(ids(await reader.search(query)), ['b', 'c'])
})

test('a request scope narrows the bound scope', async (t) => {
  const { rag } = await setup(t)
  const reader = rag.scoped({ namespace: 'ns', documentIds: ['b', 'c'] })

  t.alike(ids(await reader.search({ ...query, scope: { documentIds: ['c'] } })), ['c'])
  t.alike(
    ids(await reader.search({ ...query, scope: { documentIds: ['a', 'c'] } })),
    ['c'],
    'ids outside the bound scope are dropped, not added'
  )
  t.alike(
    await reader.search({ ...query, scope: { documentIds: ['a'] } }),
    [],
    'an empty intersection returns nothing'
  )
  t.alike(ids(await reader.search({ ...query, scope: { namespace: 'ns' } })), ['b', 'c'])
})

test('a namespace-wide handle can be narrowed to documents', async (t) => {
  const { rag } = await setup(t)
  const reader = rag.scoped({ namespace: 'ns' })

  t.alike(ids(await reader.search(query)), ['a', 'b', 'c'])
  t.alike(ids(await reader.search({ ...query, scope: { documentIds: ['b'] } })), ['b'])
  t.alike(
    await reader.search({ ...query, scope: { documentIds: ['x'] } }),
    [],
    'a document from another namespace is not searched'
  )
})

test('a scoped handle cannot widen', async (t) => {
  const { rag } = await setup(t)
  const reader = rag.scoped({ namespace: 'ns', documentIds: ['b'] })

  await rejectsWithCode(
    t,
    reader.search({ ...query, scope: { namespace: 'other' } }),
    ERR_CODES.INVALID_SCOPE,
    'another namespace'
  )
  await rejectsWithCode(
    t,
    reader.search({ ...query, scope: { documentIds: ['b'], all: true } as never }),
    ERR_CODES.INVALID_SCOPE,
    'unknown request key'
  )
})

test('scoped validates the bound scope up front', async (t) => {
  const { rag } = await setup(t)
  await rejectsWithCode(
    t,
    () => rag.scoped({ documentIds: ['a'] } as never),
    ERR_CODES.INVALID_SCOPE,
    'no namespace'
  )
  await rejectsWithCode(
    t,
    () => rag.scoped({ namespace: 'ns', extra: 1 } as never),
    ERR_CODES.INVALID_SCOPE,
    'unknown key'
  )
  const empty = rag.scoped({ namespace: 'ns', documentIds: [] })
  t.alike(await empty.search(query), [], 'an empty bound scope returns nothing')
})

test('a scoped handle stops seeing deleted documents and keeps serving the rest', async (t) => {
  const { rag } = await setup(t)
  const reader = rag.scoped({ namespace: 'ns', documentIds: ['b', 'c'] })
  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['b'] })

  t.alike(ids(await reader.search(query)), ['c'], 'the deleted document is gone, c still answers')
  t.alike(
    await reader.search({ ...query, scope: { documentIds: ['b'] } }),
    [],
    'narrowing to the deleted document returns nothing'
  )

  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['c'] })
  t.alike(await reader.search(query), [], 'a fully stale grant returns nothing')

  await rejectsWithCode(
    t,
    rag.search({ ...query, scope: { namespace: 'ns', documentIds: ['b'] } }),
    ERR_CODES.DOCUMENT_OUT_OF_SCOPE,
    'direct search still fails on an unknown document'
  )
})
