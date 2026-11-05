import test from 'brittle'

import { ERR_CODES } from '../../src/index.js'
import { SCAN_BATCH_SIZE } from '../../src/search.js'
import { SPACE, doc, openRag, rejectsWithCode } from './helpers.js'

test('search ranks by exact dot product and honours k', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      doc('a', spaceId, [
        ['low', [0.1, 0, 0]],
        ['high', [0.9, 0, 0]]
      ]),
      doc('b', spaceId, [['mid', [0.5, 0, 0]]])
    ]
  })

  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 2 })
  t.alike(
    hits.map((hit) => hit.content),
    ['high', 'mid']
  )
  t.ok(Math.abs(hits[0].score - 0.9) < 1e-6, 'score is the dot product')
  t.is(hits[0].chunkId, 'a:1')
  t.is(hits[0].ordinal, 1)
  t.is(hits[0].namespace, 'ns')
})

test('cosine spaces normalise both sides', async (t) => {
  const { rag } = await openRag(t, [])
  const { spaceId } = await rag.createNamespace({
    name: 'cos',
    space: { ...SPACE, metric: 'cosine', normalized: false }
  })
  await rag.ingest({
    namespace: 'cos',
    documents: [
      doc('a', spaceId, [
        ['long', [10, 10, 0]],
        ['aligned', [0.1, 0, 0]]
      ])
    ]
  })

  const hits = await rag.search({ scope: { namespace: 'cos' }, vector: [2, 0, 0], spaceId, k: 2 })
  t.is(hits[0].content, 'aligned', 'direction wins over magnitude')
  t.ok(Math.abs(hits[0].score - 1) < 1e-6)
})

test('documentIds scope ranks only allowed chunks', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      doc('secret', spaceId, [
        ['best match', [1, 0, 0]],
        ['also good', [0.9, 0, 0]]
      ]),
      doc('public', spaceId, [
        ['weak', [0.1, 0, 0]],
        ['weaker', [0.05, 0, 0]]
      ])
    ]
  })

  const hits = await rag.search({
    scope: { namespace: 'ns', documentIds: ['public'] },
    vector: [1, 0, 0],
    spaceId,
    k: 2
  })
  t.alike(
    hits.map((hit) => hit.content),
    ['weak', 'weaker'],
    'top k is filled from the allowed document even though others score higher'
  )
})

test('namespaces do not see each other, including name prefixes', async (t) => {
  const { rag, spaceId } = await openRag(t, ['ns', 'ns2'])
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['in ns', [1, 0, 0]]])] })
  await rag.ingest({
    namespace: 'ns2',
    documents: [doc('a', spaceId, [['in ns2', [1, 0, 0]]]), doc('ab', spaceId, [['ab', [1, 0, 0]]])]
  })

  const query = { vector: [1, 0, 0], spaceId, k: 10 }
  t.alike(
    (await rag.search({ ...query, scope: { namespace: 'ns' } })).map((hit) => hit.content),
    ['in ns'],
    'ns does not pick up ns2 rows'
  )
  t.alike(
    (await rag.search({ ...query, scope: { namespace: 'ns2', documentIds: ['a'] } })).map(
      (hit) => hit.content
    ),
    ['in ns2'],
    'document a does not pick up document ab'
  )
})

test('search fails closed', async (t) => {
  const { rag, spaceId } = await openRag(t, ['ns', 'other'])
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  await rag.ingest({ namespace: 'other', documents: [doc('foreign', spaceId, [['f', [1, 0, 0]]])] })
  const query = { vector: [1, 0, 0], spaceId, k: 5 }

  await rejectsWithCode(
    t,
    rag.search({ ...query, scope: {} as never }),
    ERR_CODES.INVALID_SCOPE,
    'scope without namespace'
  )
  await rejectsWithCode(
    t,
    rag.search({ ...query, scope: undefined as never }),
    ERR_CODES.INVALID_SCOPE,
    'missing scope'
  )
  await rejectsWithCode(
    t,
    rag.search({ ...query, scope: { namespace: 'ns', documentId: 'a' } as never }),
    ERR_CODES.INVALID_SCOPE,
    'unknown scope key'
  )
  await rejectsWithCode(
    t,
    rag.search({ ...query, scope: { namespace: 'missing' } }),
    ERR_CODES.NAMESPACE_NOT_FOUND,
    'namespace that does not exist'
  )
  await rejectsWithCode(
    t,
    rag.search({ ...query, scope: { namespace: 'ns', documentIds: ['a', 'foreign'] } }),
    ERR_CODES.DOCUMENT_OUT_OF_SCOPE,
    'document from another namespace'
  )
  await rejectsWithCode(
    t,
    rag.search({ ...query, scope: { namespace: 'ns', documentIds: ['never-ingested'] } }),
    ERR_CODES.DOCUMENT_OUT_OF_SCOPE,
    'unknown document'
  )
  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, vector: [1, 0], spaceId, k: 5 }),
    ERR_CODES.EMBEDDING_DIMENSION_MISMATCH,
    'query of the wrong dimension'
  )
  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 0 }),
    ERR_CODES.INVALID_INPUT,
    'k of zero'
  )

  const empty = await rag.search({ ...query, scope: { namespace: 'ns', documentIds: [] } })
  t.alike(empty, [], 'documentIds: [] returns nothing')
})

test('a query from another embedding space is rejected even when dimensions match', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const other = await rag.createNamespace({
    name: 'other-model',
    space: { ...SPACE, model: 'other-embedder' }
  })
  t.not(other.spaceId, spaceId, 'the spaces differ only by model')
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })

  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId: other.spaceId, k: 5 }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'direct search'
  )
  await rejectsWithCode(
    t,
    rag.scoped({ namespace: 'ns' }).search({ vector: [1, 0, 0], spaceId: other.spaceId, k: 5 }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'scoped search'
  )
  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], k: 5 } as never),
    ERR_CODES.INVALID_INPUT,
    'a query without spaceId'
  )
  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 5 })
  t.is(hits.length, 1, 'the matching space still answers')
})

test('scan crosses batch boundaries without losing rows', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const total = SCAN_BATCH_SIZE * 2 + 7
  const chunks: Array<[string, number[]]> = []
  for (let i = 0; i < total; i++) chunks.push([`chunk ${i}`, [i / total, 0, 0]])
  await rag.ingest({ namespace: 'ns', documents: [doc('big', spaceId, chunks)] })

  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 3 })
  t.alike(
    hits.map((hit) => hit.ordinal),
    [total - 1, total - 2, total - 3]
  )
})

test('hits carry chunk metadataJson only when it was given', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      {
        id: 'a',
        chunks: [
          { content: 'with', metadataJson: '{"page":2}', embedding: [1, 0, 0], spaceId },
          { content: 'without', embedding: [0.5, 0, 0], spaceId }
        ]
      }
    ]
  })

  const [withMeta, withoutMeta] = await rag.search({
    scope: { namespace: 'ns' },
    vector: [1, 0, 0],
    spaceId,
    k: 2
  })
  t.is(withMeta.metadataJson, '{"page":2}')
  t.absent('metadataJson' in withoutMeta, 'no metadataJson key')
})

test('reusing an input buffer after the call does not change what was stored', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const buffer = new Float32Array([1, 0, 0])
  const pending = rag.ingest({
    namespace: 'ns',
    documents: [{ id: 'a', chunks: [{ content: 'a', embedding: buffer, spaceId }] }]
  })
  buffer.fill(0)
  await pending

  const query = new Float32Array([1, 0, 0])
  const searching = rag.search({ scope: { namespace: 'ns' }, vector: query, spaceId, k: 1 })
  query.fill(0)
  const [hit] = await searching
  t.is(hit.score, 1, 'both the stored vector and the query kept their values')
})

test('an aborted signal cancels the search', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const chunks: Array<[string, number[]]> = []
  for (let i = 0; i < SCAN_BATCH_SIZE * 2; i++) chunks.push([`chunk ${i}`, [1, 0, 0]])
  await rag.ingest({ namespace: 'ns', documents: [doc('big', spaceId, chunks)] })
  const query = { scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 1 }

  await rejectsWithCode(
    t,
    rag.search({ ...query, signal: { aborted: true } as AbortSignal }),
    ERR_CODES.OPERATION_CANCELLED,
    'already aborted'
  )

  // `aborted` is read by input validation, at scan entry, then once per scored
  // batch. Aborting on the fourth read means the first batch was scored and the
  // scan stopped at the check before the second.
  let checks = 0
  const midScan = {
    get aborted() {
      return ++checks > 3
    }
  } as AbortSignal
  await rejectsWithCode(
    t,
    rag.scoped({ namespace: 'ns' }).search({ vector: [1, 0, 0], spaceId, k: 1, signal: midScan }),
    ERR_CODES.OPERATION_CANCELLED,
    'aborted between batches'
  )
  t.is(checks, 4, 'the scan scored one batch before stopping')

  await rejectsWithCode(
    t,
    rag.search({ ...query, signal: 'stop' as never }),
    ERR_CODES.INVALID_INPUT,
    'a non-signal is rejected'
  )
})

test('hits carry the document metadata given at ingest', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      {
        ...doc('titled', spaceId, [
          ['a', [1, 0, 0]],
          ['b', [0.9, 0, 0]]
        ]),
        metadata: { title: 'Leave policy' }
      },
      doc('plain', spaceId, [['c', [0.8, 0, 0]]])
    ]
  })

  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 3 })
  t.alike(hits[0].documentMetadata, { title: 'Leave policy' })
  t.alike(hits[1].documentMetadata, { title: 'Leave policy' }, 'every chunk of the document')
  t.absent('documentMetadata' in hits[2], 'no key when the document had none')
})

test('a storage error during search surfaces as DB_OPERATION_FAILED', async (t) => {
  const { rag, store, spaceId } = await openRag(t)
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  await (store as unknown as { close(): Promise<void> }).close()

  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 1 }),
    ERR_CODES.DB_OPERATION_FAILED,
    'a read on a closed store'
  )
})
