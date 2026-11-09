import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'
import fs from 'bare-fs'

import { ERR_CODES, createRag } from '../../src/index.js'
import { MUTATIONS, type MutationRecord } from '../../src/db/records.js'
import { loadNativeIndex, setNativeIndexLoader } from '../../src/vector-index/native.js'
import { SPACE, countNativeCalls, doc, inspect, rejectsWithCode, type Test } from './helpers.js'
import type {
  EmbeddedDocumentInput,
  EmbeddingSpace,
  IndexOptions,
  IndexStorage,
  Rag,
  SearchHit
} from '../../src/types.js'

interface Store {
  store: InstanceType<typeof Corestore>
  dir: string
}

async function openStore(t: Test): Promise<Store> {
  const store = new Corestore(await tmp(t))
  // After every RAG on it, which teardowns registered later would otherwise follow.
  t.teardown(() => store.close(), { order: 1 })
  return { store, dir: await tmp(t) }
}

async function openOn(t: Test, { store, dir }: Store, index: IndexOptions = {}): Promise<Rag> {
  const rag = createRag({ corestore: store, index: { dir, ...index } })
  await rag.ready()
  t.teardown(() => rag.close())
  return rag
}

// Every file under the snapshot directory, by name.
function snapshotFiles(dir: string): string[] {
  const files: string[] = []
  for (const coreDir of fs.readdirSync(dir)) {
    for (const file of fs.readdirSync(`${dir}/${coreDir}`)) files.push(`${dir}/${coreDir}/${file}`)
  }
  return files.sort()
}

function sidecarRevision(dir: string): number {
  const sidecar = snapshotFiles(dir).find((file) => file.endsWith('.json'))
  if (!sidecar) return -1
  return (JSON.parse(fs.readFileSync(sidecar, 'utf8')) as { revision: number }).revision
}

async function mutationRevisions(store: Store['store']): Promise<number[]> {
  return await inspect(store, async (reader) =>
    (await reader.find<MutationRecord>(MUTATIONS, {}).toArray()).map((row) => row.revision)
  )
}

function search(rag: Rag, spaceId: string, vector: number[], k = 10, documentIds?: string[]) {
  const scope = documentIds ? { namespace: 'ns', documentIds } : { namespace: 'ns' }
  return rag.search({ scope, vector, spaceId, k })
}

function contents(hits: SearchHit[]): string[] {
  return hits.map((hit) => hit.content)
}

// Deterministic vectors, so ranking comparisons are repeatable.
function randomVectors(count: number, dims: number, seed: number): number[][] {
  let state = seed >>> 0
  function next(): number {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000 - 0.5
  }
  return Array.from({ length: count }, () => Array.from({ length: dims }, next))
}

function spaceOf(dimensions: number, metric: 'dot' | 'cosine' = 'dot'): EmbeddingSpace {
  return { ...SPACE, dimensions, metric, model: `test-${dimensions}-${metric}` }
}

test('search goes through the index and close writes a snapshot that prunes mutations', async (t) => {
  const calls = await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  const { spaceId, index } = await rag.createNamespace({ name: 'ns', space: SPACE })
  t.alike(index, { storage: 'q8' }, 'q8 is the default storage')

  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  await rag.ingest({ namespace: 'ns', documents: [doc('b', spaceId, [['b', [0, 1, 0]]])] })
  t.alike(contents(await search(rag, spaceId, [0, 1, 0], 1)), ['b'])
  t.is(calls.creates, 1, 'the first search built the index')

  await rag.ingest({ namespace: 'ns', documents: [doc('c', spaceId, [['c', [0, 0, 1]]])] })
  t.alike(
    contents(await search(rag, spaceId, [0, 0, 1], 1)),
    ['c'],
    'a commit reaches the open index'
  )
  t.is(calls.creates, 1, 'without a rebuild')

  await rag.close()
  t.is(sidecarRevision(handle.dir), 3, 'the snapshot is at the last revision')
  t.alike(await mutationRevisions(handle.store), [], 'mutations up to the snapshot are pruned')

  const reopened = await openOn(t, handle)
  t.alike(contents(await search(reopened, spaceId, [1, 0, 0], 1)), ['a'])
  t.is(calls.loads, 1, 'the reopened index loads the snapshot')
  t.is(calls.creates, 1, 'and does not rebuild')
})

test('the index rebuilds from the database when its snapshot is deleted', async (t) => {
  const calls = await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({
    namespace: 'ns',
    documents: [doc('a', spaceId, [['a', [1, 0, 0]]]), doc('b', spaceId, [['b', [0, 1, 0]]])]
  })
  await search(rag, spaceId, [1, 0, 0])
  await rag.close()

  for (const file of snapshotFiles(handle.dir)) fs.unlinkSync(file)
  const reopened = await openOn(t, handle)
  t.alike(contents(await search(reopened, spaceId, [0, 1, 0])), ['b', 'a'])
  t.is(calls.loads, 0, 'nothing to load')
  t.is(calls.creates, 2, 'rebuilt from chunks')
  await reopened.close()
  t.is(sidecarRevision(handle.dir), 2, 'the rebuilt index is snapshotted on close')
})

test('a crash between commit and snapshot is recovered by replaying mutations', async (t) => {
  const calls = await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle, { snapshotEvery: 2 })
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  await search(rag, spaceId, [1, 0, 0])
  await rag.ingest({ namespace: 'ns', documents: [doc('b', spaceId, [['b', [0, 1, 0]]])] })
  t.is(sidecarRevision(handle.dir), 2, 'snapshot written after two commits')

  // A read-only directory makes every later snapshot fail, which leaves the
  // store as a crash after these commits would.
  const coreDir = snapshotFiles(handle.dir)[0].split('/').slice(0, -1).join('/')
  fs.chmodSync(coreDir, 0o555)
  t.teardown(() => fs.chmodSync(coreDir, 0o755))
  await rag.ingest({ namespace: 'ns', documents: [doc('c', spaceId, [['c', [0, 0, 1]]])] })
  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['a'] })
  await rag.close()
  fs.chmodSync(coreDir, 0o755)
  t.is(sidecarRevision(handle.dir), 2, 'the snapshot is still at revision 2')
  t.alike(await mutationRevisions(handle.store), [3, 4], 'later mutations are kept')

  const reopened = await openOn(t, handle, { snapshotEvery: 2 })
  t.alike(
    contents(await search(reopened, spaceId, [1, 1, 1])),
    ['b', 'c'],
    'replayed add and delete'
  )
  t.is(calls.loads, 1, 'loaded the stale snapshot')
  t.is(calls.creates, 1, 'replayed instead of rebuilding')
})

test('a stale snapshot never brings back deleted or superseded chunks', async (t) => {
  const calls = await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({
    namespace: 'ns',
    documents: [
      doc('gone', spaceId, [['gone', [1, 0, 0]]]),
      doc('kept', spaceId, [['old', [0.9, 0, 0]]])
    ]
  })
  await search(rag, spaceId, [1, 0, 0])
  await rag.close()
  const stale = snapshotFiles(handle.dir).map((file) => [file, fs.readFileSync(file)] as const)

  const second = await openOn(t, handle)
  await second.deleteDocuments({ namespace: 'ns', documentIds: ['gone'] })
  await second.ingest({ namespace: 'ns', documents: [doc('kept', spaceId, [['new', [0, 1, 0]]])] })
  await search(second, spaceId, [1, 0, 0])
  await second.close()
  t.alike(await mutationRevisions(handle.store), [], 'the mutations it would need are pruned')

  // Put the old snapshot back, as a restored backup would.
  for (const file of snapshotFiles(handle.dir)) fs.unlinkSync(file)
  for (const [file, bytes] of stale) fs.writeFileSync(file, bytes)
  const restored = await openOn(t, handle)
  t.alike(contents(await search(restored, spaceId, [1, 0, 0])), ['new'], 'rebuilt, not resurrected')
  t.is(calls.creates, 2, 'a gap in mutations forces a rebuild')
  await restored.close()

  // A sidecar that lies about its revision loads the old IDs, which no longer
  // map to chunks and are dropped.
  for (const file of snapshotFiles(handle.dir)) fs.unlinkSync(file)
  for (const [file, bytes] of stale) {
    if (!file.endsWith('.json')) {
      fs.writeFileSync(file, bytes)
      continue
    }
    const sidecar = JSON.parse(bytes.toString()) as { revision: number }
    fs.writeFileSync(file, JSON.stringify({ ...sidecar, revision: 4 }))
  }
  const forged = await openOn(t, handle)
  const hits = await search(forged, spaceId, [1, 0, 0])
  t.is(calls.creates, 2, 'the forged snapshot was loaded')
  t.alike(contents(hits), [], 'its IDs map to nothing current')
})

test('a commit during a search never hides the document it replaces', async (t) => {
  await countNativeCalls(t)
  const real = await loadNativeIndex()
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['old', [1, 0, 0]]])] })
  await search(rag, spaceId, [1, 0, 0])

  // Holding the loader keeps the search between its snapshot and the index
  // lookup while the replacement commits, so the open index is a revision
  // ahead of the search's reader.
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  setNativeIndexLoader(() => gate.then(() => real))
  const pending = search(rag, spaceId, [1, 0, 0])
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['new', [1, 0, 0]]])] })
  release()
  t.alike(contents(await pending), ['new'], 'retried on a reader that matches the index')
})

test('concurrent first searches share one replay', async (t) => {
  const calls = await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle, { snapshotEvery: 1 })
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  await search(rag, spaceId, [1, 0, 0])

  const coreDir = snapshotFiles(handle.dir)[0].split('/').slice(0, -1).join('/')
  fs.chmodSync(coreDir, 0o555)
  t.teardown(() => fs.chmodSync(coreDir, 0o755))
  await rag.ingest({ namespace: 'ns', documents: [doc('b', spaceId, [['b', [0, 1, 0]]])] })
  await rag.ingest({ namespace: 'ns', documents: [doc('c', spaceId, [['c', [0, 0, 1]]])] })
  await rag.close()
  fs.chmodSync(coreDir, 0o755)

  const reopened = await openOn(t, handle, { snapshotEvery: 100 })
  const results = await Promise.all([
    search(reopened, spaceId, [1, 1, 1]),
    search(reopened, spaceId, [1, 1, 1]),
    search(reopened, spaceId, [1, 1, 1])
  ])
  for (const hits of results) t.alike(contents(hits).sort(), ['a', 'b', 'c'])
  t.is(calls.loads, 1, 'one load')
  t.is(calls.creates, 1, 'and no rebuild')
})

test('scope never leaks through the index', async (t) => {
  await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  const other = await rag.createNamespace({ name: 'other', space: SPACE })
  const documents: EmbeddedDocumentInput[] = []
  for (let i = 0; i < 20; i++) {
    documents.push(
      doc(`d${i}`, spaceId, [
        [`d${i}-0`, [1, i / 20, 0]],
        [`d${i}-1`, [1, 0, i / 20]]
      ])
    )
  }
  await rag.ingest({ namespace: 'ns', documents })
  await rag.ingest({
    namespace: 'other',
    documents: [doc('d1', other.spaceId, [['other namespace', [10, 0, 0]]])]
  })

  const hits = await search(rag, spaceId, [1, 0, 0], 50, ['d1', 'd7'])
  t.alike(new Set(hits.map((hit) => hit.documentId)), new Set(['d1', 'd7']), 'only the scope')
  t.is(hits.length, 4, 'k above the allowlist returns the allowlist')
  t.ok(
    hits.every((hit) => hit.namespace === 'ns'),
    'never another namespace'
  )

  const scoped = rag.scoped({ namespace: 'ns', documentIds: ['d3', 'd4'] })
  const narrowed = await scoped.search({
    scope: { documentIds: ['d4', 'd5'] },
    vector: [1, 0, 0],
    spaceId,
    k: 10
  })
  t.alike(new Set(narrowed.map((hit) => hit.documentId)), new Set(['d4']), 'a handle only narrows')

  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['d4'] })
  t.alike(
    await scoped
      .search({ vector: [1, 0, 0], spaceId, k: 10 })
      .then((rows) => rows.map((hit) => hit.documentId)),
    ['d3', 'd3'],
    'a deleted document leaves the handle'
  )
  t.alike(await search(rag, spaceId, [1, 0, 0], 5, []), [], 'an empty scope finds nothing')
  await rejectsWithCode(
    t,
    search(rag, spaceId, [1, 0, 0], 5, ['missing']),
    ERR_CODES.DOCUMENT_OUT_OF_SCOPE,
    'an unknown document still fails a direct search'
  )
})

for (const storage of ['f32', 'q8'] as const) {
  for (const metric of ['dot', 'cosine'] as const) {
    test(`${storage} ${metric} index results match the scan`, async (t) => {
      const dims = 16
      const handle = await openStore(t)
      const vectors = randomVectors(300, dims, 7)
      const space = spaceOf(dims, metric)
      const documents: EmbeddedDocumentInput[] = []
      let next = 0
      for (let i = 0; i < 30; i++) {
        const chunks: Array<[string, number[]]> = []
        for (let j = 0; j < 10; j++) chunks.push([`c${next}`, vectors[next++]])
        documents.push(doc(`d${i}`, '', chunks))
      }

      setNativeIndexLoader(() => Promise.resolve(null))
      t.teardown(() => setNativeIndexLoader(null))
      const scan = await openOn(t, handle)
      const { spaceId } = await scan.createNamespace({ name: 'ns', space, index: { storage } })
      for (const document of documents) {
        for (const chunk of document.chunks) chunk.spaceId = spaceId
      }
      await scan.ingest({ namespace: 'ns', documents })
      const queries = randomVectors(10, dims, 99)
      const expected: SearchHit[][] = []
      const scopeIds = ['d2', 'd5', 'd11', 'd29']
      for (const query of queries) {
        expected.push(await search(scan, spaceId, query, 5))
        expected.push(await search(scan, spaceId, query, 5, scopeIds))
      }
      await scan.close()

      setNativeIndexLoader(null)
      const indexed = await openOn(t, handle)
      const actual: SearchHit[][] = []
      for (const query of queries) {
        actual.push(await search(indexed, spaceId, query, 5))
        actual.push(await search(indexed, spaceId, query, 5, scopeIds))
      }
      t.alike(
        actual.map((hits) => hits.map((hit) => hit.chunkId)),
        expected.map((hits) => hits.map((hit) => hit.chunkId)),
        'same chunks in the same order'
      )
      const drift = Math.max(
        ...actual.flatMap((hits, i) =>
          hits.map((hit, j) => Math.abs(hit.score - expected[i][j].score))
        )
      )
      t.ok(drift < 1e-5, `exact scores (max drift ${drift})`)
    })
  }
}

test('TurboVec storage is opt-in and needs dimensions divisible by 8 up to 1,024', async (t) => {
  await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  for (const storage of ['turbovec-q4', 'turbovec-q2'] as IndexStorage[]) {
    await rejectsWithCode(
      t,
      rag.createNamespace({ name: `bad-${storage}`, space: spaceOf(12), index: { storage } }),
      ERR_CODES.INVALID_INPUT,
      `${storage} rejects 12 dimensions`
    )
    await rejectsWithCode(
      t,
      rag.createNamespace({ name: `big-${storage}`, space: spaceOf(1032), index: { storage } }),
      ERR_CODES.INVALID_INPUT,
      `${storage} rejects 1,032 dimensions`
    )
  }
  await rejectsWithCode(
    t,
    rag.createNamespace({ name: 'x', space: SPACE, index: { storage: 'q4' as IndexStorage } }),
    ERR_CODES.INVALID_INPUT,
    'unknown storage'
  )

  const space = spaceOf(16)
  const created = await rag.createNamespace({
    name: 'ns',
    space,
    index: { storage: 'turbovec-q2' }
  })
  t.alike(created.index, { storage: 'turbovec-q2' })
  t.alike((await rag.createNamespace({ name: 'ns', space })).index, { storage: 'turbovec-q2' })
  await rejectsWithCode(
    t,
    rag.createNamespace({ name: 'ns', space, index: { storage: 'q8' } }),
    ERR_CODES.NAMESPACE_EXISTS,
    'storage is fixed at creation'
  )

  const vectors = randomVectors(64, 16, 3)
  await rag.ingest({
    namespace: 'ns',
    documents: [
      doc(
        'a',
        created.spaceId,
        vectors.map((vector, i) => [`c${i}`, vector])
      )
    ]
  })
  const hits = await search(rag, created.spaceId, vectors[10], 3)
  t.is(hits[0].content, 'c10', 'the nearest chunk ranks first')
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [doc('huge', created.spaceId, [['x', [1e17, ...new Array(15).fill(0)]]])]
    }),
    ERR_CODES.INVALID_INPUT,
    'components TurboVec cannot quantize are rejected before commit'
  )
  const huge = [1e17, ...new Array(15).fill(0)]
  t.is(
    (await search(rag, created.spaceId, huge, 1)).length,
    1,
    'a query TurboVec cannot quantize is answered by the scan'
  )
})

test('search falls back to the scan without the addon', async (t) => {
  setNativeIndexLoader(() => Promise.resolve(null))
  t.teardown(() => setNativeIndexLoader(null))
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  t.alike(contents(await search(rag, spaceId, [1, 0, 0])), ['a'])
  await rag.close()
  t.alike(snapshotFiles(handle.dir), [], 'no snapshot without an index')
  t.alike(await mutationRevisions(handle.store), [1], 'and nothing pruned')
})
