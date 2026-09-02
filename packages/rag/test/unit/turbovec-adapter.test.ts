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
import { HyperDBAdapter } from '../../src/adapters/database/HyperDBAdapter.js'
import type { HyperDBInstance, HyperDBTransaction } from '../../src/adapters/database/db-types.js'
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
  const calls = { create: 0, load: 0, loadedPaths: [] as string[] }
  const provider: TurboVecIndexProvider = {
    create(options) {
      calls.create++
      return new IdMapIndex(options)
    },
    load(snapshotPath) {
      calls.load++
      calls.loadedPaths.push(snapshotPath)
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

function searchCountingIndexProvider() {
  const calls = { search: 0 }
  function wrap(index: TurboVecIndex) {
    const search = index.search.bind(index)
    index.search = (queries, k) => {
      calls.search++
      return search(queries, k)
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
  return { provider, calls }
}

function vector(dimension: number, index: number): number[] {
  const value = Array<number>(dimension).fill(0)
  value[index] = 1
  return value
}

function checkpointWorkspaceDir(adapter: TurboVecAdapter): string {
  const directory = (
    adapter as unknown as {
      checkpointWorkspaceDir: string | null
    }
  ).checkpointWorkspaceDir
  if (!directory) throw new Error('checkpoint workspace directory is not initialized')
  return directory
}

function installForeignWriter(lockDir: string, displacedLockDir: string) {
  fs.renameSync(lockDir, displacedLockDir)
  fs.mkdirSync(lockDir)
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    `${JSON.stringify({ owner: 'competitor', updatedAt: Date.now() })}\n`
  )
}

function removeTestWriterLocks(lockDir: string, displacedLockDir: string) {
  fs.unlinkSync(path.join(lockDir, 'owner.json'))
  fs.rmdirSync(lockDir)
  fs.unlinkSync(path.join(displacedLockDir, 'owner.json'))
  fs.rmdirSync(displacedLockDir)
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

test('TurboVecAdapter rejects invalid lock timing configuration', (t) => {
  const invalidConfigurations: Array<{
    input: Partial<TurboVecAdapterInput>
    message: string
  }> = [
    { input: { lockStaleMs: 0 }, message: 'lockStaleMs must be a finite positive number' },
    { input: { lockStaleMs: -1 }, message: 'lockStaleMs must be a finite positive number' },
    { input: { lockStaleMs: Number.NaN }, message: 'lockStaleMs must be a finite positive number' },
    {
      input: { lockStaleMs: Number.POSITIVE_INFINITY },
      message: 'lockStaleMs must be a finite positive number'
    },
    {
      input: { lockHeartbeatMs: 0 },
      message: 'lockHeartbeatMs must be a finite positive number'
    },
    {
      input: { lockHeartbeatMs: -1 },
      message: 'lockHeartbeatMs must be a finite positive number'
    },
    {
      input: { lockHeartbeatMs: Number.NaN },
      message: 'lockHeartbeatMs must be a finite positive number'
    },
    {
      input: { lockHeartbeatMs: Number.POSITIVE_INFINITY },
      message: 'lockHeartbeatMs must be a finite positive number'
    },
    {
      input: { lockStaleMs: 100, lockHeartbeatMs: 100 },
      message: 'lockHeartbeatMs must be less than lockStaleMs'
    },
    {
      input: { lockStaleMs: 100, lockHeartbeatMs: 101 },
      message: 'lockHeartbeatMs must be less than lockStaleMs'
    }
  ]

  for (const { input, message } of invalidConfigurations) {
    try {
      new TurboVecAdapter({ indexProvider, ...input })
      t.fail(`constructor should reject ${JSON.stringify(input)}`)
    } catch (error) {
      t.ok(error instanceof QvacErrorRAG)
      if (error instanceof QvacErrorRAG) {
        t.is(error.code, ERR_CODES.INVALID_PARAMS)
      }
      t.ok(String(error).includes(message))
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
  const probe = new TurboVecAdapter({
    store,
    dbName: 'turbovec-stale-lock',
    indexProvider,
    checkpointDir
  })
  await probe.ready()
  const lockDir = path.join(checkpointWorkspaceDir(probe), 'writer.lock')
  await probe.close()
  fs.mkdirSync(lockDir)
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    `${JSON.stringify({ owner: 'crashed-writer', updatedAt: 1 })}\n`
  )

  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-stale-lock',
    indexProvider,
    checkpointDir,
    lockStaleMs: 1_000,
    lockHeartbeatMs: 100
  })
  await adapter.ready()
  t.ok(fs.existsSync(lockDir), 'stale lock is replaced by the active writer lock')

  await adapter.close()
  t.is(fs.existsSync(lockDir), false, 'active writer lock is removed on close')
  await store.close()
})

test('TurboVecAdapter refuses a live lock after a heartbeat update', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const lockTiming = { lockStaleMs: 10_000, lockHeartbeatMs: 5_000 }
  const first = new TurboVecAdapter({
    store,
    dbName: 'turbovec-live-heartbeat-lock',
    indexProvider,
    checkpointDir,
    ...lockTiming
  })
  await first.ready()

  const lockDir = path.join(checkpointWorkspaceDir(first), 'writer.lock')
  const ownerPath = path.join(lockDir, 'owner.json')
  const initial = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as { updatedAt: number }
  const heartbeatAt = initial.updatedAt + 50_000
  const internals = first as unknown as {
    _writeLockRecord: (lockPath: string) => void
  }
  const dateNow = Date.now
  Date.now = () => heartbeatAt
  internals._writeLockRecord(lockDir)
  const heartbeat = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as { updatedAt: number }
  t.is(heartbeat.updatedAt, heartbeatAt, 'the heartbeat advances the lock timestamp')

  Date.now = () => heartbeatAt + lockTiming.lockStaleMs - 1
  const second = new TurboVecAdapter({
    store,
    dbName: 'turbovec-live-heartbeat-lock',
    indexProvider,
    checkpointDir,
    ...lockTiming
  })
  try {
    await second.ready()
    t.fail('a lock refreshed within the stale timeout must remain protected')
  } catch (error) {
    t.ok(String(error).includes('already locked'))
  } finally {
    Date.now = dateNow
  }

  await first.close()
  await store.close()
})

test('TurboVecAdapter recovers after a temporary owner-record read failure', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const counting = searchCountingIndexProvider()
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-temporary-owner-read',
    indexProvider: counting.provider,
    checkpointDir: path.join(tmpDir, 'index')
  })
  await adapter.ready()

  const ownerPath = path.join(checkpointWorkspaceDir(adapter), 'writer.lock', 'owner.json')
  const originalOwner = fs.readFileSync(ownerPath, 'utf8')
  const fileSystem = fs as unknown as {
    readFileSync(filePath: string, encoding: 'utf8'): string
  }
  const readFileSync = fileSystem.readFileSync
  let failOwnerRead = true
  fileSystem.readFileSync = (filePath, encoding) => {
    if (filePath === ownerPath && failOwnerRead) {
      failOwnerRead = false
      throw new Error('injected temporary owner-record read failure')
    }
    return readFileSync(filePath, encoding)
  }
  try {
    await adapter.saveEmbeddings([
      {
        id: 'denied-during-read-failure',
        content: 'must not be written while ownership is uncertain',
        embeddingModelId: 'test-model',
        embedding: vector(8, 0)
      }
    ])
    t.fail('a write must fail while lock ownership cannot be read')
  } catch (error) {
    t.ok(String(error).includes('ownership could not be confirmed'))
  } finally {
    fileSystem.readFileSync = readFileSync
  }
  t.is(await adapter.getConfig(), null, 'the failed ownership check persists no write state')
  t.is(fs.readFileSync(ownerPath, 'utf8'), originalOwner, 'the owner record remains unchanged')

  await adapter.saveEmbeddings([
    {
      id: 'recovered-after-read-failure',
      content: 'write succeeds after owner record reads recover',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  const results = await adapter.search('recovered', vector(8, 1), { topK: 1 })
  t.is(results[0]?.id, 'recovered-after-read-failure')
  t.is(counting.calls.search, 1, 'the recovered adapter uses its native index')

  await adapter.close()
  await store.close()
})

test('TurboVecAdapter recovers writes and native search after temporary invalid owner JSON', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const dbName = 'turbovec-temporary-invalid-owner'
  const counting = searchCountingIndexProvider()
  const adapter = new TurboVecAdapter({
    store,
    dbName,
    indexProvider: counting.provider,
    checkpointDir: path.join(tmpDir, 'index')
  })
  const hyperdb = new HyperDBAdapter({ store, dbName })
  await adapter.ready()
  await hyperdb.ready()
  await adapter.saveEmbeddings([
    {
      id: 'baseline',
      content: 'baseline native document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])
  await hyperdb.saveEmbeddings([
    {
      id: 'external-update',
      content: 'external update visible during lock uncertainty',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])

  const ownerPath = path.join(checkpointWorkspaceDir(adapter), 'writer.lock', 'owner.json')
  const originalOwner = fs.readFileSync(ownerPath, 'utf8')
  fs.writeFileSync(ownerPath, '{invalid owner json\n')
  try {
    try {
      await adapter.saveEmbeddings([
        {
          id: 'denied-during-invalid-json',
          content: 'must not be written while ownership is uncertain',
          embeddingModelId: 'test-model',
          embedding: vector(8, 2)
        }
      ])
      t.fail('a write must fail while the owner record is invalid')
    } catch (error) {
      t.ok(String(error).includes('ownership could not be confirmed'))
    }

    const denied = await hyperdb.search('denied', vector(8, 2), { topK: 3 })
    t.is(
      denied.find((result) => result.id === 'denied-during-invalid-json'),
      undefined,
      'the failed ownership check leaves shared documents unchanged'
    )
    const fallback = await adapter.search('external', vector(8, 1), { topK: 1 })
    t.is(
      fallback[0]?.id,
      'external-update',
      'search safely scans HyperDB while ownership is uncertain'
    )
    t.is(counting.calls.search, 0, 'the uncertain refresh does not use a stale native index')
  } finally {
    fs.writeFileSync(ownerPath, originalOwner)
  }

  await adapter.saveEmbeddings([
    {
      id: 'recovered-after-invalid-json',
      content: 'write succeeds after the valid owner record returns',
      embeddingModelId: 'test-model',
      embedding: vector(8, 2)
    }
  ])
  const recovered = await adapter.search('recovered', vector(8, 2), { topK: 1 })
  t.is(recovered[0]?.id, 'recovered-after-invalid-json')
  t.ok(counting.calls.search > 0, 'native search resumes without reconstructing the adapter')

  await hyperdb.close()
  await adapter.close()
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

test('HyperDBAdapter mutations refresh a live TurboVecAdapter', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const dbName = 'hyperdb-turbovec-interoperability'
  const hyperdb = new HyperDBAdapter({ store, dbName })
  await hyperdb.ready()
  await hyperdb.saveEmbeddings([
    {
      id: 'plain-seed',
      content: 'plain adapter seed',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const initialSnapshot = hyperdb.db!.snapshot()
  const initialState = await initialSnapshot.get<{ revision: number }>('@rag/workspaceState', {
    key: 'workspace'
  })
  const initialMutations = await initialSnapshot
    .find<{ revision: number; operation: string }>('@rag/mutations')
    .toArray()
  await initialSnapshot.close()
  t.is(initialState?.revision, 1, 'the plain adapter initializes shared workspace state')
  t.alike(
    initialMutations.map((mutation) => [mutation.revision, mutation.operation]),
    [[1, 'upsert']],
    'the plain adapter starts the shared mutation journal'
  )

  const turbovec = new TurboVecAdapter({
    store,
    dbName,
    indexProvider,
    checkpointDir: path.join(tmpDir, 'index')
  })
  await turbovec.ready()

  await hyperdb.saveEmbeddings([
    {
      id: 'plain-added',
      content: 'plain adapter added this document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  const afterPlainSave = await turbovec.search('added', vector(8, 1), { topK: 1 })
  t.is(afterPlainSave[0]?.id, 'plain-added', 'the first search replays the plain adapter save')

  await turbovec.saveEmbeddings([
    {
      id: 'turbovec-middle',
      content: 'turbovec journal entry between plain writes',
      embeddingModelId: 'test-model',
      embedding: vector(8, 2)
    }
  ])
  await hyperdb.deleteEmbeddings(['plain-added'])

  const afterPlainDelete = await turbovec.search('added', vector(8, 1), { topK: 3 })
  t.is(
    afterPlainDelete.find((result) => result.id === 'plain-added'),
    undefined,
    'the first search replays the plain adapter delete'
  )

  const finalSnapshot = hyperdb.db!.snapshot()
  const finalState = await finalSnapshot.get<{ revision: number }>('@rag/workspaceState', {
    key: 'workspace'
  })
  const finalMutations = await finalSnapshot.find<{ revision: number }>('@rag/mutations').toArray()
  await finalSnapshot.close()
  t.is(finalState?.revision, 4, 'both adapters advance one shared revision')
  t.alike(
    finalMutations.map((mutation) => mutation.revision),
    [1, 2, 3, 4],
    'mixed adapter writes keep a continuous journal'
  )

  await turbovec.close()
  await hyperdb.close()
  await store.close()
})

test('TurboVecAdapter serializes concurrent writers on one database', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const dbName = 'turbovec-concurrent-writers'
  const turbovec = new TurboVecAdapter({ store, dbName, indexProvider })
  const hyperdb = new HyperDBAdapter({ store, dbName })
  await turbovec.ready()
  await hyperdb.ready()
  await hyperdb.saveEmbeddings([
    {
      id: 'seed',
      content: 'seed the shared config before concurrent writes',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const [turboResults, plainResults] = await Promise.all([
    turbovec.saveEmbeddings([
      {
        id: 'turbovec-doc',
        content: 'saved by the turbovec adapter',
        embeddingModelId: 'test-model',
        embedding: vector(8, 1)
      }
    ]),
    hyperdb.saveEmbeddings([
      {
        id: 'plain-doc',
        content: 'saved by the plain adapter',
        embeddingModelId: 'test-model',
        embedding: vector(8, 2)
      }
    ])
  ])
  t.is(
    turboResults[0]?.status,
    'fulfilled',
    'the turbovec save commits despite a concurrent writer'
  )
  t.is(plainResults[0]?.status, 'fulfilled', 'the plain save commits despite a concurrent writer')

  const snapshot = hyperdb.db!.snapshot()
  const state = await snapshot.get<{ revision: number }>('@rag/workspaceState', {
    key: 'workspace'
  })
  const mutations = await snapshot
    .find<{ revision: number; documentIds: string[] }>('@rag/mutations')
    .toArray()
  await snapshot.close()
  t.is(state?.revision, 3, 'concurrent saves allocate distinct revisions')
  t.alike(
    mutations.map((mutation) => mutation.revision),
    [1, 2, 3],
    'no journal record is overwritten by a concurrent writer'
  )
  t.alike(
    mutations
      .flatMap((mutation) => mutation.documentIds)
      .slice()
      .sort(),
    ['plain-doc', 'seed', 'turbovec-doc'],
    'each journal record keeps its own document ids'
  )

  const results = await turbovec.search('saved', vector(8, 2), { topK: 3 })
  t.ok(
    results.some((result) => result.id === 'plain-doc'),
    'the concurrent external save is visible to turbovec search'
  )

  await turbovec.close()
  await hyperdb.close()
  await store.close()
})

test('TurboVecAdapter replays an external revision before its local commit', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const dbName = 'turbovec-local-after-external'
  const turbovec = new TurboVecAdapter({
    store,
    dbName,
    indexProvider,
    checkpointDir: path.join(tmpDir, 'index')
  })
  await turbovec.ready()
  await turbovec.saveEmbeddings([
    {
      id: 'revision-one',
      content: 'initial turbovec document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const hyperdb = new HyperDBAdapter({ store, dbName })
  await hyperdb.ready()
  await hyperdb.saveEmbeddings([
    {
      id: 'external-revision-two',
      content: 'external document before local commit',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  t.is(turbovec.revision, 1, 'the live native index has not refreshed revision two')

  const localSave = await turbovec.saveEmbeddings([
    {
      id: 'local-revision-three',
      content: 'local document after external commit',
      embeddingModelId: 'test-model',
      embedding: vector(8, 2)
    }
  ])
  t.is(localSave[0]?.status, 'fulfilled')
  t.is(turbovec.revision, 3, 'the local callback replays through its committed revision')

  const results = await turbovec.search('external', vector(8, 1), { topK: 3 })
  t.ok(
    results.some((result) => result.id === 'external-revision-two'),
    'the first search includes the previously skipped external mutation'
  )
  t.ok(
    results.some((result) => result.id === 'local-revision-three'),
    'the first search also includes the local mutation'
  )

  await turbovec.close()
  await hyperdb.close()
  await store.close()
})

test('TurboVecAdapter evicts caches for external updates and deletes', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const dbName = 'turbovec-external-cache-invalidation'
  const hyperdb = new HyperDBAdapter({ store, dbName })
  await hyperdb.ready()
  await hyperdb.saveEmbeddings([
    {
      id: 'externally-updated',
      content: 'old cached content',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    },
    {
      id: 'vector-competitor',
      content: 'unchanged competitor',
      embeddingModelId: 'test-model',
      embedding: vector(8, 2)
    }
  ])

  const turbovec = new TurboVecAdapter({
    store,
    dbName,
    indexProvider,
    checkpointDir: path.join(tmpDir, 'index')
  })
  await turbovec.ready()
  const cached = await turbovec.search('old', vector(8, 0), { topK: 2 })
  t.is(cached[0]?.id, 'externally-updated', 'the old document is cached before replacement')

  await hyperdb.saveEmbeddings([
    {
      id: 'externally-updated',
      content: 'updated external content',
      embeddingModelId: 'test-model',
      embedding: vector(8, 2)
    }
  ])
  const updated = await turbovec.search('updated', vector(8, 2), { topK: 1 })
  t.is(updated[0]?.id, 'externally-updated', 'the new vector changes first-search ranking')
  t.is(updated[0]?.content, 'updated external content', 'the first search returns new content')

  await hyperdb.deleteEmbeddings(['externally-updated'])
  const afterDelete = await turbovec.search('updated', vector(8, 2), { topK: 2 })
  t.is(
    afterDelete.find((result) => result.id === 'externally-updated'),
    undefined,
    'the first search removes the externally deleted document'
  )
  const storage = (
    turbovec as unknown as {
      storage: {
        documentCache: { get(key: string): string | undefined }
        vectorCache: { get(key: string): number[] | undefined }
      }
    }
  ).storage
  t.is(storage.documentCache.get('externally-updated'), undefined)
  t.is(storage.vectorCache.get('externally-updated'), undefined)

  await turbovec.close()
  await hyperdb.close()
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
  const workspaceDir = checkpointWorkspaceDir(first)
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

  fs.writeFileSync(path.join(workspaceDir, 'manifest.json'), 'not a manifest\n')

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

test('TurboVecAdapter isolates checkpoints for databases sharing one root', async (t) => {
  const tmpDir = await tmp()
  const firstStore = new Corestore(path.join(tmpDir, 'first-store'))
  const secondStore = new Corestore(path.join(tmpDir, 'second-store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const dbName = 'checkpoint-shared-name'
  const first = new TurboVecAdapter({
    store: firstStore,
    dbName,
    indexProvider,
    checkpointDir
  })
  const second = new TurboVecAdapter({
    store: secondStore,
    dbName,
    indexProvider,
    checkpointDir
  })
  await first.ready()
  await second.ready()
  const firstWorkspace = checkpointWorkspaceDir(first)
  const secondWorkspace = checkpointWorkspaceDir(second)
  t.not(firstWorkspace, secondWorkspace, 'database cores receive separate checkpoint namespaces')

  await first.saveEmbeddings([
    {
      id: 'first-document',
      content: 'first database document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])
  await second.saveEmbeddings([
    {
      id: 'second-document',
      content: 'second database document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  t.is(first.revision, 1)
  t.is(second.revision, 1, 'both databases have the same checkpoint revision')
  t.is(await first.checkpoint(), true)
  const firstManifest = JSON.parse(
    fs.readFileSync(path.join(firstWorkspace, 'manifest.json'), 'utf8')
  ) as { snapshot: string }
  const firstSnapshot = path.join(firstWorkspace, firstManifest.snapshot)

  t.is(await second.checkpoint(), true)
  const secondManifest = JSON.parse(
    fs.readFileSync(path.join(secondWorkspace, 'manifest.json'), 'utf8')
  ) as { snapshot: string }
  const secondSnapshot = path.join(secondWorkspace, secondManifest.snapshot)
  t.ok(fs.existsSync(firstSnapshot), 'the second database does not delete the first snapshot')

  await first.reindex()
  t.is(await first.checkpoint(), true)
  t.ok(fs.existsSync(secondSnapshot), 'the first database does not delete the second snapshot')

  await first.close()
  await second.close()

  const firstCounting = countingIndexProvider()
  const reopenedFirst = new TurboVecAdapter({
    store: firstStore,
    dbName,
    indexProvider: firstCounting.provider,
    checkpointDir
  })
  await reopenedFirst.ready()
  t.is(firstCounting.calls.load, 1, 'the first database loads one checkpoint')
  t.ok(
    firstCounting.calls.loadedPaths[0]?.startsWith(firstWorkspace),
    'the first database loads only from its namespace'
  )
  t.is((await reopenedFirst.search('first', vector(8, 0), { topK: 1 }))[0]?.id, 'first-document')
  await reopenedFirst.close()

  const secondCounting = countingIndexProvider()
  const reopenedSecond = new TurboVecAdapter({
    store: secondStore,
    dbName,
    indexProvider: secondCounting.provider,
    checkpointDir
  })
  await reopenedSecond.ready()
  t.is(secondCounting.calls.load, 1, 'the second database loads one checkpoint')
  t.ok(
    secondCounting.calls.loadedPaths[0]?.startsWith(secondWorkspace),
    'the second database loads only from its namespace'
  )
  t.is((await reopenedSecond.search('second', vector(8, 1), { topK: 1 }))[0]?.id, 'second-document')

  await reopenedSecond.close()
  await firstStore.close()
  await secondStore.close()
})

test('TurboVecAdapter rebuilds when checkpoint vector count mismatches', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const first = new TurboVecAdapter({
    store,
    dbName: 'checkpoint-count-mismatch',
    indexProvider,
    checkpointDir
  })
  await first.ready()
  const workspaceDir = checkpointWorkspaceDir(first)
  await first.saveEmbeddings([
    {
      id: 'counted-document',
      content: 'checkpoint count recovery document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])
  t.is(await first.checkpoint(), true)
  await first.close()

  const manifestPath = path.join(workspaceDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    vectorCount: number
  }
  manifest.vectorCount++
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)

  const counting = countingIndexProvider()
  const reopened = new TurboVecAdapter({
    store,
    dbName: 'checkpoint-count-mismatch',
    indexProvider: counting.provider,
    checkpointDir
  })
  await reopened.ready()
  t.is(counting.calls.load, 1, 'the snapshot is checked against the manifest count')
  t.ok(counting.calls.create >= 1, 'a count mismatch triggers a HyperDB rebuild')
  t.is(
    (await reopened.search('counted', vector(8, 0), { topK: 1 }))[0]?.id,
    'counted-document',
    'the rebuilt index returns the database document'
  )

  await reopened.close()
  await store.close()
})

test('TurboVecAdapter rejects checkpoints without database identity', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const first = new TurboVecAdapter({
    store,
    dbName: 'missing-checkpoint-identity',
    indexProvider,
    checkpointDir
  })
  await first.ready()
  const workspaceDir = checkpointWorkspaceDir(first)
  await first.saveEmbeddings([
    {
      id: 'legacy-document',
      content: 'legacy checkpoint recovery document',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])
  t.is(await first.checkpoint(), true)
  await first.close()

  const manifestPath = path.join(workspaceDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  delete manifest.databaseIdentity
  delete manifest.vectorCount
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)

  const counting = countingIndexProvider()
  const reopened = new TurboVecAdapter({
    store,
    dbName: 'missing-checkpoint-identity',
    indexProvider: counting.provider,
    checkpointDir
  })
  await reopened.ready()
  t.is(counting.calls.load, 0, 'the unbound snapshot is not loaded')
  t.ok(counting.calls.create >= 1, 'the incomplete checkpoint is replaced by a database rebuild')
  t.is((await reopened.search('legacy', vector(8, 0), { topK: 1 }))[0]?.id, 'legacy-document')

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

test('TurboVecAdapter uses native candidates when queued refresh advances farther', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const first = new TurboVecAdapter({
    store,
    dbName: 'turbovec-search-refresh-advance',
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

  const counting = searchCountingIndexProvider()
  const lagging = new TurboVecAdapter({
    store,
    dbName: 'turbovec-search-refresh-advance',
    indexProvider: counting.provider,
    checkpointDir: path.join(tmpDir, 'lagging-index')
  })
  await lagging.ready()
  await first.saveEmbeddings([
    {
      id: 'visible-match',
      content: 'visible before search starts',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  t.is(lagging.revision, 1)
  t.is(first.revision, 2)

  const internals = lagging as unknown as {
    _enqueue: <T>(operation: () => Promise<T>) => Promise<T>
    _scheduleRefresh: () => Promise<void>
    _searchAllDocuments: () => Promise<never>
  }
  let releaseQueuedOperation!: () => void
  const queuedOperationRelease = new Promise<void>((resolve) => {
    releaseQueuedOperation = resolve
  })
  let markQueuedOperationStarted!: () => void
  const queuedOperationStarted = new Promise<void>((resolve) => {
    markQueuedOperationStarted = resolve
  })
  const queuedOperation = internals._enqueue(async () => {
    markQueuedOperationStarted()
    await queuedOperationRelease
    await first.saveEmbeddings([
      {
        id: 'advanced-match',
        content: 'committed while refresh is queued',
        embeddingModelId: 'test-model',
        embedding: vector(8, 2)
      }
    ])
  })
  await queuedOperationStarted

  let markRefreshScheduled!: () => void
  const refreshScheduled = new Promise<void>((resolve) => {
    markRefreshScheduled = resolve
  })
  const scheduleRefresh = internals._scheduleRefresh.bind(lagging)
  internals._scheduleRefresh = () => {
    markRefreshScheduled()
    return scheduleRefresh()
  }
  let fullScanCalls = 0
  internals._searchAllDocuments = () => {
    fullScanCalls++
    return Promise.reject(new Error('unexpected full-corpus fallback'))
  }

  const search = lagging.search('advanced', vector(8, 2), { topK: 1 })
  await refreshScheduled
  releaseQueuedOperation()
  await queuedOperation
  const results = await search

  t.is(lagging.revision, 3, 'the queued refresh advances beyond the initially visible revision')
  t.is(results[0]?.id, 'advanced-match')
  t.is(counting.calls.search, 1, 'the advanced native index supplies candidates')
  t.is(fullScanCalls, 0, 'search does not fall back to a full HyperDB scan')

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

  const lockDir = path.join(checkpointWorkspaceDir(adapter), 'writer.lock')
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

test('TurboVecAdapter rejects a save when lock ownership changes before flush', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-pre-flush-lock-loss',
    indexProvider,
    checkpointDir
  })
  await adapter.ready()
  await adapter.saveEmbeddings([
    {
      id: 'baseline',
      content: 'baseline before pre-flush lock loss',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const workspaceDir = checkpointWorkspaceDir(adapter)
  const lockDir = path.join(workspaceDir, 'writer.lock')
  const displacedLockDir = path.join(workspaceDir, 'writer.lock.pre-flush')
  const database = (
    adapter as unknown as {
      storage: { db: HyperDBInstance }
    }
  ).storage.db
  const exclusiveTransaction = database.exclusiveTransaction.bind(database)
  database.exclusiveTransaction = async function () {
    const tx = await exclusiveTransaction()
    const insert = tx.insert.bind(tx)
    tx.insert = async function (collection: string, record: object) {
      await insert(collection, record)
      if (collection === '@rag/workspaceState' && !fs.existsSync(displacedLockDir)) {
        installForeignWriter(lockDir, displacedLockDir)
      }
    }
    return tx as HyperDBTransaction
  }

  const result = await adapter.saveEmbeddings([
    {
      id: 'must-not-commit',
      content: 'lock lost before transaction flush',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  database.exclusiveTransaction = exclusiveTransaction
  t.is(result[0]?.status, 'rejected', 'the admitted save does not report fulfilled')
  t.ok(result[0]?.error?.includes('lock ownership was lost'))

  const snapshot = database.snapshot()
  const document = await snapshot.get('@rag/documents', { id: 'must-not-commit' })
  const state = await snapshot.get<{ revision: number }>('@rag/workspaceState', {
    key: 'workspace'
  })
  await snapshot.close()
  t.is(document, null, 'the pre-flush ownership check prevents the document commit')
  t.is(state?.revision, 1, 'the pre-flush ownership check prevents revision advancement')
  try {
    await adapter.saveEmbeddings([
      {
        id: 'fenced-after-pre-flush',
        content: 'a foreign owner permanently fences this adapter',
        embeddingModelId: 'test-model',
        embedding: vector(8, 2)
      }
    ])
    t.fail('the fenced adapter must reject later writes')
  } catch (error) {
    t.ok(String(error).includes('lock ownership was lost'))
  }

  await adapter.close()
  t.is(
    JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).owner,
    'competitor',
    'close preserves the valid foreign owner'
  )
  removeTestWriterLocks(lockDir, displacedLockDir)
  await store.close()
})

test('TurboVecAdapter reports an uncertain save after post-commit lock loss', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-post-commit-lock-loss',
    indexProvider,
    checkpointDir
  })
  await adapter.ready()
  await adapter.saveEmbeddings([
    {
      id: 'baseline',
      content: 'baseline before post-commit lock loss',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const workspaceDir = checkpointWorkspaceDir(adapter)
  const lockDir = path.join(workspaceDir, 'writer.lock')
  const displacedLockDir = path.join(workspaceDir, 'writer.lock.post-commit')
  const database = (
    adapter as unknown as {
      storage: { db: HyperDBInstance }
    }
  ).storage.db
  const exclusiveTransaction = database.exclusiveTransaction.bind(database)
  database.exclusiveTransaction = async function () {
    const tx = await exclusiveTransaction()
    const flush = tx.flush.bind(tx)
    tx.flush = async function () {
      await flush()
      installForeignWriter(lockDir, displacedLockDir)
    }
    return tx as HyperDBTransaction
  }

  const result = await adapter.saveEmbeddings([
    {
      id: 'committed-before-lock-loss',
      content: 'database commit completed before ownership was lost',
      embeddingModelId: 'test-model',
      embedding: vector(8, 1)
    }
  ])
  database.exclusiveTransaction = exclusiveTransaction
  t.is(result[0]?.status, 'rejected', 'post-commit ownership loss is not reported fulfilled')
  t.ok(result[0]?.error?.includes('commit succeeded but post-commit processing failed'))
  t.ok(result[0]?.error?.includes('lock ownership was lost'))

  const snapshot = database.snapshot()
  const document = await snapshot.get('@rag/documents', { id: 'committed-before-lock-loss' })
  const state = await snapshot.get<{ revision: number }>('@rag/workspaceState', {
    key: 'workspace'
  })
  await snapshot.close()
  t.ok(document, 'the rejected result communicates uncertainty because the DB commit exists')
  t.is(state?.revision, 2, 'the committed revision remains durable')
  const internals = adapter as unknown as {
    needsRecovery: boolean
    writerFenced: boolean
  }
  t.is(internals.needsRecovery, true, 'post-commit ownership loss forces index recovery')
  t.is(internals.writerFenced, true, 'the valid foreign owner fences the adapter')

  await adapter.close()
  t.is(
    JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).owner,
    'competitor',
    'close preserves the valid foreign owner'
  )
  removeTestWriterLocks(lockDir, displacedLockDir)
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

  const workspaceDir = checkpointWorkspaceDir(adapter)
  const lockDir = path.join(workspaceDir, 'writer.lock')
  const stolenLockDir = path.join(workspaceDir, 'writer.lock.stolen')
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
  t.is(fs.existsSync(path.join(workspaceDir, 'manifest.json')), false)
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

test('TurboVecAdapter recovers after the competing writer releases the lock', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-fence-recovery',
    indexProvider,
    checkpointDir
  })
  await adapter.ready()
  await adapter.saveEmbeddings([
    {
      id: 'before-fence',
      content: 'saved before the fence',
      embeddingModelId: 'test-model',
      embedding: vector(8, 0)
    }
  ])

  const workspaceDir = checkpointWorkspaceDir(adapter)
  const lockDir = path.join(workspaceDir, 'writer.lock')
  const displacedLockDir = path.join(workspaceDir, 'writer.lock.displaced')
  installForeignWriter(lockDir, displacedLockDir)

  try {
    await adapter.saveEmbeddings([
      {
        id: 'while-fenced',
        content: 'rejected while a competitor owns the lock',
        embeddingModelId: 'test-model',
        embedding: vector(8, 1)
      }
    ])
    t.fail('a save must reject while a live competitor owns the lock')
  } catch (error) {
    t.ok(String(error).includes('lock ownership was lost'))
  }
  const internals = adapter as unknown as { writerFenced: boolean }
  t.is(internals.writerFenced, true, 'the live foreign owner fences the adapter')

  const fencedSearch = await adapter.search('before', vector(8, 0), { topK: 1 })
  t.is(fencedSearch[0]?.id, 'before-fence', 'a fenced adapter still serves searches')
  t.is(internals.writerFenced, true, 'a search cannot displace a live foreign owner')

  removeTestWriterLocks(lockDir, displacedLockDir)

  const recovered = await adapter.saveEmbeddings([
    {
      id: 'after-recovery',
      content: 'saved after the writer lock came back',
      embeddingModelId: 'test-model',
      embedding: vector(8, 2)
    }
  ])
  t.is(recovered[0]?.status, 'fulfilled', 'the adapter writes again after re-acquiring the lock')
  t.is(internals.writerFenced, false, 'recovery clears the fence')

  const results = await adapter.search('after', vector(8, 2), { topK: 3 })
  t.ok(
    results.some((result) => result.id === 'after-recovery'),
    'writes after recovery are searchable'
  )
  t.ok(
    results.every((result) => result.id !== 'while-fenced'),
    'the fenced save never committed'
  )

  await adapter.close()
  await store.close()
})

// Windows refuses a file path longer than 259 characters, so the part the
// adapter builds under its checkpoint directory has to stay well inside that.
// The rest is whatever directory the application keeps its data in. The
// longest name today is the temporary manifest, at 118 characters.
const MAX_WORKSPACE_PATH_LENGTH = 128

interface PatchableFs {
  mkdirSync: (...args: unknown[]) => unknown
  writeFileSync: (...args: unknown[]) => unknown
  openSync: (...args: unknown[]) => number
  renameSync: (...args: unknown[]) => unknown
  unlinkSync: (...args: unknown[]) => unknown
}

interface FileSystemCall {
  operation: string
  target: string
  flags: string | null
}

// Records every path the adapter hands to the file system during `run`, so a
// test can measure the names it builds without reaching into private state.
// Both this file and the adapter resolve `bare-fs` to the same module, so
// replacing a function here is visible to the adapter.
async function recordFileSystemCalls(run: () => Promise<void>): Promise<FileSystemCall[]> {
  const calls: FileSystemCall[] = []
  const patchable = fs as unknown as PatchableFs
  const original = {
    mkdirSync: patchable.mkdirSync,
    writeFileSync: patchable.writeFileSync,
    openSync: patchable.openSync,
    renameSync: patchable.renameSync,
    unlinkSync: patchable.unlinkSync
  }

  function note(operation: string, target: unknown, flags?: unknown) {
    calls.push({
      operation,
      target: String(target),
      flags: typeof flags === 'string' ? flags : null
    })
  }

  patchable.mkdirSync = (...args) => {
    note('mkdir', args[0])
    return original.mkdirSync(...args)
  }
  patchable.writeFileSync = (...args) => {
    note('writeFile', args[0])
    return original.writeFileSync(...args)
  }
  patchable.openSync = (...args) => {
    note('open', args[0], args[1])
    return original.openSync(...args)
  }
  patchable.renameSync = (...args) => {
    note('rename', args[0])
    note('rename', args[1])
    return original.renameSync(...args)
  }
  patchable.unlinkSync = (...args) => {
    note('unlink', args[0])
    return original.unlinkSync(...args)
  }

  try {
    await run()
  } finally {
    patchable.mkdirSync = original.mkdirSync
    patchable.writeFileSync = original.writeFileSync
    patchable.openSync = original.openSync
    patchable.renameSync = original.renameSync
    patchable.unlinkSync = original.unlinkSync
  }

  return calls
}

function runDurabilityCycle(
  checkpointDir: string,
  store: InstanceType<typeof Corestore>
): Promise<FileSystemCall[]> {
  const adapter = new TurboVecAdapter({
    store,
    dbName: 'turbovec-path-budget',
    indexProvider,
    checkpointDir
  })

  return recordFileSystemCalls(async () => {
    await adapter.ready()
    await adapter.saveEmbeddings([
      {
        id: 'alpha',
        content: 'alpha document',
        embeddingModelId: 'test-model',
        embedding: vector(8, 0)
      }
    ])
    await adapter.checkpoint()
    await adapter.close()
  })
}

test('TurboVecAdapter keeps every path it builds within the workspace budget', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')

  const calls = await runDurabilityCycle(checkpointDir, store)
  await store.close()

  const inside = calls.filter((call) => call.target.startsWith(`${checkpointDir}${path.sep}`))
  t.ok(inside.length > 0, 'the cycle touched paths inside the checkpoint directory')

  let longest = { target: '', length: 0 }
  for (const call of inside) {
    const length = call.target.length - checkpointDir.length - 1
    if (length > longest.length) longest = { target: call.target, length }
  }

  t.ok(
    longest.length <= MAX_WORKSPACE_PATH_LENGTH,
    `longest workspace path is ${longest.length} characters (${path.basename(longest.target)})`
  )
})

test('TurboVecAdapter opens durability files for writing before flushing', async (t) => {
  const tmpDir = await tmp()
  const store = new Corestore(path.join(tmpDir, 'store'))
  const checkpointDir = path.join(tmpDir, 'index')

  const calls = await runDurabilityCycle(checkpointDir, store)
  await store.close()

  const flushed = calls.filter((call) => {
    if (call.operation !== 'open') return false
    const name = path.basename(call.target)
    return name.startsWith('owner.json.tmp-') || name.startsWith('manifest.json.tmp-')
  })

  t.ok(
    flushed.some((call) => path.basename(call.target).startsWith('owner.json.tmp-')),
    'the lock record was reopened'
  )
  t.ok(
    flushed.some((call) => path.basename(call.target).startsWith('manifest.json.tmp-')),
    'the manifest was reopened'
  )
  t.alike(
    [...new Set(flushed.map((call) => call.flags))],
    ['r+'],
    'files that are flushed carry write access, which Windows requires'
  )
})
