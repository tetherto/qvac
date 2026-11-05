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
    rag.search({
      scope: { namespace: 'ns' },
      vector: [1, 0, 0],
      spaceId: computeSpaceId(SPACE),
      k: 1
    }),
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

  await rejectsWithCode(
    t,
    rag.ready(),
    ERR_CODES.DB_OPERATION_FAILED,
    'a Corestore error is wrapped',
    /disk busy/
  )
  await rag.ready()
  await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.close()
  t.pass('second ready() opened the database')
})

interface FailableCore {
  closed: boolean
  snapshot(...args: unknown[]): { ready(): Promise<void> }
}

test('a HyperDB that fails to open is closed before ready() retries', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())
  const failed: FailableCore[] = []
  const flaky = {
    ready: () => store.ready(),
    close: () => store.close(),
    get: (options: { name: string }) => {
      const core = store.get(options) as unknown as FailableCore
      if (failed.length === 0) {
        const snapshot = core.snapshot.bind(core)
        core.snapshot = (...args) => {
          const session = snapshot(...args)
          session.ready = () => Promise.reject(new Error('bad core'))
          return session
        }
        failed.push(core)
      }
      return core as never
    }
  }
  const rag = createRag({ corestore: flaky })

  await rejectsWithCode(
    t,
    rag.ready(),
    ERR_CODES.DB_OPERATION_FAILED,
    'a HyperDB open error is wrapped',
    /bad core/
  )
  t.ok(failed[0].closed, 'the failed instance released its core')
  await rag.ready()
  await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.close()
})

test('close waits for in-flight calls to finish', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())
  const rag = createRag({ corestore: store })
  await rag.ready()
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })

  const documents = []
  for (let i = 0; i < 20; i++) documents.push(doc(`d${i}`, spaceId, [[`text ${i}`, [1, 0, 0]]]))
  const ingesting = rag.ingest({ namespace: 'ns', documents })
  const searching = rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 1 })
  await rag.close()

  const result = await ingesting
  t.is(result.documents.length, 20, 'every document committed before close returned')
  t.ok(Array.isArray(await searching), 'the search started before close completed')

  const reopened = createRag({ corestore: store })
  await reopened.ready()
  const hits = await reopened.search({
    scope: { namespace: 'ns' },
    vector: [1, 0, 0],
    spaceId,
    k: 50
  })
  t.is(hits.length, 20)
  await reopened.close()
})

test('a second close waits for the first to drain', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())
  const rag = createRag({ corestore: store })
  await rag.ready()
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })

  const documents = []
  for (let i = 0; i < 20; i++) documents.push(doc(`d${i}`, spaceId, [[`text ${i}`, [1, 0, 0]]]))
  let ingested = false
  const ingesting = rag.ingest({ namespace: 'ns', documents }).then((result) => {
    ingested = true
    return result
  })
  const first = rag.close()
  await rag.close()

  t.ok(ingested, 'the ingest finished before the second close returned')
  await first
  await ingesting
})

test('two instances on the same core share one writer', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())
  const session = store.session()
  t.teardown(() => session.close())
  const a = createRag({ corestore: store })
  const b = createRag({ corestore: session })
  await Promise.all([a.ready(), b.ready()])
  const { spaceId } = await a.createNamespace({ name: 'ns', space: SPACE })

  await Promise.all([
    a.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['from a', [1, 0, 0]]])] }),
    b.ingest({ namespace: 'ns', documents: [doc('b', spaceId, [['from b', [1, 0, 0]]])] })
  ])
  const query = { scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 10 }
  const ids = (hits: { documentId: string }[]) => hits.map((hit) => hit.documentId).sort()
  t.alike(ids(await a.search(query)), ['a', 'b'], 'both writes are visible through a')
  t.alike(ids(await b.search(query)), ['a', 'b'], 'both writes are visible through b')

  await a.close()
  t.alike(ids(await b.search(query)), ['a', 'b'], 'b keeps working after a closes')
  await b.close()

  const reopened = createRag({ corestore: store })
  await reopened.ready()
  t.alike(ids(await reopened.search(query)), ['a', 'b'], 'both writes survive reopen')
  await reopened.close()
})

test('stores in separate directories stay separate when their cores share a key', async (t) => {
  const primaryKey = new Uint8Array(32).fill(7)
  const first = new Corestore(await tmp(t), { primaryKey, unsafe: true })
  const second = new Corestore(await tmp(t), { primaryKey, unsafe: true })
  t.teardown(() => first.close())
  t.teardown(() => second.close())

  async function write(store: typeof first, documentId: string) {
    const rag = createRag({ corestore: store })
    await rag.ready()
    const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
    await rag.ingest({ namespace: 'ns', documents: [doc(documentId, spaceId, [['x', [1, 0, 0]]])] })
    return rag
  }
  async function read(rag: Awaited<ReturnType<typeof write>>) {
    const query = { scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId: computeSpaceId(SPACE) }
    return (await rag.search({ ...query, k: 10 })).map((hit) => hit.documentId)
  }

  const a = await write(first, 'a')
  const b = await write(second, 'b')
  t.alike(await read(a), ['a'], 'the first directory holds only its document')
  t.alike(await read(b), ['b'], 'the second directory holds only its document')
  await a.close()
  await b.close()

  const reopened = createRag({ corestore: second })
  await reopened.ready()
  t.alike(await read(reopened), ['b'], 'the write landed in the second directory')
  await reopened.close()
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
    'zero dimensions',
    /space\.dimensions:/
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
  const hits = await second.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 5 })
  t.is(hits.length, 1)
  t.is(hits[0].content, 'hello')
  await second.close()
})
