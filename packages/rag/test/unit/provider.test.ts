import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'
import fs from 'bare-fs'

import { ERR_CODES, createRag } from '../../src/index.js'
import { SCAN_ONLY, SPACE, doc, rejectsWithCode, type Test } from './helpers.js'
import type {
  EmbeddedDocumentInput,
  IndexHandle,
  IndexOptions,
  IndexProvider,
  IndexSearchResult,
  Rag,
  SearchHit,
  SnapshotFileSystem
} from '../../src/types.js'

const PADDING = 0xffffffffffffffffn

interface MemoryCalls {
  creates: number
  loads: number
  searches: number
  filtered: number
}

// An exact in-memory index with only the required methods, plus the optional
// ones a test asks for. Each call takes effect when made, so calls run in order.
function memoryProvider(
  optional: { filtered?: boolean; snapshots?: boolean; asyncCreate?: boolean } = {}
): { provider: IndexProvider; calls: MemoryCalls } {
  const calls: MemoryCalls = { creates: 0, loads: 0, searches: 0, filtered: 0 }

  function top(
    rows: Map<bigint, Float32Array>,
    query: Float32Array,
    k: number,
    allowed: Set<bigint> | null
  ): IndexSearchResult {
    const scored: Array<[bigint, number]> = []
    for (const [id, vector] of rows) {
      if (allowed && !allowed.has(id)) continue
      let score = 0
      for (let i = 0; i < vector.length; i++) score += vector[i] * query[i]
      scored.push([id, score])
    }
    scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    const ids = new BigUint64Array(k).fill(PADDING)
    const scores = new Float32Array(k)
    scored.slice(0, k).forEach(([id, score], i) => {
      ids[i] = id
      scores[i] = score
    })
    return { ids, scores, k }
  }

  function handle(dim: number, rows = new Map<bigint, Float32Array>()): IndexHandle {
    const index: IndexHandle = {
      get length() {
        return rows.size
      },
      dim,
      addWithIds(vectors, ids) {
        ids.forEach((id, i) => rows.set(id, vectors.slice(i * dim, (i + 1) * dim)))
        return Promise.resolve()
      },
      remove: (id) => Promise.resolve(rows.delete(id)),
      contains: (id) => Promise.resolve(rows.has(id)),
      search(query, k) {
        calls.searches++
        return Promise.resolve(top(rows, query, k, null))
      },
      dispose: () => Promise.resolve()
    }
    if (optional.filtered) {
      index.searchFiltered = (query, k, allowed) => {
        calls.filtered++
        return Promise.resolve(top(rows, query, k, new Set(allowed)))
      }
    }
    if (optional.snapshots) {
      index.write = (path) => {
        const entries = Array.from(rows, ([id, vector]) => [id.toString(), Array.from(vector)])
        fs.writeFileSync(path, JSON.stringify({ dim, entries }))
        return Promise.resolve()
      }
    }
    return index
  }

  const provider: IndexProvider = {
    create(dim) {
      calls.creates++
      return optional.asyncCreate ? Promise.resolve(handle(dim)) : handle(dim)
    }
  }
  if (optional.snapshots) {
    provider.load = (path) => {
      calls.loads++
      const { dim, entries } = JSON.parse(fs.readFileSync(path, 'utf8') as unknown as string) as {
        dim: number
        entries: Array<[string, number[]]>
      }
      const rows = new Map(entries.map(([id, v]) => [BigInt(id), Float32Array.from(v)]))
      return Promise.resolve(handle(dim, rows))
    }
  }
  return { provider, calls }
}

interface Opened {
  rag: Rag
  spaceId: string
}

async function openOn(
  t: Test,
  store: InstanceType<typeof Corestore>,
  index: IndexOptions
): Promise<Opened> {
  const rag = createRag({ corestore: store, index })
  await rag.ready()
  t.teardown(() => rag.close())
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  return { rag, spaceId }
}

async function openStore(t: Test) {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close(), { order: 1 })
  return store
}

// d00 scores lowest for [1, 0, 0] and d99 highest.
function ranked(spaceId: string, count: number): EmbeddedDocumentInput[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `d${String(i).padStart(2, '0')}`
    return doc(id, spaceId, [[id, [i, 1, 0]]])
  })
}

function ids(hits: SearchHit[]): string[] {
  return hits.map((hit) => hit.content)
}

const QUERY = [1, 0, 0]
const LOWEST = Array.from({ length: 50 }, (_, i) => `d${String(i).padStart(2, '0')}`)

for (const filtered of [false, true]) {
  test(`a host provider ${filtered ? 'with' : 'without'} searchFiltered matches the scan`, async (t) => {
    const { provider, calls } = memoryProvider({ filtered })
    const scan = await openOn(t, await openStore(t), { provider: SCAN_ONLY })
    const indexed = await openOn(t, await openStore(t), { provider, dir: await tmp(t) })
    for (const { rag, spaceId } of [scan, indexed]) {
      await rag.ingest({ namespace: 'ns', documents: ranked(spaceId, 100) })
    }

    const searches = [
      { k: 5, scope: { namespace: 'ns' } },
      { k: 5, scope: { namespace: 'ns', documentIds: LOWEST } },
      { k: 30, scope: { namespace: 'ns', documentIds: LOWEST } },
      { k: 3, perDocument: 1, scope: { namespace: 'ns', documentIds: ['d03', 'd07', 'd01'] } }
    ]
    for (const params of searches) {
      const expected = await scan.rag.search({ ...params, vector: QUERY, spaceId: scan.spaceId })
      const actual = await indexed.rag.search({
        ...params,
        vector: QUERY,
        spaceId: indexed.spaceId
      })
      t.alike(
        ids(actual),
        ids(expected),
        `k=${params.k}, ${params.scope.documentIds?.length ?? 'all'}`
      )
    }

    t.alike(
      await indexed.rag.indexStatus({ namespace: 'ns' }),
      { mode: 'index', revision: 100, snapshot: 'off' },
      'no snapshots without load and write, even with a directory'
    )
    t.is(calls.creates, 1)
    if (filtered) t.ok(calls.filtered > 0, 'scoped searches used searchFiltered')
    else t.ok(calls.searches > searches.length, 'a scoped search over-fetched more than once')
  })
}

test('a host provider without compact stays correct across replace and delete', async (t) => {
  const { provider } = memoryProvider({ asyncCreate: true })
  const { rag, spaceId } = await openOn(t, await openStore(t), { provider })
  await rag.ingest({ namespace: 'ns', documents: ranked(spaceId, 10) })
  const search = (documentIds?: string[]) =>
    rag.search({ scope: { namespace: 'ns', documentIds }, vector: QUERY, spaceId, k: 3 })
  t.alike(ids(await search()), ['d09', 'd08', 'd07'])

  await rag.ingest({ namespace: 'ns', documents: [doc('d09', spaceId, [['low', [-1, 0, 0]]])] })
  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['d08'] })
  t.alike(ids(await search()), ['d07', 'd06', 'd05'])
  t.alike(ids(await search(['d09', 'd00'])), ['d00', 'low'])
  t.is((await rag.indexStatus({ namespace: 'ns' })).mode, 'index')
})

test('a host provider with load and write snapshots through a supplied fs', async (t) => {
  const store = await openStore(t)
  const dir = await tmp(t)
  const { provider, calls } = memoryProvider({ snapshots: true })
  const index: IndexOptions = {
    provider,
    dir,
    snapshotEvery: 1,
    fs: fs.promises as unknown as IndexOptions['fs']
  }
  const first = createRag({ corestore: store, index })
  await first.ready()
  const { spaceId } = await first.createNamespace({ name: 'ns', space: SPACE })
  await first.ingest({ namespace: 'ns', documents: ranked(spaceId, 5) })
  await first.search({ scope: { namespace: 'ns' }, vector: QUERY, spaceId, k: 1 })
  t.alike(await first.indexStatus({ namespace: 'ns' }), {
    mode: 'index',
    revision: 5,
    snapshot: 'ok'
  })
  await first.close()

  const second = createRag({ corestore: store, index })
  await second.ready()
  t.teardown(() => second.close())
  const hits = await second.search({ scope: { namespace: 'ns' }, vector: QUERY, spaceId, k: 2 })
  t.alike(ids(hits), ['d04', 'd03'])
  t.is(calls.loads, 1, 'the second RAG loaded the snapshot')
  t.is(calls.creates, 1, 'and did not rebuild')
})

test('RAGs on one core with different providers keep separate indexes', async (t) => {
  const store = await openStore(t)
  const a = memoryProvider()
  const b = memoryProvider()
  const ragA = createRag({ corestore: store, index: { provider: a.provider } })
  const ragB = createRag({ corestore: store, index: { provider: b.provider } })
  await ragA.ready()
  await ragB.ready()
  t.teardown(async () => {
    await ragA.close()
    await ragB.close()
  })
  const { spaceId } = await ragA.createNamespace({ name: 'ns', space: SPACE })
  await ragA.ingest({ namespace: 'ns', documents: ranked(spaceId, 3) })
  for (const rag of [ragA, ragB]) {
    const hits = await rag.search({ scope: { namespace: 'ns' }, vector: QUERY, spaceId, k: 1 })
    t.alike(ids(hits), ['d02'])
  }
  t.is(a.calls.creates, 1)
  t.is(b.calls.creates, 1)
})

test('a snapshot directory takes one provider and fs per core', async (t) => {
  const store = await openStore(t)
  const dir = await tmp(t)
  const files = fs.promises as unknown as SnapshotFileSystem
  const first = createRag({
    corestore: store,
    index: { dir, provider: memoryProvider({ snapshots: true }).provider, fs: files }
  })
  await first.ready()

  const otherFormat = createRag({
    corestore: store,
    index: { dir, provider: memoryProvider({ snapshots: true }).provider, fs: files }
  })
  await rejectsWithCode(t, otherFormat.ready(), ERR_CODES.INVALID_INPUT, 'another provider', /dir/)
  const { provider } = memoryProvider({ snapshots: true })
  const a = createRag({ corestore: store, index: { dir: await tmp(t), provider, fs: files } })
  await a.ready()
  const otherFs = { ...files } as SnapshotFileSystem
  const b = createRag({ corestore: store, index: { dir: await tmp(t), provider, fs: otherFs } })
  await b.ready()
  t.pass('different directories are independent')

  await first.close()
  const reopened = createRag({
    corestore: store,
    index: { dir, provider: memoryProvider({ snapshots: true }).provider, fs: files }
  })
  await reopened.ready()
  t.pass('the directory is free once its RAG closes')
  for (const rag of [a, b, reopened]) await rag.close()
})

test('dropNamespace deletes snapshots through the fs that wrote them', async (t) => {
  const store = await openStore(t)
  const dir = await tmp(t)
  const real = fs.promises as unknown as SnapshotFileSystem
  const unlinked: string[] = []
  const files: SnapshotFileSystem = {
    mkdir: (path, options) => real.mkdir(path, options),
    readFile: (path, encoding) => real.readFile(path, encoding),
    writeFile: (path, data) => real.writeFile(path, data),
    rename: (from, to) => real.rename(from, to),
    unlink: (path) => {
      unlinked.push(path)
      return real.unlink(path)
    }
  }
  const { provider } = memoryProvider({ snapshots: true })
  const writer = createRag({
    corestore: store,
    index: { dir, provider, fs: files, snapshotEvery: 1 }
  })
  await writer.ready()
  t.teardown(() => writer.close())
  const { spaceId } = await writer.createNamespace({ name: 'ns', space: SPACE })
  await writer.ingest({ namespace: 'ns', documents: ranked(spaceId, 2) })
  await writer.search({ scope: { namespace: 'ns' }, vector: QUERY, spaceId, k: 1 })
  unlinked.length = 0

  const dropper = createRag({ corestore: store, index: { provider: SCAN_ONLY } })
  await dropper.ready()
  t.teardown(() => dropper.close())
  await dropper.dropNamespace({ name: 'ns' })
  t.ok(
    unlinked.some((path) => path.endsWith('.json')),
    'the sidecar went through the writer fs'
  )
  const left = fs.readdirSync(dir).flatMap((core) => fs.readdirSync(`${dir}/${core}`))
  t.alike(left, [], 'nothing left behind')
})

test('a directory reclaimed with another fs while the core stays open writes through the new fs', async (t) => {
  const store = await openStore(t)
  const dir = await tmp(t)
  const { provider } = memoryProvider({ snapshots: true })
  function counting(): { files: SnapshotFileSystem; writes: string[] } {
    const real = fs.promises as unknown as SnapshotFileSystem
    const writes: string[] = []
    const files: SnapshotFileSystem = {
      mkdir: (path, options) => real.mkdir(path, options),
      readFile: (path, encoding) => real.readFile(path, encoding),
      rename: (from, to) => real.rename(from, to),
      unlink: (path) => real.unlink(path),
      writeFile: (path, data) => {
        writes.push(path)
        return real.writeFile(path, data)
      }
    }
    return { files, writes }
  }
  const first = counting()
  const second = counting()

  // Holds the core's shared index registry open across both RAGs below.
  const keeper = createRag({ corestore: store, index: { provider: SCAN_ONLY } })
  await keeper.ready()
  t.teardown(() => keeper.close())

  const a = createRag({
    corestore: store,
    index: { provider, dir, fs: first.files, snapshotEvery: 1 }
  })
  await a.ready()
  const { spaceId } = await a.createNamespace({ name: 'ns', space: SPACE })
  await a.ingest({ namespace: 'ns', documents: ranked(spaceId, 2) })
  await a.search({ scope: { namespace: 'ns' }, vector: QUERY, spaceId, k: 1 })
  t.ok(first.writes.length > 0, 'the first fs wrote a snapshot')
  await a.close()
  first.writes.length = 0

  const b = createRag({
    corestore: store,
    index: { provider, dir, fs: second.files, snapshotEvery: 1 }
  })
  await b.ready()
  t.teardown(() => b.close())
  await b.search({ scope: { namespace: 'ns' }, vector: QUERY, spaceId, k: 1 })
  await b.ingest({ namespace: 'ns', documents: [doc('d02', spaceId, [['d02', [2, 1, 0]]])] })
  t.ok(second.writes.length > 0, 'the new fs writes the snapshots')
  t.alike(first.writes, [], 'the released fs is not used again')
})
