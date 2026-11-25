import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'

import { ERR_CODES, createRag } from '../../src/index.js'
import { MAX_ROW_BYTES } from '../../src/limits.js'
import { SPACE, doc, fakePort, openRag, rejectsWithCode, type Test } from './helpers.js'
import type { Rag } from '../../src/types.js'

const LONE = 'cut \ud83d'

async function openWithPort(t: Test): Promise<{ rag: Rag; spaceId: string }> {
  const store = new Corestore(await tmp(t))
  const rag = createRag({ corestore: store, embeddings: fakePort() })
  await rag.ready()
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  t.teardown(async () => {
    await rag.close()
    await store.close()
  })
  return { rag, spaceId }
}

async function documentIds(rag: Rag): Promise<string[]> {
  const { documents } = await rag.listDocuments({ namespace: 'ns' })
  return documents.map((entry) => entry.documentId)
}

test('strings with a lone surrogate are rejected before anything is written', async (t) => {
  const { rag, spaceId } = await openWithPort(t)
  const fine = doc('fine', spaceId, [['fine', [1, 0, 0]]])
  const cases: Array<[string, unknown]> = [
    ['chunk content', doc('a', spaceId, [[LONE, [1, 0, 0]]])],
    ['document id', doc(`a${LONE}`, spaceId, [['a', [1, 0, 0]]])],
    ['chunk id', { id: 'a', chunks: [{ id: LONE, content: 'a', embedding: [1, 0, 0], spaceId }] }],
    ['chunk metadataJson', { id: 'a', chunks: [{ content: 'a', metadataJson: `"${LONE}"` }] }],
    ['text', { id: 'a', text: LONE }],
    ['metadata value', { id: 'a', text: 'a', metadata: { title: LONE } }],
    ['metadata key', { id: 'a', text: 'a', metadata: { [LONE]: 1 } }]
  ]
  for (const [what, input] of cases) {
    await rejectsWithCode(
      t,
      rag.ingest({ namespace: 'ns', documents: [fine, input as never] }),
      ERR_CODES.INVALID_INPUT,
      what
    )
  }
  t.alike(await documentIds(rag), [], 'no document was committed')

  // Both would be stored as 'x�' and replace each other.
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [
        doc('x\ud800', spaceId, [['one', [1, 0, 0]]]),
        doc('x\ud801', spaceId, [['two', [0, 1, 0]]])
      ]
    }),
    ERR_CODES.INVALID_INPUT,
    'ids that differ only in lone surrogates'
  )

  await rejectsWithCode(
    t,
    rag.createNamespace({ name: 'ns\ud800', space: SPACE }),
    ERR_CODES.INVALID_INPUT,
    'namespace name'
  )
  await rejectsWithCode(
    t,
    rag.createNamespace({ name: 'other', space: { ...SPACE, model: LONE } }),
    ERR_CODES.INVALID_INPUT,
    'space field'
  )
  await rejectsWithCode(
    t,
    rag.readDocument({ namespace: 'ns', documentId: 'fine\ud800' }),
    ERR_CODES.INVALID_INPUT,
    'read by document id'
  )
  await rejectsWithCode(
    t,
    rag.deleteDocuments({ namespace: 'ns', documentIds: ['fine\ud800'] }),
    ERR_CODES.INVALID_INPUT,
    'delete by document id'
  )
  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns\ud800' }, vector: [1, 0, 0], spaceId, k: 1 }),
    ERR_CODES.INVALID_SCOPE,
    'scope namespace'
  )
})

test('a surrogate pair is stored and read back as given', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const content = 'emoji 😀'
  await rag.ingest({
    namespace: 'ns',
    documents: [{ ...doc('😀', spaceId, [[content, [1, 0, 0]]]), metadata: { content } }]
  })
  const page = await rag.readDocument({ namespace: 'ns', documentId: '😀' })
  t.is(page.chunks[0].content, content)
  t.alike(page.metadata, { content })
})

test('rows over the size limit are rejected before any document in the call is written', async (t) => {
  const { rag, spaceId } = await openWithPort(t)
  const first = { id: 'first', text: 'small' }
  const big = 'a'.repeat(MAX_ROW_BYTES)

  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [first, doc('chunk', spaceId, [[big, [1, 0, 0]]])] }),
    ERR_CODES.INVALID_INPUT,
    'precomputed chunk',
    /row limit/
  )
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [first, { id: 'chunked', chunks: [{ content: big }] }]
    }),
    ERR_CODES.INVALID_INPUT,
    'pre-chunked chunk',
    /row limit/
  )
  // One unbroken word chunks to a single chunk of the whole text.
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [first, { id: 'text', text: big }] }),
    ERR_CODES.INVALID_INPUT,
    'chunked text',
    /row limit/
  )
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [first, { id: 'meta', text: 'x', metadata: { big } }]
    }),
    ERR_CODES.INVALID_INPUT,
    'document metadata',
    /row limit/
  )
  t.alike(await documentIds(rag), [], 'nothing was committed')

  const fits = 'b'.repeat(MAX_ROW_BYTES - 1024)
  await rag.ingest({ namespace: 'ns', documents: [doc('fits', spaceId, [[fits, [1, 0, 0]]])] })
  const page = await rag.readDocument({ namespace: 'ns', documentId: 'fits' })
  t.is(page.chunks[0].content.length, fits.length, 'a row just under the limit is stored')
})

test('metadata with a __proto__ key is rejected', async (t) => {
  const { rag } = await openWithPort(t)
  const metadata = JSON.parse('{"__proto__": {"x": 1}, "title": "t"}') as Record<string, unknown>
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [{ id: 'a', text: 'hello', metadata }] }),
    ERR_CODES.INVALID_INPUT,
    '__proto__ key',
    /__proto__/
  )
})

test('a signal without listener methods is rejected', async (t) => {
  const { rag } = await openWithPort(t)
  await rejectsWithCode(
    t,
    rag.ingest(
      { namespace: 'ns', documents: [{ id: 'a', text: 'hello' }] },
      { signal: { aborted: false } as AbortSignal }
    ),
    ERR_CODES.INVALID_INPUT,
    'ingest'
  )
  t.alike(await documentIds(rag), [])
})
