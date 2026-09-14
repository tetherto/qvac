import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { clearPlugins, registerPlugin } from '@/plugins'
import { send, close } from '@/dispatch'
import { createVectorIndex, loadVectorIndex } from '@/api/vector-index'
import {
  disposeAllVectorIndexes,
  getOpenVectorIndexCount,
  resolveVectorIndexPath
} from '@/vector-index/index'
import { getConfiguredCacheDir } from '@/runtime/state'
import {
  RequestValidationFailedError,
  VectorIndexFailedError,
  VectorIndexInvalidVectorsError,
  VectorIndexNotFoundError,
  VectorIndexProviderUnavailableError
} from '@/errors/index'
import type { Response } from '@/schemas/index'
import { makeFakePlugin } from './fixtures/fake-plugin'
import { observableIndexProvider, registerProviderPlugin } from './fixtures/turbovec-provider'

// Keep the storage-root lock out of the real home, as dispatch.test.ts does.
env['HOME'] = path.join(os.tmpdir(), `qvac-inference-test-${os.pid()}`)

type ProviderCalls = ReturnType<typeof observableIndexProvider>['calls']

function tempSnapshotPath(suffix: string) {
  return path.join(os.tmpdir(), `qvac-vector-index-${os.pid()}-${suffix}.qvi`)
}

async function withProvider(run: (calls: ProviderCalls) => Promise<void>) {
  clearPlugins()
  const { provider, calls } = observableIndexProvider()
  registerProviderPlugin('test-vector-index-provider', provider)
  try {
    await run(calls)
  } finally {
    disposeAllVectorIndexes()
    await close()
    clearPlugins()
  }
}

// brittle's typed `t.exception` only accepts zero-argument error constructors.
async function expectRejects(
  t: { ok: (value: unknown, message?: string) => void; fail: (message: string) => void },
  action: () => Promise<unknown>,
  errorClass: abstract new (...args: never[]) => Error,
  message: string
) {
  try {
    await action()
    t.fail(`${message}: expected a rejection`)
  } catch (error) {
    t.ok(error instanceof errorClass, message)
  }
}

test('createVectorIndex: rejects when no plugin provides a vector index', async (t) => {
  clearPlugins()
  // A plugin without the capability keeps dispatch ready but leaves no provider.
  registerPlugin(makeFakePlugin('test-vector-index-fake'))
  try {
    await expectRejects(
      t,
      () => createVectorIndex({ dim: 8 }),
      VectorIndexProviderUnavailableError,
      'no provider registered'
    )
  } finally {
    await close()
    clearPlugins()
  }
})

test('vector index: create, add, search, contains, remove, dispose round trip', async (t) => {
  await withProvider(async (calls) => {
    const index = await createVectorIndex({ dim: 4, storage: 'q8' })
    t.is(index.dim, 4)
    t.is(index.storage, 'q8')
    t.is(index.length, 0)
    t.is(calls.create, 1)
    t.is(getOpenVectorIndexCount(), 1)

    const added = await index.add({
      ids: [1n, '2', 3],
      vectors: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0]
      ]
    })
    t.is(added.length, 3)
    t.is(index.length, 3)
    t.is(calls.addWithIds, 1)

    const hits = await index.search({ query: [1, 0, 0, 0], k: 2 })
    t.alike(
      hits.map((hit) => hit.id),
      ['1', '2'],
      'single-query search returns one hit list with string ids'
    )
    t.is(calls.prepare, 1, 'the index is prepared before the first search after a mutation')

    await index.search({ query: [1, 0, 0, 0], k: 1 })
    t.is(calls.prepare, 1, 'repeated searches do not prepare again')

    const rows = await index.search({ queries: [[0, 1, 0, 0]], k: 1 })
    t.is(rows.length, 1, 'multi-query search returns one list per query')
    t.is(rows[0]?.length, 1)

    t.alike(await index.contains({ ids: ['1', 9] }), [true, false])

    t.alike(await index.remove({ ids: ['2', '2'] }), [true, false])
    t.is(index.length, 2)
    await index.search({ query: [1, 0, 0, 0], k: 1 })
    t.is(calls.prepare, 2, 'a removal makes the next search prepare again')

    await index.dispose()
    t.is(calls.dispose, 1)
    t.is(getOpenVectorIndexCount(), 0)
    await index.dispose()
    t.is(calls.dispose, 1, 'dispose is idempotent on the handle')

    await expectRejects(
      t,
      () => index.contains({ ids: ['1'] }),
      VectorIndexNotFoundError,
      'a disposed index is gone from the worker'
    )
  })
})

test('vector index: row length mismatches fail before any request is sent', async (t) => {
  await withProvider(async (calls) => {
    const index = await createVectorIndex({ dim: 2 })
    await expectRejects(
      t,
      () => index.add({ ids: ['1'], vectors: [[1, 2, 3]] }),
      RequestValidationFailedError,
      'add rejects a row of the wrong length'
    )
    await expectRejects(
      t,
      () => index.search({ query: [1], k: 1 }),
      RequestValidationFailedError,
      'search rejects a query of the wrong length'
    )
    t.is(calls.addWithIds, 0)
    t.is(calls.search, 0)
  })
})

test('vector index: the worker validates rows and ids independently of the client', async (t) => {
  await withProvider(async () => {
    const created = (await send({ type: 'vectorIndex', operation: 'create', dim: 2 })) as Extract<
      Response,
      { type: 'vectorIndex'; operation: 'create' }
    >
    const indexId = created.indexId

    await expectRejects(
      t,
      () =>
        send({
          type: 'vectorIndex',
          operation: 'add',
          indexId,
          ids: ['1', '2'],
          vectors: [[1, 2]]
        }),
      VectorIndexInvalidVectorsError,
      'ids and vectors must have the same count'
    )
    await expectRejects(
      t,
      () =>
        send({
          type: 'vectorIndex',
          operation: 'add',
          indexId,
          ids: ['1'],
          vectors: [[1, 2, 3]]
        }),
      VectorIndexInvalidVectorsError,
      'row length must match dim'
    )
    await expectRejects(
      t,
      () =>
        send({
          type: 'vectorIndex',
          operation: 'add',
          indexId,
          ids: ['18446744073709551615'],
          vectors: [[1, 2]]
        }),
      RequestValidationFailedError,
      'the reserved padding id is rejected by the schema'
    )
    await expectRejects(
      t,
      () =>
        send({
          type: 'vectorIndex',
          operation: 'search',
          indexId: 'missing',
          queries: [[1, 2]],
          k: 1
        }),
      VectorIndexNotFoundError,
      'an unknown index id is reported as not found'
    )
  })
})

test('vector index: native failures surface as VectorIndexFailedError with the cause kept', async (t) => {
  await withProvider(async () => {
    const index = await createVectorIndex({ dim: 1 })
    await index.add({ ids: ['7'], vectors: [[1]] })
    try {
      await index.add({ ids: ['7'], vectors: [[1]] })
      t.fail('duplicate ids should be rejected by the native index')
    } catch (error) {
      t.ok(error instanceof VectorIndexFailedError)
      t.ok(String((error as Error).message).includes('duplicate id 7'))
      t.ok((error as { cause?: unknown }).cause instanceof Error)
    }
  })
})

test('vector index: write resolves relative paths under the data dir and load restores', async (t) => {
  await withProvider(async (calls) => {
    const index = await createVectorIndex({ dim: 8 })
    await index.add({ ids: ['1', '2'], vectors: [new Array(8).fill(1), new Array(8).fill(2)] })

    const relative = `vector-index-test/${os.pid()}/snapshot.qvi`
    const expected = path.join(path.dirname(getConfiguredCacheDir()), relative)
    t.is(resolveVectorIndexPath(relative), expected)
    const absolute = tempSnapshotPath('absolute')
    t.is(resolveVectorIndexPath(absolute), absolute)

    try {
      const written = await index.write({ path: relative })
      t.is(written.path, expected)
      t.ok(fs.existsSync(expected), 'parent directories are created and the snapshot exists')
      t.is(calls.write, 1)

      const loaded = await loadVectorIndex({ path: relative })
      t.is(calls.load, 1)
      t.is(loaded.dim, 8)
      t.is(loaded.storage, undefined, 'the fixture index does not report storage')
      t.is(getOpenVectorIndexCount(), 2)
      await loaded.dispose()
    } finally {
      fs.rmSync(path.dirname(expected), { recursive: true, force: true })
    }
  })
})

test('vector index: worker cleanup disposes every open index', async (t) => {
  await withProvider(async (calls) => {
    await createVectorIndex({ dim: 2 })
    await createVectorIndex({ dim: 2 })
    t.is(getOpenVectorIndexCount(), 2)
    disposeAllVectorIndexes()
    t.is(getOpenVectorIndexCount(), 0)
    t.is(calls.dispose, 2)
    disposeAllVectorIndexes()
    t.is(calls.dispose, 2, 'a second cleanup is a no-op')
  })
})

test('vector index: dispose of an unknown id reports disposed=false instead of throwing', async (t) => {
  await withProvider(async () => {
    const response = (await send({
      type: 'vectorIndex',
      operation: 'dispose',
      indexId: 'never-existed'
    })) as Extract<Response, { type: 'vectorIndex'; operation: 'dispose' }>
    t.is(response.disposed, false)
  })
})

test('vector index: Symbol.asyncDispose releases the index', async (t) => {
  await withProvider(async (calls) => {
    {
      await using index = await createVectorIndex({ dim: 2 })
      t.is(index.length, 0)
    }
    t.is(calls.dispose, 1)
    t.is(getOpenVectorIndexCount(), 0)
  })
})
