import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'

import { createRag, computeSpaceId, ERR_CODES } from '../../src/index.js'
import { SPACE, doc, openRag, rejectsWithCode } from './helpers.js'

test('createRag rejects a missing corestore', async (t) => {
  await rejectsWithCode(t, () => createRag({} as never), ERR_CODES.INVALID_INPUT, 'no corestore')
})

test('operations before ready and after close fail with NOT_READY', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())
  const rag = createRag({ corestore: store })

  await rejectsWithCode(
    t,
    rag.createNamespace({ name: 'ns', space: SPACE }),
    ERR_CODES.NOT_READY,
    'before ready'
  )

  await rag.ready()
  await rag.close()
  await rejectsWithCode(
    t,
    rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], k: 1 }),
    ERR_CODES.NOT_READY,
    'after close'
  )
  await rejectsWithCode(t, rag.ready(), ERR_CODES.NOT_READY, 'ready after close')
})

test('ready can be retried after the corestore fails to open', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())
  let failures = 1
  const flaky = {
    get: (options: { name: string }) => store.get(options),
    close: () => store.close(),
    ready: async () => {
      if (failures-- > 0) throw new Error('disk busy')
      await store.ready()
    }
  }
  const rag = createRag({ corestore: flaky })

  await t.exception(rag.ready(), /disk busy/, 'first open fails')
  await rag.ready()
  await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.close()
  t.pass('second ready() opened the database')
})

test('close leaves the caller-owned corestore open', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())
  const rag = createRag({ corestore: store })
  await rag.ready()
  await rag.close()

  const again = createRag({ corestore: store })
  await again.ready()
  await again.createNamespace({ name: 'ns', space: SPACE })
  await again.close()
  t.pass('a second RAG opens on the same corestore')
})

test('createNamespace pins the namespace to its embedding space', async (t) => {
  const { rag } = await openRag(t, [])

  const info = await rag.createNamespace({ name: 'ns', space: SPACE })
  t.is(info.name, 'ns')
  t.is(info.spaceId, computeSpaceId(SPACE), 'spaceId is the hash of the space')
  t.is(info.revision, 0)

  const again = await rag.createNamespace({ name: 'ns', space: { ...SPACE } })
  t.alike(again, info, 'same space is idempotent')

  await rejectsWithCode(
    t,
    rag.createNamespace({ name: 'ns', space: { ...SPACE, revision: '2' } }),
    ERR_CODES.NAMESPACE_EXISTS,
    'a different space for an existing name'
  )
})

test('spaceId changes with any field of the space, not only dimensions', (t) => {
  const base = computeSpaceId(SPACE)
  t.not(computeSpaceId({ ...SPACE, model: 'other' }), base, 'model')
  t.not(computeSpaceId({ ...SPACE, metric: 'cosine' }), base, 'metric')
  t.not(computeSpaceId({ ...SPACE, queryEncoding: 'query: ' }), base, 'query encoding')
  t.not(computeSpaceId({ ...SPACE, preprocessing: 'v2' }), base, 'preprocessing')
  t.is(computeSpaceId({ ...SPACE }), base, 'a copy hashes the same')
})

test('createNamespace validates the space', async (t) => {
  const { rag } = await openRag(t, [])
  await rejectsWithCode(
    t,
    rag.createNamespace({ name: 'ns', space: { ...SPACE, dimensions: 0 } }),
    ERR_CODES.INVALID_INPUT,
    'zero dimensions'
  )
  await rejectsWithCode(
    t,
    rag.createNamespace({ name: 'ns', space: { ...SPACE, extra: 1 } as never }),
    ERR_CODES.INVALID_INPUT,
    'unknown space field'
  )
  await rejectsWithCode(
    t,
    rag.createNamespace({ name: '', space: SPACE }),
    ERR_CODES.INVALID_INPUT,
    'empty name'
  )
})

test('data survives close and reopen', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())

  const first = createRag({ corestore: store })
  await first.ready()
  const { spaceId } = await first.createNamespace({ name: 'ns', space: SPACE })
  await first.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['hello', [1, 0, 0]]])] })
  await first.close()

  const second = createRag({ corestore: store })
  await second.ready()
  const hits = await second.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], k: 5 })
  t.is(hits.length, 1)
  t.is(hits[0].content, 'hello')
  await second.close()
})
