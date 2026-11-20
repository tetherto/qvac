import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'
import fs from 'bare-fs'
import { AbortController } from 'bare-abort-controller'

import { ERR_CODES, computeSpaceId, createRag } from '../../src/index.js'
import { MUTATIONS, type MutationRecord } from '../../src/db/records.js'
import {
  loadNativeIndex,
  setNativeIndexLoader,
  type NativeIndex,
  type NativeIndexModule,
  type NativeSearchResult
} from '../../src/vector-index/native.js'
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

test('tied scores rank as in the scan, past the candidate cutoff', async (t) => {
  const handle = await openStore(t)
  const documents: EmbeddedDocumentInput[] = []
  // Reverse name order, so native IDs run opposite to document IDs.
  for (let i = 30; i > 0; i--) {
    const name = `d${String(i).padStart(2, '0')}`
    documents.push(doc(name, '', [[name, [1, 0, 0]]]))
  }
  const queries: Array<[number[], number, string[] | undefined]> = [
    [[0, 0, 0], 1, undefined],
    [[1, 0, 0], 3, undefined],
    [[0, 0, 0], 2, ['d17', 'd04', 'd25']],
    [[1, 0, 0], 20, ['d30', 'd01']]
  ]

  async function run(rag: Rag, spaceId: string): Promise<string[][]> {
    const results: string[][] = []
    for (const [vector, k, documentIds] of queries) {
      results.push(contents(await search(rag, spaceId, vector, k, documentIds)))
    }
    return results
  }

  setNativeIndexLoader(() => Promise.resolve(null))
  t.teardown(() => setNativeIndexLoader(null))
  const scan = await openOn(t, handle)
  const { spaceId } = await scan.createNamespace({
    name: 'ns',
    space: SPACE,
    index: { storage: 'f32' }
  })
  for (const document of documents) document.chunks[0].spaceId = spaceId
  await scan.ingest({ namespace: 'ns', documents })
  const expected = await run(scan, spaceId)
  await scan.close()

  setNativeIndexLoader(null)
  const indexed = await openOn(t, handle)
  t.alike(await run(indexed, spaceId), expected)
  t.alike(expected[0], ['d01'], 'key order for a namespace')
  t.alike(expected[2], ['d17', 'd04'], 'scope order for a document list')
})

test('an abort stops a search waiting for the index, and the rebuild still finishes', async (t) => {
  const calls = await countNativeCalls(t)
  const real = await loadNativeIndex()
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })

  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  let entered = () => {}
  const reached = new Promise<void>((resolve) => (entered = resolve))
  setNativeIndexLoader(() => {
    entered()
    return gate.then(() => real)
  })
  const controller = new AbortController()
  const pending = rag.search({
    scope: { namespace: 'ns' },
    vector: [1, 0, 0],
    spaceId,
    k: 1,
    signal: controller.signal
  })
  const settled = pending.then(
    () => 'resolved',
    (error: { code?: number }) => error.code
  )
  await reached
  controller.abort(new Error('stop'))
  // The gate stays shut, so only the abort can settle the search.
  const outcome = await Promise.race([settled, delay(100).then(() => 'still waiting')])
  t.is(outcome, ERR_CODES.OPERATION_CANCELLED, 'rejected while the index is still loading')

  release()
  t.alike(contents(await search(rag, spaceId, [1, 0, 0])), ['a'])
  t.is(calls.creates, 1, 'one build: the next search reused the rebuild the abort left running')
})

const timers = globalThis as unknown as {
  setTimeout: (callback: () => void, ms: number) => void
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => timers.setTimeout(resolve, ms))
}

function faultyLoader(real: NativeIndexModule, broken: 'addWithIds' | 'search') {
  const counts = { creates: 0 }
  const wrap = (native: NativeIndex): NativeIndex =>
    new Proxy(native, {
      get(target, key) {
        if (key === broken) return () => Promise.reject(new Error('addon fault'))
        const value = Reflect.get(target, key) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  const module: NativeIndexModule = {
    create(dim, storage) {
      counts.creates++
      return wrap(real.create(dim, storage))
    },
    load: async (path) => wrap(await real.load(path))
  }
  return { module, counts }
}

for (const broken of ['addWithIds', 'search'] as const) {
  test(`a failing native ${broken} falls back to the scan`, async (t) => {
    await countNativeCalls(t)
    const real = (await loadNativeIndex()) as NativeIndexModule
    const { module, counts } = faultyLoader(real, broken)
    setNativeIndexLoader(() => Promise.resolve(module))
    const handle = await openStore(t)
    const rag = await openOn(t, handle)
    const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
    await rag.ingest({
      namespace: 'ns',
      documents: [doc('a', spaceId, [['a', [1, 0, 0]]]), doc('b', spaceId, [['b', [0, 1, 0]]])]
    })
    t.alike(contents(await search(rag, spaceId, [0, 1, 0])), ['b', 'a'], 'the scan answered')
    t.alike(contents(await search(rag, spaceId, [1, 0, 0])), ['a', 'b'], 'and keeps answering')
    t.is(counts.creates, 1, 'without rebuilding on every search')
  })
}

interface Gate {
  entered: Promise<void>
  enter(): void
  opened: Promise<void>
  open(): void
}

function gate(): Gate {
  const held = {} as Gate
  held.entered = new Promise<void>((resolve) => (held.enter = resolve))
  held.opened = new Promise<void>((resolve) => (held.open = resolve))
  return held
}

// Lets a test hold one native call, as if it were queued on the worker.
function controlledLoader(real: NativeIndexModule) {
  const controls = {
    creates: 0,
    searches: 0,
    lastSearch: null as Promise<NativeSearchResult> | null,
    holdCall: null as Gate | null,
    holdResult: null as Gate | null,
    failAdd: null as Gate | null
  }
  async function runSearch(start: () => Promise<NativeSearchResult>): Promise<NativeSearchResult> {
    controls.searches++
    const call = controls.holdCall
    controls.holdCall = null
    if (call) {
      call.enter()
      await call.opened
    }
    const pending = start()
    controls.lastSearch = pending
    const result = controls.holdResult
    controls.holdResult = null
    if (result) {
      result.enter()
      await result.opened
    }
    return await pending
  }

  const wrap = (native: NativeIndex): NativeIndex =>
    new Proxy(native, {
      get(target, key) {
        if (key === 'search') {
          return (...args: Parameters<NativeIndex['search']>) =>
            runSearch(() => target.search(...args))
        }
        if (key === 'searchFiltered') {
          return (...args: Parameters<NativeIndex['searchFiltered']>) =>
            runSearch(() => target.searchFiltered(...args))
        }
        if (key === 'addWithIds') {
          return async (vectors: Float32Array, ids: BigUint64Array): Promise<void> => {
            const held = controls.failAdd
            if (!held) return await target.addWithIds(vectors, ids)
            controls.failAdd = null
            held.enter()
            await held.opened
            throw new Error('addon fault')
          }
        }
        const value = Reflect.get(target, key) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  const module: NativeIndexModule = {
    create(dim, storage) {
      controls.creates++
      return wrap(real.create(dim, storage))
    },
    load: async (path) => wrap(await real.load(path))
  }
  return { module, controls }
}

async function useControlledIndex(t: Test) {
  await countNativeCalls(t)
  const loaded = controlledLoader((await loadNativeIndex()) as NativeIndexModule)
  setNativeIndexLoader(() => Promise.resolve(loaded.module))
  return loaded.controls
}

for (const filtered of [false, true]) {
  test(`an abort stops waiting for a native ${filtered ? 'filtered search' : 'search'}`, async (t) => {
    const controls = await useControlledIndex(t)
    const rag = await openOn(t, await openStore(t))
    const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
    await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
    const documentIds = filtered ? ['a'] : undefined
    t.alike(contents(await search(rag, spaceId, [1, 0, 0], 1, documentIds)), ['a'])

    const call = gate()
    controls.holdCall = call
    const controller = new AbortController()
    const pending = rag.search({
      scope: { namespace: 'ns', documentIds },
      vector: [1, 0, 0],
      spaceId,
      k: 1,
      signal: controller.signal
    })
    const settled = pending.then(
      () => 'resolved',
      (error: { code?: number }) => error.code
    )
    await call.entered
    const reason = new Error('stop')
    controller.abort(reason)
    const outcome = await Promise.race([settled, delay(100).then(() => 'still waiting')])
    call.open()
    t.is(outcome, ERR_CODES.OPERATION_CANCELLED, 'rejected before the native call ran')
    await call.opened
    const nativeOutcome = await controls.lastSearch?.catch((error: unknown) => error)
    t.is(nativeOutcome, reason, 'TurboVec received the aborted signal')

    const before = controls.searches
    t.alike(contents(await search(rag, spaceId, [1, 0, 0], 1, documentIds)), ['a'])
    t.is(controls.searches, before + 1, 'later searches still use the index')
  })
}

test('a search whose index is disposed while its call waits retries on the rebuilt index', async (t) => {
  const controls = await useControlledIndex(t)
  const rag = await openOn(t, await openStore(t))
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  t.alike(contents(await search(rag, spaceId, [1, 0, 0])), ['a'])

  const call = gate()
  controls.holdCall = call
  const pending = search(rag, spaceId, [1, 0, 0])
  await call.entered
  // A failing add drops the index, disposing it under the waiting search.
  const fault = gate()
  fault.open()
  controls.failAdd = fault
  await rag.ingest({ namespace: 'ns', documents: [doc('b', spaceId, [['b', [0, 1, 0]]])] })
  call.open()
  t.alike(contents(await pending), ['a', 'b'], 'retried on a fresh reader and a rebuilt index')
  t.is(controls.creates, 2, 'one rebuild after the drop')

  const before = controls.searches
  t.alike(contents(await search(rag, spaceId, [0, 1, 0])), ['b', 'a'])
  t.ok(controls.searches > before, 'the disposal did not stop later searches using the index')
})

test('a rebuild between the rounds of a search retries it on the new index', async (t) => {
  const controls = await useControlledIndex(t)
  const rag = await openOn(t, await openStore(t))
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  const names = Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(2, '0')}`)
  await rag.ingest({
    namespace: 'ns',
    documents: names.map((name) => doc(name, spaceId, [[name, [1, 0, 0]]]))
  })
  t.alike(contents(await search(rag, spaceId, [0, 0, 0], 1)), ['d00'])

  // All scores tie, forcing a second, wider round.
  const result = gate()
  controls.holdResult = result
  const pending = search(rag, spaceId, [0, 0, 0], 1)
  await result.entered
  const fault = gate()
  fault.open()
  controls.failAdd = fault
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [0, 1, 0]]])] })
  t.alike(contents(await search(rag, spaceId, [0, 1, 0], 1)), ['a'], 'another search rebuilt it')
  t.is(controls.creates, 2)

  result.open()
  t.alike(contents(await pending), ['a'], 'the held search answered from the new state')
})

test('a search never reads a commit whose native add is still failing', async (t) => {
  const controls = await useControlledIndex(t)
  const rag = await openOn(t, await openStore(t))
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['old', [1, 0, 0]]])] })
  t.alike(contents(await search(rag, spaceId, [1, 0, 0])), ['old'])

  // The remove lands and the add fails: briefly neither version is indexed.
  const fault = gate()
  controls.failAdd = fault
  const replacing = rag.ingest({
    namespace: 'ns',
    documents: [doc('a', spaceId, [['new', [1, 0, 0]]])]
  })
  await fault.entered
  const before = controls.searches
  const pending = search(rag, spaceId, [1, 0, 0])
  while (controls.searches === before) await delay(1)
  fault.open()
  t.alike(contents(await pending), ['new'], 'not an empty result from the half-applied commit')
  await replacing
  t.is(controls.creates, 2, 'the failed commit dropped the index, and it was rebuilt')
})

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

test('re-ingesting unchanged content after a crash between commit and snapshot', async (t) => {
  const calls = await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle, { snapshotEvery: 2 })
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  await search(rag, spaceId, [1, 0, 0])
  await rag.ingest({ namespace: 'ns', documents: [doc('b', spaceId, [['b', [0, 1, 0]]])] })
  t.is(sidecarRevision(handle.dir), 2)

  const coreDir = snapshotFiles(handle.dir)[0].split('/').slice(0, -1).join('/')
  fs.chmodSync(coreDir, 0o555)
  t.teardown(() => fs.chmodSync(coreDir, 0o755))
  await rag.ingest({ namespace: 'ns', documents: [doc('c', spaceId, [['c', [0, 0, 1]]])] })
  await rag.close()
  fs.chmodSync(coreDir, 0o755)
  t.is(sidecarRevision(handle.dir), 2, 'the commit of c is not in the snapshot')

  const reopened = await openOn(t, handle, { snapshotEvery: 2 })
  const retried = await reopened.ingest({
    namespace: 'ns',
    documents: [doc('c', spaceId, [['c', [0, 0, 1]]]), doc('b', spaceId, [['b2', [0, 1, 0]]])]
  })
  t.alike(retried.documents, [
    { id: 'c', generation: 1, chunkCount: 1, status: 'unchanged' },
    { id: 'b', generation: 2, chunkCount: 1, status: 'replaced', removedChunks: 1 }
  ])
  t.is(retried.revision, 4, 'only the changed document bumped the revision')
  t.alike(contents(await search(reopened, spaceId, [0, 1, 1])), ['b2', 'c', 'a'])
  t.is(calls.loads, 1, 'the stale snapshot was loaded')
  t.is(calls.creates, 1, 'and caught up by replay, without a rebuild')
})

test('a query from another space is rejected before the index opens', async (t) => {
  const calls = await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  const other = await rag.createNamespace({ name: 'other', space: spaceOf(3) })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })

  await rejectsWithCode(
    t,
    search(rag, other.spaceId, [1, 0, 0]),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'direct search'
  )
  await rejectsWithCode(
    t,
    rag.scoped({ namespace: 'ns', documentIds: ['a'] }).search({
      vector: [1, 0, 0],
      spaceId: other.spaceId,
      k: 1
    }),
    ERR_CODES.EMBEDDING_SPACE_MISMATCH,
    'scoped search'
  )
  t.is(calls.creates + calls.loads, 0, 'the index was never opened')
})

test('a snapshot from another space is never loaded, even with the same dimensions', async (t) => {
  const calls = await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  await search(rag, spaceId, [1, 0, 0])
  await rag.close()

  const sidecar = snapshotFiles(handle.dir).find((file) => file.endsWith('.json')) as string
  const written = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as { spaceId: string }
  t.is(written.spaceId, spaceId)
  written.spaceId = computeSpaceId(spaceOf(3))
  fs.writeFileSync(sidecar, JSON.stringify(written))

  const reopened = await openOn(t, handle)
  t.alike(contents(await search(reopened, spaceId, [1, 0, 0])), ['a'])
  t.is(calls.loads, 0, 'the snapshot was not loaded')
  t.is(calls.creates, 2, 'the index was rebuilt from the database')
})

test('replaced rows are compacted once they reach a quarter of the live ones', async (t) => {
  const calls = await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle)
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  await rag.ingest({
    namespace: 'ns',
    documents: ids.map((id) => doc(id, spaceId, [[id, [1, 0, 0]]]))
  })
  await search(rag, spaceId, [1, 0, 0])

  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a2', [0, 1, 0]]])] })
  t.is(calls.compacts, 0, 'one removed row of eight')
  await rag.ingest({ namespace: 'ns', documents: [doc('b', spaceId, [['b2', [0, 1, 0]]])] })
  t.is(calls.compacts, 1, 'two removed rows of eight')

  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [0, 1, 0], spaceId, k: 2 })
  t.alike(contents(hits).sort(), ['a2', 'b2'], 'the compacted index still serves every row')
  t.is(calls.creates, 1, 'compacted in place, not rebuilt')
})

test('replay compacts the rows it removes', async (t) => {
  const calls = await countNativeCalls(t)
  const handle = await openStore(t)
  const rag = await openOn(t, handle, { snapshotEvery: 1 })
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({
    namespace: 'ns',
    documents: [doc('a', spaceId, [['a', [1, 0, 0]]]), doc('b', spaceId, [['b', [0, 1, 0]]])]
  })
  await search(rag, spaceId, [1, 0, 0])
  t.is(sidecarRevision(handle.dir), 2)

  const coreDir = snapshotFiles(handle.dir)[0].split('/').slice(0, -1).join('/')
  fs.chmodSync(coreDir, 0o555)
  t.teardown(() => fs.chmodSync(coreDir, 0o755))
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a2', [0, 0, 1]]])] })
  await rag.close()
  fs.chmodSync(coreDir, 0o755)
  const compactsBefore = calls.compacts

  const reopened = await openOn(t, handle, { snapshotEvery: 1 })
  t.alike(contents(await search(reopened, spaceId, [1, 1, 1])).sort(), ['a2', 'b'])
  t.is(calls.loads, 1, 'replayed from the snapshot')
  t.is(calls.compacts, compactsBefore + 1, 'one removed row of two')
})
