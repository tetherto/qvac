import test from 'brittle'
import tmp from 'test-tmp'
import Corestore from 'corestore'
import fs from 'bare-fs'

import { ERR_CODES, createRag } from '../../src/index.js'
import {
  setNativeIndexLoader,
  type NativeIndex,
  type NativeIndexModule
} from '../../src/vector-index/native.js'
import { setSnapshotFileSystemLoader, type FileSystem } from '../../src/vector-index/snapshots.js'
import { SPACE, doc, realNativeIndex, rejectsWithCode, type Test } from './helpers.js'
import type { IndexFallbackEvent, IndexOptions, Rag } from '../../src/types.js'

interface Opened {
  rag: Rag
  spaceId: string
  dir: string
  events: IndexFallbackEvent[]
}

async function open(t: Test, index: IndexOptions = {}): Promise<Opened> {
  const store = new Corestore(await tmp(t))
  const dir = await tmp(t)
  const events: IndexFallbackEvent[] = []
  const rag = createRag({
    corestore: store,
    index: { dir, ...index },
    onIndexFallback: (event) => events.push(event)
  })
  await rag.ready()
  t.teardown(async () => {
    await rag.close()
    await store.close()
  })
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({
    namespace: 'ns',
    documents: [doc('a', spaceId, [['a', [1, 0, 0]]]), doc('b', spaceId, [['b', [0, 1, 0]]])]
  })
  return { rag, spaceId, dir, events }
}

function useLoader(t: Test, loader: () => Promise<NativeIndexModule | null>): void {
  setNativeIndexLoader(loader)
  t.teardown(() => setNativeIndexLoader(null))
}

function useFileSystem(t: Test, loader: () => Promise<FileSystem>): void {
  setSnapshotFileSystemLoader(loader)
  t.teardown(() => setSnapshotFileSystemLoader(null))
}

async function searchIds(rag: Rag, spaceId: string): Promise<string[]> {
  const hits = await rag.search({ scope: { namespace: 'ns' }, vector: [1, 0, 0], spaceId, k: 2 })
  return hits.map((hit) => hit.documentId)
}

function snapshotCount(dir: string): number {
  let count = 0
  for (const core of fs.readdirSync(dir)) {
    count += fs.readdirSync(`${dir}/${core}`).filter((file) => file.endsWith('.tvec')).length
  }
  return count
}

function failing(real: NativeIndexModule, method: 'addWithIds' | 'search'): NativeIndexModule {
  const wrap = (native: NativeIndex): NativeIndex =>
    new Proxy(native, {
      get(target, key) {
        if (key === method) return () => Promise.reject(new Error('addon fault'))
        const value = Reflect.get(target, key) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  return {
    create: (dim, storage) => wrap(real.create(dim, storage)),
    load: async (path) => wrap(await real.load(path))
  }
}

test('a host that seals module loading after ready() keeps the index and its snapshots', async (t) => {
  const real = await realNativeIndex()
  let sealed = false
  const loads = { native: 0, fs: 0 }
  function refuseOnceSealed(): void {
    if (sealed) throw new Error('module loading is sealed')
  }
  useLoader(t, () => {
    loads.native++
    refuseOnceSealed()
    return Promise.resolve(real)
  })
  useFileSystem(t, async () => {
    loads.fs++
    refuseOnceSealed()
    return (await import('bare-fs')).promises as unknown as FileSystem
  })

  const { rag, spaceId, dir } = await open(t, { snapshotEvery: 1 })
  sealed = true
  t.alike(await rag.indexStatus({ namespace: 'ns' }), { mode: 'unopened' })
  t.alike(await searchIds(rag, spaceId), ['a', 'b'])
  await rag.ingest({ namespace: 'ns', documents: [doc('c', spaceId, [['c', [0, 0, 1]]])] })

  t.alike(await rag.indexStatus({ namespace: 'ns' }), {
    mode: 'index',
    revision: 3,
    snapshot: 'ok'
  })
  t.is(snapshotCount(dir), 1, 'a snapshot was written after the seal')
  t.alike(loads, { native: 1, fs: 1 }, 'both loaded once, during ready()')
})

test('without the addon, status and the callback report addon-missing once', async (t) => {
  useLoader(t, () => Promise.resolve(null))
  const { rag, spaceId, events } = await open(t)
  t.alike(await rag.indexStatus({ namespace: 'ns' }), { mode: 'scan', reason: 'addon-missing' })
  t.alike(await searchIds(rag, spaceId), ['a', 'b'], 'the scan answers')
  await searchIds(rag, spaceId)
  t.alike(events, [{ namespace: 'ns', reason: 'addon-missing' }], 'reported once')
})

test('an addon that fails to load reports addon-load-failed with its error', async (t) => {
  const cause = new Error('no prebuild')
  useLoader(t, () => Promise.reject(cause))
  const { rag, spaceId, events } = await open(t)
  t.alike(await searchIds(rag, spaceId), ['a', 'b'])
  const status = await rag.indexStatus({ namespace: 'ns' })
  t.is(status.mode === 'scan' && status.reason, 'addon-load-failed')
  t.is(status.mode === 'scan' && status.error, cause, 'the error is kept')
  t.is(events.length, 1)
  t.is(events[0].error, cause)
})

for (const [method, reason] of [
  ['addWithIds', 'rebuild-failed'],
  ['search', 'search-failed']
] as const) {
  test(`a failing native ${method} reports ${reason}`, async (t) => {
    const module = failing(await realNativeIndex(), method)
    useLoader(t, () => Promise.resolve(module))
    const { rag, spaceId, events } = await open(t)
    t.alike(await searchIds(rag, spaceId), ['a', 'b'], 'the scan answers')
    const status = await rag.indexStatus({ namespace: 'ns' })
    t.is(status.mode === 'scan' && status.reason, reason)
    t.is(
      status.mode === 'scan' && (status.error as Error).message,
      'addon fault',
      'the error is kept'
    )
    await searchIds(rag, spaceId)
    t.alike(
      events.map((event) => [event.namespace, event.reason]),
      [['ns', reason]],
      'reported once'
    )
  })
}

test('a file system that fails to load keeps the index in memory', async (t) => {
  await realNativeIndex()
  const cause = new Error('fs sealed')
  useFileSystem(t, () => Promise.reject(cause))
  const { rag, spaceId, dir, events } = await open(t, { snapshotEvery: 1 })
  t.alike(await searchIds(rag, spaceId), ['a', 'b'])
  t.alike(await rag.indexStatus({ namespace: 'ns' }), {
    mode: 'index',
    revision: 2,
    snapshot: { error: cause }
  })
  t.is(snapshotCount(dir), 0)

  await rag.ingest({ namespace: 'ns', documents: [doc('c', spaceId, [['c', [0, 0, 1]]])] })
  t.alike(
    await rag.indexStatus({ namespace: 'ns' }),
    { mode: 'index', revision: 3, snapshot: { error: cause } },
    'a commit past snapshotEvery keeps the error'
  )
  t.alike(events, [], 'not a fallback')
})

test('an unreadable snapshot is reported until a snapshot is written', async (t) => {
  await realNativeIndex()
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close(), { order: 1 })
  const dir = await tmp(t)

  async function reopen(index: IndexOptions = {}): Promise<{ rag: Rag; spaceId: string }> {
    const rag = createRag({ corestore: store, index: { dir, ...index } })
    await rag.ready()
    t.teardown(() => rag.close())
    const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
    return { rag, spaceId }
  }
  function files(suffix: string): string[] {
    const found: string[] = []
    for (const core of fs.readdirSync(dir)) {
      for (const file of fs.readdirSync(`${dir}/${core}`)) {
        if (file.endsWith(suffix)) found.push(`${dir}/${core}/${file}`)
      }
    }
    return found
  }

  const first = await reopen()
  await first.rag.ingest({
    namespace: 'ns',
    documents: [doc('a', first.spaceId, [['a', [1, 0, 0]]])]
  })
  await searchIds(first.rag, first.spaceId)
  await first.rag.close()

  for (const file of files('.tvec')) fs.writeFileSync(file, 'truncated')
  const second = await reopen()
  t.alike(await searchIds(second.rag, second.spaceId), ['a'])
  const unloadable = await second.rag.indexStatus({ namespace: 'ns' })
  t.is(unloadable.mode, 'index', 'rebuilt from HyperDB')
  t.ok(
    unloadable.mode === 'index' && typeof unloadable.snapshot === 'object',
    'a snapshot the provider cannot load is reported'
  )
  await second.rag.close()

  for (const file of files('.json')) fs.writeFileSync(file, 'not json')
  const third = await reopen({ snapshotEvery: 2 })
  t.alike(await searchIds(third.rag, third.spaceId), ['a'])
  const unreadable = await third.rag.indexStatus({ namespace: 'ns' })
  t.ok(
    unreadable.mode === 'index' &&
      typeof unreadable.snapshot === 'object' &&
      unreadable.snapshot.error instanceof SyntaxError,
    'an unreadable sidecar is reported'
  )
  await third.rag.ingest({
    namespace: 'ns',
    documents: [doc('b', third.spaceId, [['b', [0, 1, 0]]])]
  })
  const written = await third.rag.indexStatus({ namespace: 'ns' })
  t.is(written.mode === 'index' && written.snapshot, 'ok', 'cleared once a snapshot is written')
})

test('a snapshot write failure keeps the index and is reported', async (t) => {
  await realNativeIndex()
  const real = (await import('bare-fs')).promises as unknown as FileSystem
  let failWrites = true
  useFileSystem(t, () =>
    Promise.resolve({
      ...real,
      mkdir: real.mkdir.bind(real),
      readFile: real.readFile.bind(real),
      rename: real.rename.bind(real),
      unlink: real.unlink.bind(real),
      writeFile: (path: string, data: string) =>
        failWrites ? Promise.reject(new Error('disk full')) : real.writeFile(path, data)
    })
  )
  const { rag, spaceId, events } = await open(t, { snapshotEvery: 1 })
  t.alike(await searchIds(rag, spaceId), ['a', 'b'])
  const status = await rag.indexStatus({ namespace: 'ns' })
  t.is(status.mode, 'index', 'still searched by the index')
  t.is(
    status.mode === 'index' &&
      typeof status.snapshot === 'object' &&
      (status.snapshot.error as Error).message,
    'disk full'
  )

  failWrites = false
  await rag.ingest({ namespace: 'ns', documents: [doc('c', spaceId, [['c', [0, 0, 1]]])] })
  t.alike(await rag.indexStatus({ namespace: 'ns' }), {
    mode: 'index',
    revision: 3,
    snapshot: 'ok'
  })
  t.alike(events, [])
})

test('indexStatus validates its namespace and a throwing callback never fails a search', async (t) => {
  useLoader(t, () => Promise.resolve(null))
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close(), { order: 1 })
  t.exception(
    () => createRag({ corestore: store, onIndexFallback: 'nope' as never }),
    /onIndexFallback must be a function/
  )
  const rag = createRag({
    corestore: store,
    onIndexFallback: () => {
      throw new Error('callback fault')
    }
  })
  await rag.ready()
  t.teardown(() => rag.close())
  const { spaceId } = await rag.createNamespace({ name: 'ns', space: SPACE })
  await rag.ingest({ namespace: 'ns', documents: [doc('a', spaceId, [['a', [1, 0, 0]]])] })
  t.alike(await searchIds(rag, spaceId), ['a'])

  await rejectsWithCode(
    t,
    rag.indexStatus({ namespace: 'missing' }),
    ERR_CODES.NAMESPACE_NOT_FOUND,
    'missing namespace'
  )
  await rejectsWithCode(
    t,
    rag.indexStatus({ name: 'ns' } as never),
    ERR_CODES.INVALID_INPUT,
    'wrong params'
  )
})
