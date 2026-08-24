import test from 'brittle'
import Corestore from 'corestore'
import path from 'bare-path'
import tmp from 'test-tmp'
import IdMapIndex from '@qvac/embed-llamacpp/idMapIndex'

import {
  TurboVecAdapter,
  type TurboVecAdapterInput,
  type TurboVecIndexProvider
} from '../../src/adapters/database/TurboVecAdapter.js'
import { ERR_CODES, QvacErrorRAG } from '../../src/errors.js'

const indexProvider: TurboVecIndexProvider = {
  create(options) {
    return new IdMapIndex(options)
  },
  load(snapshotPath) {
    return IdMapIndex.load(snapshotPath)
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
