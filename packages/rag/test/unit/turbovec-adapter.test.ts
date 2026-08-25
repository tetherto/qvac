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
import type { HyperDBInstance } from '../../src/adapters/database/db-types.js'
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

// Counts provider calls so a test can tell a checkpoint load from a rebuild.
function countingIndexProvider() {
  const calls = { create: 0, load: 0 }
  const provider: TurboVecIndexProvider = {
    create(options) {
      calls.create++
      return new IdMapIndex(options)
    },
    load(snapshotPath) {
      calls.load++
      return IdMapIndex.load(snapshotPath)
    }
  }
  return { provider, calls }
}

function controllableAddFailureProvider() {
  const control = { failNextAdd: false }
  function wrap(index: TurboVecIndex) {
    const addWithIds = index.addWithIds.bind(index)
    index.addWithIds = (vectors, ids) => {
      if (control.failNextAdd) {
        control.failNextAdd = false
        throw new Error('injected native add failure')
      }
      addWithIds(vectors, ids)
    }
    return index
  }
  const provider: TurboVecIndexProvider = {
    create(options) {
      return wrap(new IdMapIndex(options))
    },
    load(snapshotPath) {
      return wrap(IdMapIndex.load(snapshotPath))
    }
  }
  return { provider, control }
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
  let nativeSearchStarted!: () => void
  const searchStarted = new Promise<void>((resolve) => {
    nativeSearchStarted = resolve
  })
  internals.index.search = (queries, k) => {
    nativeSearches++
    nativeSearchStarted()
    return nativeSearch(queries, k)
  }
  const search = adapter.search('searchable', vector(8, 0), { topK: 1 })
  await searchStarted
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

test('TurboVecAdapter replays mutations committed after the last checkpoint', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const first = new TurboVecAdapter({
    store,
    dbName: 'turbovec-replay',
    indexProvider,
    checkpointDir
  })

  await first.ready()
  await first.saveEmbeddings([
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
  t.is(await first.checkpoint(), true)

  await first.saveEmbeddings([
    {
      id: 'gamma',
      content: 'gamma document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 2)
    }
  ])
  await first.deleteEmbeddings(['beta'])
  const revisionBeforeCrash = first.revision

  // Simulate a crash between the HyperDB commits and the next checkpoint:
  // clearing the dirty flag makes close() skip its checkpoint, so the
  // manifest stays behind the workspace revision.
  ;(first as unknown as { dirty: boolean }).dirty = false
  await first.close()

  const counting = countingIndexProvider()
  const reopened = new TurboVecAdapter({
    store,
    dbName: 'turbovec-replay',
    indexProvider: counting.provider,
    checkpointDir
  })
  await reopened.ready()
  t.is(counting.calls.load, 1, 'the checkpoint snapshot is loaded')
  t.is(counting.calls.create, 0, 'replay does not trigger a full rebuild')
  t.is(reopened.revision, revisionBeforeCrash, 'replay reaches the workspace revision')

  const results = await reopened.search('gamma', vector(8, 2), { topK: 3 })
  t.is(results[0]?.id, 'gamma', 'a document committed after the checkpoint is found')
  t.is(
    results.find((result) => result.id === 'beta'),
    undefined,
    'a document deleted after the checkpoint stays gone'
  )

  await reopened.close()
  await store.close()
})

test('TurboVecAdapter rebuilds from HyperDB when the checkpoint is corrupt', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const first = new TurboVecAdapter({
    store,
    dbName: 'turbovec-corrupt-checkpoint',
    indexProvider,
    checkpointDir
  })

  await first.ready()
  await first.saveEmbeddings([
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
  await first.deleteEmbeddings(['beta'])
  const revisionBeforeCorruption = first.revision
  await first.close()

  fs.writeFileSync(path.join(checkpointDir, 'manifest.json'), 'not a manifest\n')

  const counting = countingIndexProvider()
  const reopened = new TurboVecAdapter({
    store,
    dbName: 'turbovec-corrupt-checkpoint',
    indexProvider: counting.provider,
    checkpointDir
  })
  await reopened.ready()
  t.is(counting.calls.load, 0, 'the corrupt checkpoint is never loaded')
  t.ok(counting.calls.create >= 1, 'the index is rebuilt from HyperDB rows')
  t.is(reopened.revision, revisionBeforeCorruption, 'the rebuild reaches the workspace revision')

  const results = await reopened.search('alpha', vector(8, 0), { topK: 2 })
  t.is(results[0]?.id, 'alpha', 'documents survive the rebuild')
  t.is(
    results.find((result) => result.id === 'beta'),
    undefined,
    'deleted documents stay out of the rebuilt index'
  )

  await reopened.close()
  await store.close()
})

test('TurboVecAdapter does not checkpoint an index after a native apply failure', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const failing = controllableAddFailureProvider()
  const first = new TurboVecAdapter({
    store,
    dbName: 'turbovec-apply-recovery',
    indexProvider: failing.provider,
    checkpointDir,
    checkpointEveryMutations: 100
  })

  await first.ready()
  await first.saveEmbeddings([
    {
      id: 'baseline',
      content: 'baseline document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])
  t.is(await first.checkpoint(), true)

  failing.control.failNextAdd = true
  await first.saveEmbeddings([
    {
      id: 'failed-native-apply',
      content: 'committed despite native failure',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  await first.saveEmbeddings([
    {
      id: 'later-save',
      content: 'later successful save',
      embeddingModelId: 'test-model',
      embedding: vector(8, 2)
    }
  ])

  t.is(
    await first.checkpoint(),
    false,
    'a known-inconsistent native index cannot become authoritative'
  )
  await first.close()

  const reopened = new TurboVecAdapter({
    store,
    dbName: 'turbovec-apply-recovery',
    indexProvider,
    checkpointDir
  })
  await reopened.ready()
  const missing = await reopened.search('failed', vector(8, 1), { topK: 1 })
  const later = await reopened.search('later', vector(8, 2), { topK: 1 })
  t.is(missing[0]?.id, 'failed-native-apply', 'journal replay restores the failed native add')
  t.is(later[0]?.id, 'later-save', 'journal replay also restores the later save')

  await reopened.close()
  await store.close()
})

test('TurboVecAdapter keeps rebuild state uncommitted when mapping persistence fails', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-mapping-failure',
    indexProvider,
    checkpointDir
  })

  await adapter.ready()
  await adapter.saveEmbeddings([
    {
      id: 'mapping-required',
      content: 'mapping persistence must succeed',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const database = (
    adapter as unknown as {
      storage: { db: HyperDBInstance }
    }
  ).storage.db
  const snapshot = database.snapshot()
  const mappings = await snapshot.find<{ nativeId: string }>('@rag/nativeIds').toArray()
  await snapshot.close()
  const tx = await database.exclusiveTransaction()
  try {
    await Promise.all(
      mappings.map((mapping) => tx.delete('@rag/nativeIds', { nativeId: mapping.nativeId }))
    )
    await tx.flush()
  } finally {
    await tx.close()
  }

  const internals = adapter as unknown as {
    _persistMissingMappings: () => Promise<void>
  }
  internals._persistMissingMappings = () =>
    Promise.reject(new Error('injected mapping persistence failure'))
  try {
    await adapter.reindex()
    t.fail('reindex should fail when native-id mappings cannot be persisted')
  } catch (error) {
    t.ok(String(error).includes('mapping persistence failure'))
  }
  t.is(await adapter.checkpoint(), false, 'the failed rebuild cannot be checkpointed')
  await adapter.close()

  const reopened = new TurboVecAdapter({
    store,
    dbName: 'turbovec-mapping-failure',
    indexProvider,
    checkpointDir
  })
  await reopened.ready()
  const results = await reopened.search('mapping', vector(8, 0), { topK: 1 })
  t.is(results[0]?.id, 'mapping-required', 'reopen rebuilds mappings without losing the hit')

  await reopened.close()
  await store.close()
})

test('TurboVecAdapter first search refreshes a lagging adapter', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const first = new TurboVecAdapter({
    store,
    dbName: 'turbovec-search-refresh',
    indexProvider,
    checkpointDir: path.join(tmpDir, 'first-index')
  })
  await first.ready()
  await first.saveEmbeddings([
    {
      id: 'baseline',
      content: 'baseline document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const lagging = new TurboVecAdapter({
    store,
    dbName: 'turbovec-search-refresh',
    indexProvider,
    checkpointDir: path.join(tmpDir, 'lagging-index')
  })
  await lagging.ready()
  await first.saveEmbeddings([
    {
      id: 'new-match',
      content: 'newly committed matching document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])

  const results = await lagging.search('new', vector(8, 1), { topK: 1 })
  t.is(results[0]?.id, 'new-match', 'the first search waits for the needed refresh')

  await lagging.close()
  await first.close()
  await store.close()
})

test('TurboVecAdapter first search refreshes after a visible revision rollback', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-search-rollback',
    indexProvider,
    checkpointDir: path.join(tmpDir, 'index'),
    candidateMultiplier: 1
  })
  await adapter.ready()
  await adapter.saveEmbeddings([
    {
      id: 'rollback-survivor',
      content: 'document retained by rollback',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  await adapter.saveEmbeddings([
    {
      id: 'rolled-back',
      content: 'document removed by rollback',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const database = (
    adapter as unknown as {
      storage: { db: HyperDBInstance }
    }
  ).storage.db
  const tx = await database.exclusiveTransaction()
  try {
    await tx.delete('@rag/documents', { id: 'rolled-back' })
    await tx.delete('@rag/vectors', { docId: 'rolled-back' })
    await tx.insert('@rag/workspaceState', {
      key: 'workspace',
      revision: 1,
      updatedAt: new Date()
    })
    await tx.flush()
  } finally {
    await tx.close()
  }

  const results = await adapter.search('rollback', vector(8, 0), { topK: 1 })
  t.is(
    results[0]?.id,
    'rollback-survivor',
    'the first search rebuilds instead of using higher-revision native candidates'
  )
  t.is(
    results.find((result) => result.id === 'rolled-back'),
    undefined,
    'a candidate removed by rollback is not returned'
  )

  await adapter.close()
  await store.close()
})

test('TurboVecAdapter prefetches replay data before mutating the live index', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const first = new TurboVecAdapter({
    store,
    dbName: 'turbovec-atomic-replay',
    indexProvider,
    checkpointDir: path.join(tmpDir, 'first-index')
  })
  await first.ready()
  await first.saveEmbeddings([
    {
      id: 'baseline',
      content: 'baseline document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const lagging = new TurboVecAdapter({
    store,
    dbName: 'turbovec-atomic-replay',
    indexProvider,
    checkpointDir: path.join(tmpDir, 'lagging-index')
  })
  await lagging.ready()
  await first.saveEmbeddings([
    {
      id: 'first-replay',
      content: 'first replay document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  await first.saveEmbeddings([
    {
      id: 'blocked-replay',
      content: 'blocked replay document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 2)
    }
  ])

  const internals = lagging as unknown as {
    index: TurboVecIndex
    storage: { db: HyperDBInstance }
  }
  let nativeMutations = 0
  const addWithIds = internals.index.addWithIds.bind(internals.index)
  const remove = internals.index.remove.bind(internals.index)
  internals.index.addWithIds = (vectors, ids) => {
    nativeMutations++
    addWithIds(vectors, ids)
  }
  internals.index.remove = (id) => {
    nativeMutations++
    return remove(id)
  }

  const database = internals.storage.db
  const createSnapshot = database.snapshot.bind(database)
  let releaseBlockedRead!: () => void
  const blockedRead = new Promise<void>((resolve) => {
    releaseBlockedRead = resolve
  })
  let blockedReadStarted!: () => void
  const readStarted = new Promise<void>((resolve) => {
    blockedReadStarted = resolve
  })
  database.snapshot = () => {
    const snapshot = createSnapshot()
    const get = snapshot.get.bind(snapshot)
    snapshot.get = async (table, query) => {
      if (table === '@rag/vectors' && (query as { docId?: string }).docId === 'blocked-replay') {
        blockedReadStarted()
        await blockedRead
      }
      return get(table, query)
    }
    return snapshot
  }

  const firstSearch = lagging.search('blocked', vector(8, 2), { topK: 1 })
  await readStarted
  t.is(nativeMutations, 0, 'no replay mutation is visible while data is still loading')
  const concurrentSearch = lagging.search('first', vector(8, 1), { topK: 1 })
  await Promise.resolve()
  t.is(nativeMutations, 0, 'a concurrent search cannot observe a half-replayed index')

  releaseBlockedRead()
  t.is((await firstSearch)[0]?.id, 'blocked-replay')
  t.is((await concurrentSearch)[0]?.id, 'first-replay')
  database.snapshot = createSnapshot

  await lagging.close()
  await first.close()
  await store.close()
})

test('TurboVecAdapter updates writer heartbeat records atomically', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-atomic-heartbeat',
    indexProvider,
    checkpointDir
  })
  await adapter.ready()

  const lockDir = path.join(checkpointDir, 'writer.lock')
  const ownerPath = path.join(lockDir, 'owner.json')
  const before = fs.readFileSync(ownerPath, 'utf8')
  const internals = adapter as unknown as {
    _writeLockRecord: (lockPath: string) => void
  }
  const renameSync = fs.renameSync
  let replacementObserved = false
  fs.renameSync = (from, to) => {
    if (
      to === ownerPath &&
      typeof from === 'string' &&
      from.startsWith(path.join(lockDir, 'owner.json.tmp-'))
    ) {
      replacementObserved = true
      const readerVisibleRecord = fs.readFileSync(ownerPath, 'utf8')
      t.is(
        readerVisibleRecord,
        before,
        'the existing owner record remains unchanged until replacement'
      )
      t.ok(JSON.parse(readerVisibleRecord).owner, 'the reader-visible owner record stays valid')
      t.ok(
        JSON.parse(fs.readFileSync(from, 'utf8')).owner,
        'the complete replacement exists before rename'
      )
    }
    renameSync(from, to)
  }
  try {
    internals._writeLockRecord(lockDir)
  } finally {
    fs.renameSync = renameSync
  }
  const after = fs.readFileSync(ownerPath, 'utf8')

  t.ok(replacementObserved, 'heartbeat updates owner.json through atomic rename')
  t.ok(before.endsWith('\n'), 'the original lock record has a final newline')
  t.ok(after.endsWith('\n'), 'the replacement lock record has a final newline')
  t.ok(JSON.parse(after).owner, 'the replacement lock record stays valid JSON')
  t.alike(
    fs.readdirSync(lockDir).filter((entry) => entry.startsWith('owner.json.tmp-')),
    [],
    'heartbeat replacement leaves no temporary artifacts'
  )

  await adapter.close()
  await store.close()
})

test('TurboVecAdapter fences a checkpoint after writer lock loss', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-checkpoint-fence',
    indexProvider,
    checkpointDir,
    checkpointEveryMutations: 100
  })
  await adapter.ready()
  await adapter.saveEmbeddings([
    {
      id: 'before-lock-loss',
      content: 'must not be checkpointed by a former owner',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const lockDir = path.join(checkpointDir, 'writer.lock')
  const stolenLockDir = path.join(checkpointDir, 'writer.lock.stolen')
  const internals = adapter as unknown as {
    index: TurboVecIndex
  }
  const write = internals.index.write.bind(internals.index)
  internals.index.write = (snapshotPath) => {
    write(snapshotPath)
    fs.renameSync(lockDir, stolenLockDir)
    fs.mkdirSync(lockDir)
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ owner: 'competitor', updatedAt: Date.now() })}\n`
    )
  }

  try {
    await adapter.checkpoint()
    t.fail('checkpoint should stop after ownership is lost')
  } catch (error) {
    t.ok(String(error).includes('lock ownership was lost'))
  }
  t.is(fs.existsSync(path.join(checkpointDir, 'manifest.json')), false)
  try {
    await adapter.saveEmbeddings([
      {
        id: 'after-lock-loss',
        content: 'former writer must be fenced',
        embeddingModelId: 'test-model',
        embedding: vector(8, 1)
      }
    ])
    t.fail('later writes should reject the fenced adapter')
  } catch (error) {
    t.ok(String(error).includes('lock ownership was lost'))
  }

  await adapter.close()
  t.is(
    JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).owner,
    'competitor',
    'close does not remove the new owner lock'
  )
  fs.unlinkSync(path.join(lockDir, 'owner.json'))
  fs.rmdirSync(lockDir)
  fs.unlinkSync(path.join(stolenLockDir, 'owner.json'))
  fs.rmdirSync(stolenLockDir)
  await store.close()
})
