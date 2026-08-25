import test from 'brittle'
import Corestore from 'corestore'
import fs from 'bare-fs'
import path from 'bare-path'
import tmp from 'test-tmp'
import HyperDB from 'hyperdb'
import IdMapIndex from '@qvac/embed-llamacpp/idMapIndex'

import {
  TurboVecAdapter,
  type TurboVecAdapterInput,
  type TurboVecIndex,
  type TurboVecIndexProvider
} from '../../src/adapters/database/TurboVecAdapter.js'
import dbSpec from '../../src/adapters/database/hyperspec/hyperdb/index.js'
import { ERR_CODES, QvacErrorRAG } from '../../src/errors.js'

const indexProvider: TurboVecIndexProvider = {
  create(options) {
    return new IdMapIndex(options)
  },
  load(snapshotPath) {
    return IdMapIndex.load(snapshotPath)
  }
}

// Simulate a runtime that cannot build a native index.
const unavailableIndexProvider: TurboVecIndexProvider = {
  create() {
    throw new Error('no native index is available here')
  },
  load() {
    throw new Error('no native index is available here')
  }
}

function vector(dimension: number, index: number): number[] {
  const value = Array<number>(dimension).fill(0)
  value[index] = 1
  return value
}

test('TurboVecAdapter requires an index provider', (t) => {
  try {
    new TurboVecAdapter({} as TurboVecAdapterInput)
    t.fail('constructor should reject a missing index provider')
  } catch (error) {
    t.ok(error instanceof QvacErrorRAG)
    if (error instanceof QvacErrorRAG) {
      t.is(error.code, ERR_CODES.DEPENDENCY_REQUIRED)
    }
  }
})

test('TurboVecAdapter persists, reopens, searches, and deletes', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const first = new TurboVecAdapter({
    store,
    dbName: 'turbovec-roundtrip',
    indexProvider,
    checkpointDir,
    checkpointEveryMutations: 100
  })

  await first.ready()
  const saved = await first.saveEmbeddings([
    {
      id: 'alpha',
      content: 'alpha document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    },
    {
      id: 'beta',
      content: 'beta document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  t.alike(
    saved.map((result) => result.status),
    ['fulfilled', 'fulfilled']
  )

  const beforeClose = await first.search('alpha', vector(8, 0), { topK: 1 })
  t.is(beforeClose[0]?.id, 'alpha')
  t.is(await first.checkpoint(), true)
  t.ok(first.vectorStorage === 'turbovec-q4' || first.vectorStorage === 'q8')
  await first.close()

  const reopened = new TurboVecAdapter({
    store,
    dbName: 'turbovec-roundtrip',
    indexProvider,
    checkpointDir
  })
  await reopened.ready()
  t.is(reopened.revision, 1)

  const afterOpen = await reopened.search('alpha', vector(8, 0), { topK: 1 })
  t.is(afterOpen[0]?.id, 'alpha')
  t.is(await reopened.deleteEmbeddings(['alpha']), true)

  const afterDelete = await reopened.search('alpha', vector(8, 0), { topK: 2 })
  t.is(
    afterDelete.find((result) => result.id === 'alpha'),
    undefined,
    'deleted document is removed from native candidates'
  )

  await reopened.close()
  await store.close()
})

test('TurboVecAdapter rejects a batch with mixed embedding dimensions', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-mixed-dimension',
    indexProvider,
    checkpointDir: path.join(tmpDir, 'index')
  })

  await adapter.ready()
  try {
    await adapter.saveEmbeddings([
      {
        id: 'eight',
        content: 'eight dimensions',
        embeddingModelId: 'test-model',
        embedding: vector(8, 0)
      },
      {
        id: 'sixteen',
        content: 'sixteen dimensions',
        embeddingModelId: 'test-model',
        embedding: vector(16, 0)
      }
    ])
    t.fail('a batch with mixed dimensions should be rejected')
  } catch (error) {
    t.ok(error instanceof QvacErrorRAG)
    if (error instanceof QvacErrorRAG) {
      t.is(error.code, ERR_CODES.EMBEDDING_DIMENSION_MISMATCH)
    }
  }

  t.is(await adapter.getConfig(), null, 'the rejected batch persisted nothing')

  await adapter.close()
  await store.close()
})

test('TurboVecAdapter stays usable when no native index can be built', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-no-native-index',
    indexProvider: unavailableIndexProvider,
    checkpointDir
  })

  await adapter.ready()
  const saved = await adapter.saveEmbeddings([
    {
      id: 'degraded',
      content: 'degraded document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])
  t.alike(
    saved.map((result) => result.status),
    ['fulfilled'],
    'documents are still written without a native index'
  )
  t.is(adapter.vectorStorage, null, 'no index storage is active')

  const results = await adapter.search('degraded', vector(8, 0), { topK: 1 })
  t.is(results[0]?.id, 'degraded', 'searches fall back to scanning the store')
  t.is(await adapter.deleteEmbeddings(['degraded']), true)

  await adapter.close()
  await store.close()
})

test('TurboVecAdapter uses generic full scan for unsupported dimensions', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-fallback',
    indexProvider,
    checkpointDir: path.join(tmpDir, 'index')
  })

  await adapter.ready()
  await adapter.saveEmbeddings([
    {
      id: 'fallback',
      content: 'generic fallback',
      embeddingModelId: 'test-model',
      embedding: vector(7, 0)
    }
  ])

  t.is(adapter.vectorStorage, 'q8')
  const results = await adapter.search('fallback', vector(7, 0), { topK: 1 })
  t.is(results[0]?.id, 'fallback')

  await adapter.close()
  await store.close()
})

test('TurboVecAdapter rejects a second writer for one checkpoint directory', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const first = new TurboVecAdapter({
    store,
    dbName: 'turbovec-lock',
    indexProvider,
    checkpointDir
  })
  const second = new TurboVecAdapter({
    store,
    dbName: 'turbovec-lock',
    indexProvider,
    checkpointDir
  })

  await first.ready()
  try {
    await second.ready()
    t.fail('second writer should not acquire the checkpoint lock')
  } catch (error) {
    t.ok(error instanceof Error)
    t.ok(String(error).includes('already locked'))
  }

  await first.close()
  await store.close()
})

test('TurboVecAdapter recovers a stale writer lock after a crash', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const lockDir = path.join(checkpointDir, 'writer.lock')
  fs.mkdirSync(checkpointDir, { recursive: true })
  fs.writeFileSync(lockDir, 'crashed-writer\n')

  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-stale-lock',
    indexProvider,
    checkpointDir,
    lockStaleMs: 0
  })
  await adapter.ready()
  t.ok(fs.existsSync(lockDir), 'stale lock is replaced by the active writer lock')

  await adapter.close()
  t.is(fs.existsSync(lockDir), false, 'active writer lock is removed on close')
  await store.close()
})

test('TurboVecAdapter search does not wait for the writer queue', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-search-queue',
    indexProvider,
    checkpointDir: path.join(tmpDir, 'index')
  })
  await adapter.ready()
  await adapter.saveEmbeddings([
    {
      id: 'searchable',
      content: 'searchable document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const internals = adapter as unknown as {
    operationTail: Promise<void>
    index: TurboVecIndex
  }
  let releaseWriter!: () => void
  internals.operationTail = new Promise<void>((resolve) => {
    releaseWriter = resolve
  })
  let nativeSearches = 0
  const nativeSearch = internals.index.search.bind(internals.index)
  internals.index.search = (queries, k) => {
    nativeSearches++
    return nativeSearch(queries, k)
  }

  const search = adapter.search('searchable', vector(8, 0), { topK: 1 })
  t.is(nativeSearches, 1, 'native search starts while a writer is queued')
  releaseWriter()
  t.is((await search)[0]?.id, 'searchable')

  await adapter.close()
  await store.close()
})

test('TurboVecAdapter close waits for admitted searches', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-close-search',
    indexProvider,
    checkpointDir: path.join(tmpDir, 'index')
  })
  await adapter.ready()
  await adapter.saveEmbeddings([
    {
      id: 'searchable',
      content: 'searchable document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const internals = adapter as unknown as {
    _search: typeof adapter.search
  }
  const originalSearch = internals._search.bind(adapter)
  let releaseSearch!: () => void
  const searchGate = new Promise<void>((resolve) => {
    releaseSearch = resolve
  })
  internals._search = async (...args) => {
    await searchGate
    return originalSearch(...args)
  }

  const search = adapter.search('searchable', vector(8, 0), { topK: 1 })
  let closed = false
  const close = adapter.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  t.is(closed, false, 'close waits for the admitted search')

  try {
    await adapter.search('searchable', vector(8, 0), { topK: 1 })
    t.fail('new searches should be rejected while closing')
  } catch (error) {
    t.ok(error instanceof QvacErrorRAG)
  }

  releaseSearch()
  t.is((await search)[0]?.id, 'searchable')
  await close
  t.ok(closed)
  await store.close()
})

test('TurboVecAdapter does not write JS IVF data', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const core = store.get({ name: 'turbovec-no-ivf' })
  const db = HyperDB.bee(core, dbSpec, { autoUpdate: true })
  const adapter = new TurboVecAdapter({
    db,
    indexProvider,
    checkpointDir: path.join(tmpDir, 'index')
  })

  await adapter.ready()
  await adapter.saveEmbeddings([
    {
      id: 'native-only',
      content: 'native index only',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const snapshot = db.snapshot()
  try {
    t.alike(await snapshot.find('@rag/centroids').toArray(), [])
    t.alike(await snapshot.find('@rag/ivfBuckets').toArray(), [])
  } finally {
    await snapshot.close()
  }

  await adapter.close()
  await store.close()
})
