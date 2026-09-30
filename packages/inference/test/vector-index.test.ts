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
} from '@/runtime/vector-index-registry'
import { getConfiguredCacheDir } from '@/runtime/state'
import { storageFromBitWidth } from '@/plugins/turbovec-backend'
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

type Provider = ReturnType<typeof observableIndexProvider>
type ProviderCalls = Provider['calls']
type ProviderFailures = Provider['failures']
type ProviderFailRemoveId = Provider['failRemoveId']

function tempSnapshotPath(suffix: string) {
  return path.join(os.tmpdir(), `qvac-vector-index-${os.pid()}-${suffix}.qvi`)
}

async function withProvider(
  run: (
    calls: ProviderCalls,
    failures: ProviderFailures,
    failRemoveId: ProviderFailRemoveId
  ) => Promise<void>
) {
  clearPlugins()
  const { provider, calls, failures, failRemoveId } = observableIndexProvider()
  registerProviderPlugin('test-vector-index-provider', provider)
  try {
    await run(calls, failures, failRemoveId)
  } finally {
    failures.dispose = false
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

test('storageFromBitWidth: maps unambiguous widths and leaves 4 bits undefined', (t) => {
  t.is(storageFromBitWidth(32), 'f32')
  t.is(storageFromBitWidth(8), 'q8')
  t.is(storageFromBitWidth(2), 'turbovec-q2')
  t.is(storageFromBitWidth(4), undefined, 'q4 and turbovec-q4 share a bit width')
  t.is(storageFromBitWidth(undefined), undefined)
})

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

    const padded = await index.search({ query: [1, 0, 0, 0], k: 5 })
    t.is(padded.length, 3, 'padding slots beyond the live entries are stripped')

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
      t.is(loaded.storage, 'q8', 'storage is derived from the loaded index bit width')
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

test('vector index: a failed dispose leaves the index registered and retryable', async (t) => {
  await withProvider(async (calls, failures) => {
    const index = await createVectorIndex({ dim: 2 })
    t.is(getOpenVectorIndexCount(), 1)

    failures.dispose = true
    await expectRejects(
      t,
      () => index.dispose(),
      VectorIndexFailedError,
      'a failing native dispose surfaces as a coded error'
    )
    t.is(calls.dispose, 1, 'the backend was asked to dispose')
    t.is(
      getOpenVectorIndexCount(),
      1,
      'the index stays registered, so it is not leaked for the worker lifetime'
    )

    failures.dispose = false
    await index.dispose()
    t.is(calls.dispose, 2, 'the retry reaches the backend again')
    t.is(getOpenVectorIndexCount(), 0)
  })
})

test('vector index: an index whose dispose failed is still released at shutdown', async (t) => {
  await withProvider(async (calls, failures) => {
    const index = await createVectorIndex({ dim: 2 })
    failures.dispose = true
    await expectRejects(
      t,
      () => index.dispose(),
      VectorIndexFailedError,
      'the native dispose fails'
    )

    failures.dispose = false
    disposeAllVectorIndexes()
    t.is(calls.dispose, 2, 'shutdown disposes the index the failed call left behind')
    t.is(getOpenVectorIndexCount(), 0)
  })
})

test('vector index: a failed create or load registers nothing', async (t) => {
  await withProvider(async (calls, failures) => {
    failures.create = true
    await expectRejects(
      t,
      () => createVectorIndex({ dim: 2 }),
      VectorIndexFailedError,
      'a failing create surfaces as a coded error'
    )
    t.is(calls.create, 1, 'the backend was asked to create')
    t.is(getOpenVectorIndexCount(), 0, 'a failed create leaves nothing registered')

    failures.load = true
    await expectRejects(
      t,
      () => loadVectorIndex({ path: 'never-written.qvi' }),
      VectorIndexFailedError,
      'a failing load surfaces as a coded error'
    )
    t.is(getOpenVectorIndexCount(), 0, 'a failed load leaves nothing registered')
  })
})

test('vector index: a failed add, query or write leaves the index open', async (t) => {
  await withProvider(async (calls, failures) => {
    const index = await createVectorIndex({ dim: 2 })
    await index.add({ ids: ['1'], vectors: [[1, 0]] })

    for (const call of ['addWithIds', 'search', 'contains', 'write'] as const) {
      failures[call] = true
      const action = {
        addWithIds: () => index.add({ ids: ['2'], vectors: [[0, 1]] }),
        search: () => index.search({ query: [1, 0], k: 1 }),
        contains: () => index.contains({ ids: ['1'] }),
        write: () => index.write({ path: `vector-index-fail-${os.pid()}.qvi` })
      }[call]
      await expectRejects(t, action, VectorIndexFailedError, `a failing ${call} is reported`)
      t.is(getOpenVectorIndexCount(), 1, `the index survives a failing ${call}`)
      failures[call] = false
    }

    // The failed add must not have counted, so the index still holds one id.
    t.alike(await index.contains({ ids: ['1', '2'] }), [true, false])
  })
})

test('vector index: a failed prepare is retried on the next search', async (t) => {
  await withProvider(async (calls, failures) => {
    const index = await createVectorIndex({ dim: 2 })
    await index.add({ ids: ['1'], vectors: [[1, 0]] })

    failures.prepare = true
    await expectRejects(
      t,
      () => index.search({ query: [1, 0], k: 1 }),
      VectorIndexFailedError,
      'a failing prepare is reported'
    )
    t.is(calls.prepare, 1)
    t.is(calls.search, 0, 'the search never ran')

    failures.prepare = false
    await index.search({ query: [1, 0], k: 1 })
    t.is(calls.prepare, 2, 'the warm-up is retried because it never succeeded')
    t.is(calls.search, 1)

    await index.search({ query: [1, 0], k: 1 })
    t.is(calls.prepare, 2, 'a successful warm-up is not repeated')
  })
})

test('vector index: a failed remove reports how many ids it applied', async (t) => {
  await withProvider(async (calls, failures, failRemoveId) => {
    const index = await createVectorIndex({ dim: 2 })
    await index.add({
      ids: ['1', '2', '3'],
      vectors: [
        [1, 0],
        [0, 1],
        [1, 1]
      ]
    })

    failRemoveId.id = 2n
    try {
      await index.remove({ ids: ['1', '2', '3'] })
      t.fail('the batch should fail on the second id')
    } catch (error) {
      t.ok(error instanceof VectorIndexFailedError)
      t.ok(
        String((error as Error).message).includes('applied 1 of 3 ids'),
        'the error names the ids already removed'
      )
    }

    failRemoveId.id = null
    t.alike(
      await index.contains({ ids: ['1', '2', '3'] }),
      [false, true, true],
      'the id before the failure is gone and the rest are untouched'
    )
    t.is(getOpenVectorIndexCount(), 1, 'the index survives a partial remove')
  })
})

test('vector index: shutdown clears the registry even when dispose throws', async (t) => {
  await withProvider(async (calls, failures) => {
    await createVectorIndex({ dim: 2 })
    await createVectorIndex({ dim: 2 })
    failures.dispose = true

    disposeAllVectorIndexes()
    t.is(calls.dispose, 2, 'every index is attempted')
    t.is(getOpenVectorIndexCount(), 0, 'shutdown clears the registry regardless')
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
