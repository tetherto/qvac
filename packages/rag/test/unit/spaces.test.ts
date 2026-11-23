import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'

import { ERR_CODES, createRag } from '../../src/index.js'
import { SPACE, doc, fakePort, openRag, rejectsWithCode, type Test } from './helpers.js'
import type { EmbeddingsPort, Rag } from '../../src/types.js'
import type { Corestore as Store } from '../../src/db/db-types.js'

// Same dimensions as SPACE; only the model differs.
const OTHER_SPACE = { ...SPACE, model: 'other-embedder' }

async function openStore(t: Test): Promise<Store> {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close(), { order: 1 })
  return store
}

async function openWithPort(t: Test, store: Store, port: EmbeddingsPort): Promise<Rag> {
  const rag = createRag({ corestore: store, embeddings: port })
  await rag.ready()
  await rag.createNamespace({ name: 'ns', space: SPACE })
  t.teardown(() => rag.close())
  return rag
}

test('vectors from another space with the same dimensions are rejected', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const other = await rag.createNamespace({ name: 'other', space: OTHER_SPACE })
  t.not(other.spaceId, spaceId)

  await rag.ingest({ namespace: 'other', documents: [doc('a', other.spaceId, [['a', [1, 0, 0]]])] })
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [doc('a', other.spaceId, [['a', [1, 0, 0]]])] }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    "another namespace's vectors"
  )

  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  await rejectsWithCode(
    t,
    rag.ingest({ namespace: 'ns', documents: [doc('a', other.spaceId, [['a', [1, 0, 0]]])] }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'the same content re-ingested from another space'
  )
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [
        { id: 'a', spaceId: other.spaceId, chunks: [{ content: 'a', embedding: [1, 0, 0] }] }
      ]
    }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'the document spaceId fallback'
  )
})

test('unchanged text is still rejected when the port moved to another space', async (t) => {
  const store = await openStore(t)
  const rag = await openWithPort(t, store, fakePort())
  await rag.ingest({
    namespace: 'ns',
    documents: [
      { id: 'a', text: 'cat' },
      { id: 'b', chunks: [{ content: 'dog' }] }
    ]
  })
  await rag.close()

  const port = fakePort(OTHER_SPACE)
  const moved = createRag({ corestore: store, embeddings: port })
  await moved.ready()
  t.teardown(() => moved.close())
  await rejectsWithCode(
    t,
    moved.ingest({ namespace: 'ns', documents: [{ id: 'a', text: 'cat' }] }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'text'
  )
  await rejectsWithCode(
    t,
    moved.ingest({ namespace: 'ns', documents: [{ id: 'b', chunks: [{ content: 'dog' }] }] }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'pre-chunked'
  )
  await rejectsWithCode(
    t,
    moved.scoped({ namespace: 'ns' }).search({ query: 'cat', k: 1 }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'scoped text query'
  )
  await rejectsWithCode(
    t,
    moved.scoped({ namespace: 'ns', documentIds: [] }).search({ query: 'cat', k: 1 }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'even when the scope is empty'
  )
  t.is(port.batches.length, 0, 'nothing was embedded')
  t.is(port.queries.length, 0, 'no query was embedded')
})
