import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'
import fs from 'bare-fs'

import { ERR_CODES, computeSpaceId, createRag } from '../../src/index.js'
import { SPACE, doc, rejectsWithCode, type Test } from './helpers.js'
import type { IndexOptions, Rag } from '../../src/types.js'

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = []
  for await (const part of stream) parts.push(part)
  return parts
}

async function* replay(parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* parts
}

interface Setup {
  store: InstanceType<typeof Corestore>
  dir: string
  open(index?: IndexOptions): Promise<Rag>
}

async function setup(t: Test): Promise<Setup> {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close(), { order: 1 })
  const dir = await tmp(t)
  return {
    store,
    dir,
    async open(index = {}) {
      const rag = createRag({ corestore: store, index: { dir, ...index } })
      await rag.ready()
      t.teardown(() => rag.close())
      return rag
    }
  }
}

function snapshotFiles(dir: string): string[] {
  const files: string[] = []
  if (!fs.existsSync(dir)) return files
  for (const coreDir of fs.readdirSync(dir)) files.push(...fs.readdirSync(`${dir}/${coreDir}`))
  return files
}

const spaceId = computeSpaceId(SPACE)

test('listNamespaces reports space, index, revision and counts', async (t) => {
  const { open } = await setup(t)
  const rag = await open()
  t.alike(await rag.listNamespaces(), [])

  await rag.createNamespace({ name: 'b', space: SPACE })
  await rag.createNamespace({ name: 'a', space: SPACE, index: { storage: 'f32' } })
  await rag.ingest({
    namespace: 'a',
    documents: [
      doc('x', spaceId, [
        ['x0', [1, 0, 0]],
        ['x1', [0, 1, 0]]
      ]),
      doc('y', spaceId, [['y0', [0, 0, 1]]])
    ]
  })
  await rag.deleteDocuments({ namespace: 'a', documentIds: ['y'] })

  t.alike(await rag.listNamespaces(), [
    {
      name: 'a',
      spaceId,
      space: SPACE,
      index: { storage: 'f32' },
      vectorEncoding: 'f32',
      revision: 3,
      documentCount: 1,
      chunkCount: 2
    },
    {
      name: 'b',
      spaceId,
      space: SPACE,
      index: { storage: 'q8' },
      vectorEncoding: 'f32',
      revision: 0,
      documentCount: 0,
      chunkCount: 0
    }
  ])
})

test('dropNamespace removes everything, and only importing an earlier export brings it back', async (t) => {
  const { store, dir, open } = await setup(t)
  const rag = await open({ snapshotEvery: 1 })
  await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.createNamespace({ name: 'keep', space: SPACE })
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
  await rag.ingest({ namespace: 'keep', documents: [doc('k', spaceId, [['k0', [1, 0, 0]]])] })
  const query = { vector: [1, 0, 0], spaceId, k: 5 }
  t.is((await rag.search({ ...query, scope: { namespace: 'ns' } })).length, 3)
  const backup = await collect(rag.exportNamespace({ namespace: 'ns' }))
  const indexed = snapshotFiles(dir).length

  const dropped = await rag.dropNamespace({ name: 'ns' })
  t.alike(dropped, { name: 'ns', documentCount: 2, chunkCount: 3 })
  t.alike(
    (await rag.listNamespaces()).map((ns) => ns.name),
    ['keep']
  )
  await rejectsWithCode(
    t,
    rag.search({ ...query, scope: { namespace: 'ns' } }),
    ERR_CODES.NAMESPACE_NOT_FOUND,
    'search after drop'
  )
  await rejectsWithCode(
    t,
    rag.dropNamespace({ name: 'ns' }),
    ERR_CODES.NAMESPACE_NOT_FOUND,
    'drop twice'
  )
  t.ok(indexed > 0, 'both namespaces have snapshots')
  t.ok(snapshotFiles(dir).length < indexed, 'the dropped namespace snapshot is deleted')

  await rag.close()
  const reopened = await open({ snapshotEvery: 1 })
  t.alike(
    (await reopened.listNamespaces()).map((ns) => ns.name),
    ['keep'],
    'nothing comes back on reopen'
  )

  const created = await reopened.createNamespace({ name: 'ns', space: SPACE })
  t.is(created.revision, 0)
  t.alike((await reopened.listDocuments({ namespace: 'ns' })).documents, [], 'starts empty')
  t.alike(await reopened.search({ ...query, scope: { namespace: 'ns' } }), [])

  const restored = await reopened.importNamespace({ namespace: 'ns', source: replay(backup) })
  t.alike(
    restored.documents.map((entry) => [entry.id, entry.status]),
    [
      ['a', 'created'],
      ['b', 'created']
    ],
    'an export from before the drop restores into the re-created namespace'
  )
  t.is((await reopened.search({ ...query, scope: { namespace: 'ns' } })).length, 3)

  const copy = await reopened.importNamespace({ namespace: 'elsewhere', source: replay(backup) })
  t.is(copy.documents.length, 2, 'and under another name')
  t.alike(
    (await reopened.listNamespaces()).map((ns) => ns.name),
    ['elsewhere', 'keep', 'ns']
  )

  await reopened.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['new', [1, 0, 0]]])] })
  const [hit] = await reopened.search({ ...query, scope: { namespace: 'ns' } })
  t.is(hit.content, 'new')
  t.is(hit.documentId, 'a')
  t.ok(store, 'same store throughout')
})

test('dropNamespace and the transfer calls are not on scoped handles', async (t) => {
  const { open } = await setup(t)
  const rag = await open()
  await rag.createNamespace({ name: 'ns', space: SPACE })
  const handle = rag.scoped({ namespace: 'ns' }) as unknown as Record<string, unknown>
  for (const name of ['dropNamespace', 'listNamespaces', 'exportNamespace', 'importNamespace']) {
    t.is(handle[name], undefined, name)
  }
})

test('dropNamespace deletes past one batch of rows', async (t) => {
  const { open } = await setup(t)
  const rag = await open()
  await rag.createNamespace({ name: 'ns', space: SPACE })
  const documents = Array.from({ length: 1100 }, (_, i) =>
    doc(`d${i}`, spaceId, [
      [`d${i}a`, [1, 0, 0]],
      [`d${i}b`, [0, 1, 0]]
    ])
  )
  await rag.ingest({ namespace: 'ns', documents })

  const dropped = await rag.dropNamespace({ name: 'ns' })
  t.alike(dropped, { name: 'ns', documentCount: 1100, chunkCount: 2200 })

  await rag.createNamespace({ name: 'ns', space: SPACE })
  t.alike((await rag.listDocuments({ namespace: 'ns' })).documents, [], 'no document survives')
  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 5 })
  t.alike(hits, [], 'no chunk survives')
})

test('an ingest that outlives a drop and re-create writes nothing', async (t) => {
  const store = new Corestore(await tmp(t))
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = () => {}
  const embedding = new Promise<void>((resolve) => {
    started = resolve
  })
  const rag = createRag({
    corestore: store,
    embeddings: {
      space: SPACE,
      async embedDocuments(texts) {
        started()
        await gate
        return new Float32Array(texts.length * SPACE.dimensions).fill(0.5)
      },
      embedQuery: () => Promise.resolve(new Float32Array(SPACE.dimensions))
    }
  })
  await rag.ready()
  t.teardown(async () => {
    await rag.close()
    await store.close()
  })
  await rag.createNamespace({ name: 'ns', space: SPACE })

  const pending = rag.ingest({ namespace: 'ns', documents: [{ id: 'old', text: 'old text' }] })
  await embedding
  await rag.dropNamespace({ name: 'ns' })
  await rag.createNamespace({ name: 'ns', space: SPACE })
  release()

  await rejectsWithCode(t, pending, ERR_CODES.NAMESPACE_NOT_FOUND, 'stale ingest', /dropped/)
  t.alike((await rag.listDocuments({ namespace: 'ns' })).documents, [])
})

test('dropNamespace deletes snapshots in every index directory on the core', async (t) => {
  const { dir, open } = await setup(t)
  const indexed = await open({ snapshotEvery: 1 })
  const plain = await open({ dir: undefined })
  await indexed.createNamespace({ name: 'ns', space: SPACE })
  await indexed.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a0', [1, 0, 0]]])] })
  const query = { vector: [1, 0, 0], spaceId, k: 1, scope: { namespace: 'ns' } }
  t.is((await indexed.search(query)).length, 1)
  await indexed.ingest({ namespace: 'ns', documents: [doc('b', spaceId, [['b0', [0, 1, 0]]])] })
  t.ok(snapshotFiles(dir).length > 0, 'the indexed RAG wrote a snapshot')

  await plain.dropNamespace({ name: 'ns' })
  t.alike(snapshotFiles(dir), [], 'a drop through a RAG without a directory still deletes it')
})
