import test from 'brittle'
import { AbortController } from 'bare-abort-controller'
import tmp from 'test-tmp'
import Corestore from 'corestore'
import { chunkRagDocuments } from 'rag-extract/chunk'

import { ERR_CODES, computeSpaceId, createRag } from '../../src/index.js'
import { EMBED_BATCH_SIZE } from '../../src/embeddings.js'
import { decodeVectorInto } from '../../src/db/encoding.js'
import { CHUNKS, DOCUMENTS, type ChunkRecord, type DocumentRecord } from '../../src/db/records.js'
import { SPACE, inspect, rejectsWithCode, type Test } from './helpers.js'
import type { EmbeddingSpace, EmbeddingsPort, IngestProgress, Rag } from '../../src/types.js'
import type { Corestore as Store } from '../../src/db/db-types.js'

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  return controller.signal as AbortSignal
}

const ALL_NS = { gte: { namespace: 'ns' }, lte: { namespace: 'ns' } }
const WORDS = ['cat', 'dog', 'fish']

// One dimension per keyword, so a query ranks the chunks that mention it.
function embed(text: string): number[] {
  const lower = text.toLowerCase()
  return WORDS.map((word) => (lower.includes(word) ? 1 : 0))
}

interface FakePort extends EmbeddingsPort {
  batches: string[][]
  queries: string[]
}

function fakePort(
  space: EmbeddingSpace = SPACE,
  onBatch?: (batch: number, signal?: AbortSignal) => void
): FakePort {
  const port: FakePort = {
    space,
    batches: [],
    queries: [],
    embedDocuments(texts, options) {
      port.batches.push(texts)
      try {
        onBatch?.(port.batches.length, options?.signal)
      } catch (error) {
        return Promise.reject(error)
      }
      return Promise.resolve(Float32Array.from(texts.flatMap(embed)))
    },
    embedQuery(text) {
      port.queries.push(text)
      return Promise.resolve(Float32Array.from(embed(text)))
    }
  }
  return port
}

async function openWithPort(
  t: Test,
  port?: EmbeddingsPort
): Promise<{ rag: Rag; store: Store; spaceId: string }> {
  const store = new Corestore(await tmp(t))
  const rag = createRag({ corestore: store, embeddings: port })
  await rag.ready()
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  t.teardown(async () => {
    await rag.close()
    await store.close()
  })
  return { rag, store, spaceId }
}

function chunkedDoc(id: string, count: number, word = 'cat') {
  return {
    id,
    chunks: Array.from({ length: count }, (_, i) => ({ content: `${word} ${id} ${i}` }))
  }
}

function vectorOf(chunk: ChunkRecord): number[] {
  const out = new Float32Array(SPACE.dimensions)
  decodeVectorInto(chunk.vector, out, 0)
  return Array.from(out)
}

const LONG_TEXT = Array.from({ length: 400 }, (_, i) => (i % 50 === 0 ? 'cat' : `word${i}`)).join(
  ' '
)

test('text documents are chunked with rag-extract defaults and embedded through the port', async (t) => {
  const port = fakePort()
  const { rag, store } = await openWithPort(t, port)

  const expected = chunkRagDocuments([{ id: 'long', title: '', content: LONG_TEXT }], {})
  t.ok(expected.length > 1, 'the text spans several chunks')

  const result = await rag.ingest({
    namespace: 'ns',
    documents: [
      { id: 'long', text: LONG_TEXT, metadata: { title: 'Long' } },
      { id: 'short', text: 'A dog sat.' }
    ]
  })
  t.alike(result, {
    documents: [
      { id: 'long', generation: 1, chunkCount: expected.length },
      { id: 'short', generation: 1, chunkCount: 1 }
    ],
    skipped: [],
    cancelled: false,
    revision: 2
  })
  t.is(port.batches.length, 1, 'all chunks fit one batch')
  t.is(port.batches[0].length, expected.length + 1)
  await rag.close()

  await inspect(store, async (reader) => {
    const chunks = await reader.find<ChunkRecord>(CHUNKS, ALL_NS).toArray()
    const long = chunks.filter((chunk) => chunk.documentId === 'long')
    t.alike(
      long.map((chunk) => chunk.chunkId),
      expected.map((chunk) => chunk.id),
      'chunk ids are <documentId>:<index>'
    )
    t.alike(
      long.map((chunk) => chunk.content),
      expected.map((chunk) => chunk.content)
    )
    const metadata = JSON.parse(long[1].metadataJson as string)
    t.is(metadata.documentId, 'long')
    t.is(metadata.chunkIndex, 1)
    const short = chunks.find((chunk) => chunk.documentId === 'short') as ChunkRecord
    t.alike(vectorOf(short), [0, 1, 0], 'the stored vector is the port output')

    const document = await reader.get<DocumentRecord>(DOCUMENTS, {
      namespace: 'ns',
      documentId: 'long'
    })
    t.alike(document?.metadata, { title: 'Long' })
  })
})

test('pre-chunked documents keep their segmentation and chunk ids', async (t) => {
  const { rag, store } = await openWithPort(t, fakePort())

  await rag.ingest({
    namespace: 'ns',
    documents: [
      {
        id: 'a',
        chunks: [
          { id: 'intro', content: 'cat intro', metadataJson: '{"page":1}' },
          { content: 'dog body' },
          { id: 'outro', content: 'fish outro' }
        ]
      }
    ]
  })
  await rag.close()

  await inspect(store, async (reader) => {
    const chunks = await reader.find<ChunkRecord>(CHUNKS, ALL_NS).toArray()
    t.alike(
      chunks.map((chunk) => [chunk.chunkId, chunk.ordinal, chunk.content]),
      [
        ['intro', 0, 'cat intro'],
        ['a:1', 1, 'dog body'],
        ['outro', 2, 'fish outro']
      ]
    )
    t.is(chunks[0].metadataJson, '{"page":1}')
    t.absent(chunks[1].metadataJson)
    t.alike(vectorOf(chunks[2]), [0, 0, 1])
  })
})

test('a rag-extract chunk list goes in as-is and round-trips unchanged', async (t) => {
  const { rag, store } = await openWithPort(t, fakePort())
  const chunks = chunkRagDocuments(
    [{ id: 'guide', title: 'Guide', content: LONG_TEXT, sourcePath: '/docs/guide.md' }],
    { chunkSize: 64, chunkOverlap: 8 }
  )

  await rag.ingest({ namespace: 'ns', documents: [{ id: 'guide', chunks: [...chunks] }] })
  const hits = await rag.search({ scope: { namespace: 'ns' }, query: 'cat', k: chunks.length })
  t.alike(
    hits
      .filter((hit) => hit.score > 0)
      .map((hit) => hit.chunkId)
      .sort(),
    chunks
      .filter((chunk) => chunk.content.includes('cat'))
      .map((chunk) => chunk.id)
      .sort()
  )
  await rag.close()

  await inspect(store, async (reader) => {
    const stored = await reader.find<ChunkRecord>(CHUNKS, ALL_NS).toArray()
    t.alike(
      stored.map((chunk) => ({
        id: chunk.chunkId,
        content: chunk.content,
        metadataJson: chunk.metadataJson
      })),
      chunks.map((chunk) => ({
        id: chunk.id,
        content: chunk.content,
        metadataJson: chunk.metadataJson
      }))
    )
  })
})

test('text query search embeds with the port and takes its spaceId', async (t) => {
  const port = fakePort()
  const { rag, spaceId } = await openWithPort(t, port)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      { id: 'cats', text: 'All about the cat.' },
      { id: 'dogs', text: 'All about the dog.' },
      {
        id: 'fish',
        chunks: [{ content: 'fish', embedding: [0, 0, 1], spaceId }]
      }
    ]
  })

  const hits = await rag.search({ scope: { namespace: 'ns' }, query: 'dog', k: 1 })
  t.alike(
    hits.map((hit) => hit.documentId),
    ['dogs']
  )
  t.alike(port.queries, ['dog'])

  const fish = await rag.search({ scope: { namespace: 'ns' }, query: 'fish', k: 1 })
  t.is(fish[0].documentId, 'fish', 'precomputed chunks are searchable by text')

  const reader = rag.scoped({ namespace: 'ns', documentIds: ['cats', 'fish'] })
  const scoped = await reader.search({ query: 'dog', k: 3 })
  t.ok(
    scoped.every((hit) => hit.documentId !== 'dogs'),
    'scoped text search stays in scope'
  )

  port.queries.length = 0
  t.alike(await rag.search({ scope: { namespace: 'ns', documentIds: [] }, query: 'dog', k: 1 }), [])
  t.alike(await reader.search({ query: 'dog', k: 1, scope: { documentIds: ['dogs'] } }), [])
  t.is(port.queries.length, 0, 'an empty scope never calls the port')
  await rejectsWithCode(
    t,
    rag.search({
      scope: { namespace: 'ns', documentIds: [] },
      query: 'dog',
      k: 1,
      signal: abortedSignal()
    }),
    ERR_CODES.OPERATION_CANCELLED,
    'an aborted empty text search'
  )

  const vector = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 1 })
  t.is(vector[0].documentId, 'cats', 'vector search still works')

  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], k: 1 } as never),
    ERR_CODES.INVALID_INPUT,
    'vector search still needs spaceId'
  )
  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, query: 'dog', spaceId, k: 1 } as never),
    ERR_CODES.INVALID_INPUT,
    'a text query takes no spaceId'
  )
  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, query: '', k: 1 }),
    ERR_CODES.INVALID_INPUT,
    'an empty query is rejected'
  )
})

test('a port in another space is rejected before anything is embedded', async (t) => {
  const other = fakePort({ ...SPACE, model: 'other-embedder' })
  t.not(computeSpaceId(other.space), computeSpaceId(SPACE))
  const { rag, store } = await openWithPort(t, other)

  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [{ id: 'a', text: 'cat' }] }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'text ingest'
  )
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [chunkedDoc('b', 1)] }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'pre-chunked ingest'
  )
  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, query: 'cat', k: 1 }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'query search'
  )
  t.is(other.batches.length, 0, 'no documents were embedded')
  t.is(other.queries.length, 0, 'no query was embedded')
  await rag.close()

  await inspect(store, async (reader) => {
    t.is((await reader.find<ChunkRecord>(CHUNKS, ALL_NS).toArray()).length, 0)
  })
})

test('without a port, text input fails and vectors keep working', async (t) => {
  const { rag, spaceId } = await openWithPort(t)

  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [{ id: 'a', text: 'cat' }] }),
    ERR_CODES.DEPENDENCY_REQUIRED,
    'text ingest'
  )
  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, query: 'cat', k: 1 }),
    ERR_CODES.DEPENDENCY_REQUIRED,
    'query search'
  )
  const result = await rag.ingest({
    namespace: 'ns',
    documents: [{ id: 'v', chunks: [{ content: 'cat', embedding: [1, 0, 0], spaceId }] }]
  })
  t.is(result.documents.length, 1, 'precomputed ingest needs no port')
})

test('invalid text input fails before anything is written', async (t) => {
  const port = fakePort()
  const { rag, store, spaceId } = await openWithPort(t, port)

  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [
        { id: 'ok', text: 'cat' },
        { id: 'blank', text: '   ' }
      ]
    }),
    ERR_CODES.INVALID_INPUT,
    'text with nothing to chunk',
    /blank/
  )
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [
        {
          id: 'mixed',
          chunks: [{ content: 'cat', embedding: [1, 0, 0], spaceId }, { content: 'dog' }] as never
        }
      ]
    }),
    ERR_CODES.INVALID_INPUT,
    'chunks mixing precomputed and port embeddings'
  )
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [{ id: 'x', chunks: [{ content: 'cat', page: 1 }] }]
    } as never),
    ERR_CODES.INVALID_INPUT,
    'unknown chunk keys'
  )
  t.is(port.batches.length, 0)
  await rag.close()

  await inspect(store, async (reader) => {
    t.is((await reader.find<ChunkRecord>(CHUNKS, ALL_NS).toArray()).length, 0)
  })
})

test('port failures surface as EMBEDDING_FAILED and keep earlier documents', async (t) => {
  const port = fakePort(SPACE, (batch) => {
    if (batch === 2) throw new Error('model crashed')
  })
  const { rag, store } = await openWithPort(t, port)

  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [chunkedDoc('a', EMBED_BATCH_SIZE), chunkedDoc('b', 1)]
    }),
    ERR_CODES.EMBEDDING_FAILED,
    'the port threw',
    /model crashed/
  )
  await rag.close()

  await inspect(store, async (reader) => {
    const chunks = await reader.find<ChunkRecord>(CHUNKS, ALL_NS).toArray()
    t.alike(Array.from(new Set(chunks.map((chunk) => chunk.documentId))), ['a'])
  })
})

test('a port returning the wrong number of values is rejected', async (t) => {
  const port: EmbeddingsPort = {
    space: SPACE,
    embedDocuments: () => Promise.resolve(new Float32Array(2)),
    embedQuery: () => Promise.resolve(new Float32Array(2))
  }
  const { rag } = await openWithPort(t, port)
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [{ id: 'a', text: 'cat' }] }),
    ERR_CODES.EMBEDDING_DIMENSION_MISMATCH,
    'ingest'
  )
  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, query: 'cat', k: 1 }),
    ERR_CODES.EMBEDDING_DIMENSION_MISMATCH,
    'query'
  )
})

test('aborting mid-ingest keeps committed documents and reports the skipped ones', async (t) => {
  const controller = new AbortController()
  const port = fakePort(SPACE, (batch) => {
    if (batch === 2) controller.abort(new Error('stop'))
  })
  const { rag, store } = await openWithPort(t, port)
  const before = await rag.ingest({ namespace: 'ns', documents: [chunkedDoc('old', 1, 'fish')] })
  port.batches.length = 0

  const result = await rag.ingest(
    {
      namespace: 'ns',
      documents: [
        chunkedDoc('a', EMBED_BATCH_SIZE),
        chunkedDoc('b', EMBED_BATCH_SIZE),
        chunkedDoc('c', EMBED_BATCH_SIZE)
      ]
    },
    { signal: controller.signal as AbortSignal }
  )
  t.alike(result, {
    documents: [{ id: 'a', generation: 1, chunkCount: EMBED_BATCH_SIZE }],
    skipped: ['b', 'c'],
    cancelled: true,
    revision: before.revision + 1
  })
  t.is(port.batches.length, 2, 'no batch is sent after the abort')

  const hits = await rag.search({ scope: { namespace: 'ns' }, query: 'cat', k: 100 })
  const matched = hits.filter((hit) => hit.score > 0).map((hit) => hit.documentId)
  t.alike(Array.from(new Set(matched)), ['a'])
  await rag.close()

  await inspect(store, async (reader) => {
    const documents = await reader.find<DocumentRecord>(DOCUMENTS, ALL_NS).toArray()
    t.alike(documents.map((document) => document.documentId).sort(), ['a', 'old'])
  })
})

test('a port that rejects on abort is a cancellation, and a pre-aborted signal writes nothing', async (t) => {
  const controller = new AbortController()
  const port = fakePort(SPACE, (batch, signal) => {
    if (batch === 2) {
      controller.abort(new Error('stop'))
      if (signal?.aborted) throw new Error('aborted')
    }
  })
  const { rag } = await openWithPort(t, port)

  const result = await rag.ingest(
    {
      namespace: 'ns',
      documents: [chunkedDoc('a', EMBED_BATCH_SIZE), chunkedDoc('b', 1)]
    },
    { signal: controller.signal as AbortSignal }
  )
  t.is(result.cancelled, true)
  t.alike(
    result.documents.map((document) => document.id),
    ['a']
  )
  t.alike(result.skipped, ['b'])

  const aborted = await rag.ingest(
    { namespace: 'ns', documents: [{ id: 'c', text: 'cat' }] },
    { signal: abortedSignal() }
  )
  t.alike(aborted, { documents: [], skipped: ['c'], cancelled: true, revision: result.revision })

  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, query: 'cat', k: 1, signal: abortedSignal() }),
    ERR_CODES.OPERATION_CANCELLED,
    'an aborted query search'
  )
})

test('progress reports chunk, then embed batches, with each commit after its chunks', async (t) => {
  const { rag, spaceId } = await openWithPort(t, fakePort())
  const events: IngestProgress[] = []

  await rag.ingest(
    {
      namespace: 'ns',
      documents: [
        { id: 'v', chunks: [{ content: 'fish', embedding: [0, 0, 1], spaceId }] },
        { id: 't1', text: 'cat' },
        chunkedDoc('big', EMBED_BATCH_SIZE + 1),
        { id: 't2', text: 'dog' }
      ]
    },
    { onProgress: (progress) => events.push({ ...progress }) }
  )

  const embedTotal = EMBED_BATCH_SIZE + 3
  t.alike(events, [
    { stage: 'chunk', done: 1, total: 2 },
    { stage: 'chunk', done: 2, total: 2 },
    { stage: 'commit', done: 1, total: 4 },
    { stage: 'embed', done: EMBED_BATCH_SIZE, total: embedTotal },
    { stage: 'commit', done: 2, total: 4 },
    { stage: 'embed', done: embedTotal, total: embedTotal },
    { stage: 'commit', done: 3, total: 4 },
    { stage: 'commit', done: 4, total: 4 }
  ])
})

test('createRag rejects a malformed port', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())
  await rejectsWithCode(
    t,
    () => createRag({ corestore: store, embeddings: { space: SPACE } as never }),
    ERR_CODES.INVALID_INPUT,
    'missing methods'
  )
  await rejectsWithCode(
    t,
    () =>
      createRag({
        corestore: store,
        embeddings: { ...fakePort(), space: { ...SPACE, dimensions: 0 } }
      }),
    ERR_CODES.INVALID_INPUT,
    'invalid space'
  )
})
