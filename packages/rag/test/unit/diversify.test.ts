import test from 'brittle'

import { ERR_CODES } from '../../src/index.js'
import { doc, openRag, rejectsWithCode, useScan, type Test } from './helpers.js'
import type { EmbeddedDocumentInput, SearchHit } from '../../src/types.js'

const QUERY = [1, 0, 0]

// One chunk per score; a chunk's dot product with QUERY is its score.
function scored(id: string, spaceId: string, scores: number[]): EmbeddedDocumentInput {
  return doc(
    id,
    spaceId,
    scores.map((score, i) => [`${id}${i}`, [score, 0, 0]])
  )
}

function contents(hits: SearchHit[]): string[] {
  return hits.map((hit) => hit.content)
}

// Every behaviour must hold on the index path and on the scan path.
function both(name: string, run: (t: Test) => Promise<void>): void {
  test(`${name} (index)`, run)
  test(`${name} (scan)`, async (t) => {
    useScan(t)
    await run(t)
  })
}

both('perDocument seats every document before a second hit and caps each', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      scored('a', spaceId, [0.9, 0.8, 0.7]),
      scored('b', spaceId, [0.6, 0.5]),
      scored('c', spaceId, [0.4])
    ]
  })
  const scope = { namespace: 'ns' }

  const plain = await rag.search({ scope, vector: QUERY, spaceId, k: 4 })
  t.alike(contents(plain), ['a0', 'a1', 'a2', 'b0'], 'without perDocument: plain top k')

  const spread = await rag.search({ scope, vector: QUERY, spaceId, k: 4, perDocument: 2 })
  t.alike(contents(spread), ['a0', 'a1', 'b0', 'c0'], 'best of each first, then backfill, by score')

  const one = await rag.search({ scope, vector: QUERY, spaceId, k: 4, perDocument: 1 })
  t.alike(contents(one), ['a0', 'b0', 'c0'], 'fewer than k when the cap runs out')
})

both('perDocument looks past a document that fills the top candidates', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const big = Array.from({ length: 40 }, (_, i) => 0.99 - i * 0.015)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      scored('big', spaceId, big),
      scored('b', spaceId, [0.2]),
      scored('c', spaceId, [0.1])
    ]
  })

  const hits = await rag.search({
    scope: { namespace: 'ns' },
    vector: QUERY,
    spaceId,
    k: 3,
    perDocument: 1
  })
  t.alike(contents(hits), ['big0', 'b0', 'c0'])
})

both('every listed document gets a hit when there are at most k of them', async (t) => {
  const { rag, spaceId } = await openRag(t)
  // More than the index's first candidate window (pool plus its margin).
  const big = Array.from({ length: 40 }, (_, i) => 0.99 - i * 0.015)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      scored('big', spaceId, big),
      scored('small', spaceId, [0.05, 0.01]),
      scored('other', spaceId, [0.5])
    ]
  })

  const hits = await rag.search({
    scope: { namespace: 'ns', documentIds: ['big', 'small'] },
    vector: QUERY,
    spaceId,
    k: 2,
    perDocument: 2
  })
  t.alike(contents(hits), ['big0', 'small0'], 'small is seated, other stays out of scope')
})

both('ties order by scope order, then document ID and ordinal, every time', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [scored('z', spaceId, [0.5, 0.5]), scored('a', spaceId, [0.5, 0.5])]
  })
  const params = { vector: QUERY, spaceId, k: 3, perDocument: 2 }

  const keyOrder = await rag.search({ ...params, scope: { namespace: 'ns' } })
  t.alike(contents(keyOrder), ['a0', 'a1', 'z0'])
  const again = await rag.search({ ...params, scope: { namespace: 'ns' } })
  t.alike(contents(again), contents(keyOrder), 'same query, same hits')

  const listed = await rag.search({
    ...params,
    scope: { namespace: 'ns', documentIds: ['z', 'a'] }
  })
  t.alike(contents(listed), ['z0', 'z1', 'a0'], 'a document list orders ties by the list')
})

both('a scoped handle diversifies inside its bound scope only', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      scored('a', spaceId, [0.9, 0.8]),
      scored('b', spaceId, [0.7]),
      scored('secret', spaceId, [1])
    ]
  })
  const handle = rag.scoped({ namespace: 'ns', documentIds: ['a', 'b'] })

  const hits = await handle.search({ vector: QUERY, spaceId, k: 3, perDocument: 1 })
  t.alike(contents(hits), ['a0', 'b0'])
  const narrowed = await handle.search({
    scope: { documentIds: ['b', 'secret'] },
    vector: QUERY,
    spaceId,
    k: 3,
    perDocument: 1
  })
  t.alike(contents(narrowed), ['b0'], 'a request naming an ungranted document cannot reach it')
})

both('a cap far above the chunk count returns at once', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({ namespace: 'ns', documents: [scored('a', spaceId, [0.9])] })

  const hits = await rag.search({
    scope: { namespace: 'ns' },
    vector: QUERY,
    spaceId,
    k: 2,
    perDocument: 1_000_000_000
  })
  t.alike(contents(hits), ['a0'])
})

both('minScore drops hits below the floor before k applies', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({
    namespace: 'ns',
    documents: [scored('a', spaceId, [0.9, 0.5, 0.2]), scored('b', spaceId, [0.4, 0.1])]
  })
  const params = { scope: { namespace: 'ns' }, vector: QUERY, spaceId, k: 4 }

  const hits = await rag.search({ ...params, minScore: 0.4 })
  t.alike(contents(hits), ['a0', 'a1', 'b0'], 'a score equal to the floor is kept')
  t.alike(contents(await rag.search({ ...params, minScore: 2 })), [], 'nothing clears the floor')

  const handle = rag.scoped({ namespace: 'ns', documentIds: ['b'] })
  const scoped = await handle.search({ vector: QUERY, spaceId, k: 4, minScore: 0.3 })
  t.alike(contents(scoped), ['b0'], 'a scoped handle applies the floor too')
})

both('minScore with perDocument looks past a document above the floor', async (t) => {
  const { rag, spaceId } = await openRag(t)
  // 40 chunks from 0.99 down to 0.405, all above the floor.
  const big = Array.from({ length: 40 }, (_, i) => 0.99 - i * 0.015)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      scored('big', spaceId, big),
      scored('b', spaceId, [0.38]),
      scored('c', spaceId, [0.1])
    ]
  })
  const params = { vector: QUERY, spaceId, k: 3, perDocument: 1, minScore: 0.3 }

  const hits = await rag.search({ ...params, scope: { namespace: 'ns' } })
  t.alike(contents(hits), ['big0', 'b0'], 'c is below the floor')
  const again = await rag.search({ ...params, scope: { namespace: 'ns' } })
  t.alike(contents(again), contents(hits), 'same query, same hits')

  const listed = await rag.search({
    ...params,
    scope: { namespace: 'ns', documentIds: ['big', 'c'] }
  })
  t.alike(contents(listed), ['big0'], 'a listed document below the floor is not seated')
})

test('minScore must be a finite number', async (t) => {
  const { rag, spaceId } = await openRag(t)
  for (const minScore of [Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
    await rejectsWithCode(
      t,
      rag.search({
        scope: { namespace: 'ns' },
        vector: QUERY,
        spaceId,
        k: 2,
        minScore: minScore as number
      }),
      ERR_CODES.INVALID_INPUT,
      `minScore ${String(minScore)}`
    )
  }
})

test('perDocument must be a positive integer', async (t) => {
  const { rag, spaceId } = await openRag(t)
  for (const perDocument of [0, -1, 1.5]) {
    await rejectsWithCode(
      t,
      rag.search({ scope: { namespace: 'ns' }, vector: QUERY, spaceId, k: 2, perDocument }),
      ERR_CODES.INVALID_INPUT,
      `perDocument ${perDocument}`
    )
  }
})

both('hits carry generation, chunk count and citation fields', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const pdf: EmbeddedDocumentInput = {
    id: 'pdf',
    metadata: { title: 'Manual', sourceUrl: 'https://example.com/manual.pdf', mimeType: 7 },
    chunks: [
      {
        content: 'p3',
        embedding: [0.9, 0, 0],
        spaceId,
        metadataJson: JSON.stringify({ title: 'chunk title', page: 3, sourcePath: '/docs/m.pdf' })
      },
      { content: 'p0', embedding: [0.8, 0, 0], spaceId, metadataJson: '{"page":0}' },
      { content: 'bad', embedding: [0.7, 0, 0], spaceId, metadataJson: 'not json' }
    ]
  }
  await rag.ingest({ namespace: 'ns', documents: [pdf, scored('bare', spaceId, [0.1])] })
  const scope = { namespace: 'ns' }

  const hits = await rag.search({ scope, vector: QUERY, spaceId, k: 4 })
  t.is(hits[0].generation, 1)
  t.is(hits[0].chunkCount, 3)
  t.alike(
    hits[0].citation,
    {
      title: 'Manual',
      sourceUrl: 'https://example.com/manual.pdf',
      sourcePath: '/docs/m.pdf',
      page: 3
    },
    'document metadata wins, chunk metadata fills gaps, mistyped values are dropped'
  )
  t.alike(hits[1].citation, { title: 'Manual', sourceUrl: 'https://example.com/manual.pdf' })
  t.alike(hits[2].citation, hits[1].citation, 'unparsable chunk metadata adds nothing')
  t.alike(hits[3].citation, {}, 'no metadata, empty citation')
  t.is(hits[3].chunkCount, 1)

  await rag.ingest({
    namespace: 'ns',
    documents: [{ ...pdf, chunks: pdf.chunks.slice(0, 2) }]
  })
  const [replaced] = await rag.search({ scope, vector: QUERY, spaceId, k: 1 })
  t.is(replaced.generation, 2, 're-ingest bumps the generation')
  t.is(replaced.chunkCount, 2)
})
