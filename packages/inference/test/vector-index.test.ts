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
  disposeVectorIndex,
  getOpenVectorIndexCount,
  resolveVectorIndexPath
} from '@/runtime/vector-index-registry'
import { handleCloseSession, handleOpenSession } from '@/handlers/session'
import { getConfiguredCacheDir } from '@/runtime/state'
import { storageFromBitWidth } from '@/plugins/turbovec-backend'
import {
  InferenceCancelledError,
  RequestValidationFailedError,
  VectorIndexFailedError,
  VectorIndexInvalidVectorsError,
  VectorIndexNotFoundError,
  VectorIndexProviderUnavailableError
} from '@/errors/index'
import type { Response } from '@/schemas/index'
import { makeFakePlugin } from './fixtures/fake-plugin'
import { observableIndexProvider, registerProviderPlugin } from './fixtures/turbovec-provider'
import { handleVectorIndex } from '@/handlers/vector-index'
import { getRequestRegistry } from '@/runtime/index'

// Keep the storage-root lock out of the real home, as dispatch.test.ts does.
env['HOME'] = path.join(os.tmpdir(), `qvac-inference-test-${os.pid()}`)

type Provider = ReturnType<typeof observableIndexProvider>
type ProviderCalls = Provider['calls']
type ProviderFailures = Provider['failures']
type ProviderFailRemoveId = Provider['failRemoveId']
type ProviderLastIvfArgs = Provider['lastIvfArgs']
type ProviderGates = Provider['gates']

function tempSnapshotPath(suffix: string) {
  return path.join(os.tmpdir(), `qvac-vector-index-${os.pid()}-${suffix}.qvi`)
}

async function withProvider(
  run: (
    calls: ProviderCalls,
    failures: ProviderFailures,
    failRemoveId: ProviderFailRemoveId,
    lastIvfArgs: ProviderLastIvfArgs,
    gates: ProviderGates
  ) => Promise<void>,
  options: { ivf?: boolean } = {}
) {
  clearPlugins()
  const { provider, calls, failures, failRemoveId, lastIvfArgs, gates } =
    observableIndexProvider(options)
  registerProviderPlugin('test-vector-index-provider', provider)
  try {
    await run(calls, failures, failRemoveId, lastIvfArgs, gates)
  } finally {
    failures.dispose = false
    await disposeAllVectorIndexes()
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

// A cancel that lands while the native open is in flight: the call reports
// the cancel and the index it opened is released, since no caller holds its id.
for (const operation of ['create', 'load'] as const) {
  test(`vectorIndex: a ${operation} cancelled during the native open is released and reported cancelled`, async (t) => {
    await withProvider(async (calls, _failures, _failRemoveId, _lastIvfArgs, gates) => {
      let finishOpen = () => {}
      gates[operation] = new Promise<void>((resolve) => {
        finishOpen = resolve
      })
      const requestId = `vi-cancel-${operation}`
      const pending = handleVectorIndex(
        operation === 'create'
          ? { type: 'vectorIndex', operation, dim: 2, storage: 'f32', requestId }
          : { type: 'vectorIndex', operation, path: tempSnapshotPath('cancelled-load'), requestId }
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      t.is(getRequestRegistry().cancel({ requestId }), 1, 'the open is in flight and cancellable')
      finishOpen()
      await expectRejects(t, () => pending, InferenceCancelledError, 'the open reports the cancel')
      t.is(calls[operation], 1)
      t.is(calls.dispose, 1, 'the index the cancelled caller opened is released')
      t.is(getOpenVectorIndexCount(), 0)
    })
  })
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
    await disposeAllVectorIndexes()
    t.is(getOpenVectorIndexCount(), 0)
    t.is(calls.dispose, 2)
    await disposeAllVectorIndexes()
    t.is(calls.dispose, 2, 'a second cleanup is a no-op')
  })
})

test('vector index: closing a session disposes the indexes it opened and no others', async (t) => {
  await withProvider(async (calls) => {
    const sessionId = 'vi-session-close'
    handleOpenSession({ type: 'openSession', sessionId })
    const created = await handleVectorIndex({
      type: 'vectorIndex',
      operation: 'create',
      dim: 2,
      storage: 'f32',
      sessionId
    })
    if (created.operation !== 'create') return t.fail(`create replied ${created.operation}`)
    const owned = await createVectorIndex({ dim: 2 })
    t.is(getOpenVectorIndexCount(), 2)

    await handleCloseSession({ type: 'closeSession', sessionId })
    t.is(calls.dispose, 1, 'the session index is released')
    t.is(getOpenVectorIndexCount(), 1)
    t.is(
      disposeVectorIndex({ indexId: created.indexId }).disposed,
      false,
      'the session index is gone'
    )
    t.alike(await owned.contains({ ids: ['1'] }), [false], "the owner's index stays usable")
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
    await disposeAllVectorIndexes()
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

    await disposeAllVectorIndexes()
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

for (const operation of ['create', 'load'] as const) {
  test(`vector index: awaits an async ${operation} provider`, async (t) => {
    const { provider, calls } = observableIndexProvider()
    clearPlugins()
    registerProviderPlugin('test-async-provider', {
      async create(options) {
        return provider.create(options)
      },
      async load(snapshotPath) {
        return provider.load(snapshotPath)
      }
    })
    try {
      const index =
        operation === 'create'
          ? await createVectorIndex({ dim: 8 })
          : await loadVectorIndex({ path: 'async.qvi' })
      t.is(index.dim, 8)
      await index.add({ ids: ['1'], vectors: [[1, 0, 0, 0, 0, 0, 0, 0]] })
      t.is(calls.addWithIds, 1)
      await index.dispose()
      t.is(calls.dispose, 1)
    } finally {
      await close()
      clearPlugins()
    }
  })
}

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const operation of ['create', 'load'] as const) {
  for (const fails of [false, true]) {
    test(`vector index: shutdown waits for pending ${operation}, failure=${fails}`, async (t) => {
      const { provider, calls } = observableIndexProvider()
      const started = deferred()
      const gate = deferred()
      const cause = new Error('async dependency failed')
      const dependencyError = new Error('optional dependency unavailable', { cause })
      const wait = async () => {
        started.resolve()
        await gate.promise
        if (fails) throw dependencyError
      }
      clearPlugins()
      registerProviderPlugin('test-pending-provider', {
        async create(options) {
          await wait()
          return provider.create(options)
        },
        async load(snapshotPath) {
          await wait()
          return provider.load(snapshotPath)
        }
      })
      const opening =
        operation === 'create'
          ? createVectorIndex({ dim: 8 })
          : loadVectorIndex({ path: 'pending.qvi' })
      const outcome = opening.then(
        () => undefined,
        (error: unknown) => error
      )
      let shutdown: Promise<void> | undefined
      try {
        await started.promise
        t.is(getOpenVectorIndexCount(), 0, 'an unresolved provider is not registered')
        let closed = false
        shutdown = close().then(() => {
          closed = true
        })
        await Promise.resolve()
        t.absent(closed, 'shutdown waits for the provider')
        gate.resolve()
        const error = await outcome
        await shutdown
        if (fails) {
          t.ok(error instanceof VectorIndexFailedError)
          t.is((error as Error).cause, dependencyError, 'the provider rejection is preserved')
          t.is(((error as Error).cause as Error).cause, cause, 'the dependency cause is preserved')
        } else {
          t.absent(error)
        }
        t.is(calls.dispose, fails ? 0 : 1, 'every completed index is disposed once')
        t.is(getOpenVectorIndexCount(), 0, 'no index survives shutdown')
      } finally {
        gate.resolve()
        await outcome
        if (shutdown) await shutdown
        await close()
        clearPlugins()
      }
    })
  }
}

test('vector index: providers without controls remain usable and reject staged search', async (t) => {
  await withProvider(async () => {
    const index = await createVectorIndex({ dim: 8 })
    t.is(index.calibrated, undefined)
    t.is(index.stagedSearch, undefined)
    await expectRejects(
      t,
      () => index.setStagedSearch({ enabled: true }),
      VectorIndexFailedError,
      'unsupported provider reports a coded error'
    )
    t.is(index.stagedSearch, undefined)
    await index.dispose()
    await expectRejects(
      t,
      () => index.setStagedSearch({ enabled: true }),
      VectorIndexNotFoundError,
      'a disposed index rejects controls'
    )
  })
})

test('vector index: the worker rejects a non-boolean staged search setting', async (t) => {
  await withProvider(async () => {
    const index = await createVectorIndex({ dim: 8 })
    await expectRejects(
      t,
      () =>
        send({
          type: 'vectorIndex',
          operation: 'setStagedSearch',
          indexId: index.indexId,
          enabled: 'true'
        } as never),
      RequestValidationFailedError,
      'validation runs before the provider is reached'
    )
  })
})

test('vector index: setIvf builds lists that search then probes', async (t) => {
  await withProvider(
    async (calls, _failures, _failRemoveId, lastIvfArgs) => {
      const index = await createVectorIndex({ dim: 2 })
      t.is(index.ivf, null, 'IVF starts off on a provider that supports it')
      const loaded = await loadVectorIndex({ path: 'ivf.qvi' })
      t.is(loaded.ivf, null, 'a loaded index starts with IVF off')
      await loaded.dispose()
      await index.add({
        ids: ['1', '2', '3'],
        vectors: [
          [1, 0],
          [0, 1],
          [1, 1]
        ]
      })

      const result = await index.setIvf({ nLists: 2, nProbe: 1 })
      const built = { nLists: 2, nProbe: 1, built: true }
      t.alike(result, { ivf: built })
      t.alike(index.ivf, built, 'the handle reports the new state')
      t.is(calls.buildIvf, 1, 'setIvf builds right away')
      t.is(lastIvfArgs.nLists, 2)
      t.is(lastIvfArgs.nIter, 0, 'an omitted nIter builds with the initial centroids only')

      const hits = await index.search({ query: [1, 0], k: 5 })
      t.alike(
        hits.map((hit) => hit.id),
        ['1', '2', '3'],
        'a single query returns one flat hit list without padding'
      )
      t.is(calls.searchIvf, 1, 'search probes the IVF lists')
      t.is(calls.search, 0, 'search skips the full scan')
      t.is(lastIvfArgs.nProbe, 1, 'search probes the configured number of lists')

      const rows = await index.search({
        queries: [
          [0, 1],
          [1, 0]
        ],
        k: 1,
        nProbe: 2
      })
      t.is(rows.length, 2, 'multi-query search returns one list per query')
      t.is(lastIvfArgs.nProbe, 2, 'a per-call nProbe overrides the setting')
      t.is(index.ivf?.nProbe, 1, 'the override leaves the setting alone')

      await index.setIvf({ nLists: 2, nProbe: 3 })
      t.is(calls.buildIvf, 1, 'a new probe count alone keeps the built lists')
      await index.search({ query: [1, 0], k: 1 })
      t.is(lastIvfArgs.nProbe, 3)
      await index.setIvf({ nLists: 2, nProbe: 3, nIter: 5 })
      t.is(calls.buildIvf, 2, 'a new iteration count rebuilds')
      t.is(lastIvfArgs.nIter, 5, 'nIter reaches the provider')
      t.alike(index.ivf, { nLists: 2, nProbe: 3, nIter: 5, built: true })
    },
    { ivf: true }
  )
})

test('vector index: a mutation makes search scan in full until setIvf builds again', async (t) => {
  await withProvider(
    async (calls) => {
      const index = await createVectorIndex({ dim: 2 })
      await index.add({
        ids: ['1', '2'],
        vectors: [
          [1, 0],
          [0, 1]
        ]
      })
      await index.setIvf({ nLists: 2, nProbe: 1 })

      await index.add({ ids: ['3'], vectors: [[1, 1]] })
      t.alike(index.ivf, { nLists: 2, nProbe: 1, built: false }, 'add reports stale IVF state')
      const preparedBeforeSearch = calls.prepare
      t.is((await index.search({ query: [1, 0], k: 5, nProbe: 2 })).length, 3)
      t.is(calls.searchIvf, 0, 'stale lists are never probed')
      t.is(calls.search, 1, 'search falls back to the full scan, nProbe included')
      t.is(calls.prepare, preparedBeforeSearch + 1, 'the fallback prepares the changed index')

      await index.setIvf({ nLists: 2, nProbe: 1 })
      t.is(calls.buildIvf, 2, 'the same settings rebuild stale lists')
      t.is(index.ivf?.built, true)
      await index.search({ query: [1, 0], k: 1 })
      t.is(calls.searchIvf, 1, 'search probes again after the rebuild')

      t.alike(await index.remove({ ids: ['9'] }), [false])
      t.is(index.ivf?.built, true, 'removing an absent id keeps the lists')
      await index.remove({ ids: ['3'] })
      t.is(index.ivf?.built, false, 'remove reports stale IVF state')

      await index.dispose()
      await expectRejects(
        t,
        () => index.setIvf({ nLists: 2, nProbe: 1 }),
        VectorIndexNotFoundError,
        'a disposed index rejects setIvf'
      )
    },
    { ivf: true }
  )
})

test('vector index: setIvf(null) turns IVF off and nProbe then rejects', async (t) => {
  await withProvider(
    async (calls) => {
      const index = await createVectorIndex({ dim: 2 })
      await index.add({ ids: ['1'], vectors: [[1, 0]] })
      await index.setIvf({ nLists: 1, nProbe: 1 })

      t.alike(await index.setIvf(null), { ivf: null })
      t.is(index.ivf, null)
      await index.search({ query: [1, 0], k: 1 })
      t.is(calls.searchIvf, 0, 'search scans in full while IVF is off')
      t.is(calls.search, 1)
      await expectRejects(
        t,
        () => index.search({ query: [1, 0], k: 1, nProbe: 1 }),
        VectorIndexFailedError,
        'nProbe without IVF is a coded error'
      )
      t.is(calls.search, 1, 'the refused search never reaches the provider')

      await index.setIvf({ nLists: 1, nProbe: 1 })
      t.is(calls.buildIvf, 2, 'turning IVF back on builds again')
    },
    { ivf: true }
  )
})

test('vector index: a failed IVF build falls back to the full scan', async (t) => {
  await withProvider(
    async (calls, failures, _failRemoveId, lastIvfArgs) => {
      const index = await createVectorIndex({ dim: 2 })
      await index.add({ ids: ['1'], vectors: [[1, 0]] })
      await index.setIvf({ nLists: 1, nProbe: 1 })
      failures.buildIvf = true
      await expectRejects(
        t,
        () => index.setIvf({ nLists: 2, nProbe: 2 }),
        VectorIndexFailedError,
        'the build failure is a coded error'
      )
      failures.buildIvf = false
      const previous = { nLists: 1, nProbe: 1, built: true }
      t.alike(index.ivf, previous, 'the handle keeps the last reported state')
      // The native index may drop its lists when a build fails, so the worker
      // stops probing them.
      await index.search({ query: [1, 0], k: 1 })
      t.is(calls.searchIvf, 0, 'search never probes lists from before the failed build')
      t.is(calls.search, 1, 'search falls back to the full scan')
      await index.add({ ids: ['2'], vectors: [[0, 1]] })
      t.alike(index.ivf, { ...previous, built: false }, 'the worker kept the earlier settings')
      await index.setIvf({ nLists: 1, nProbe: 1 })
      t.is(calls.buildIvf, 3, 'the earlier settings build again')
      await index.search({ query: [1, 0], k: 1 })
      t.is(calls.searchIvf, 1, 'search probes the rebuilt lists')
      t.is(lastIvfArgs.nProbe, 1)
    },
    { ivf: true }
  )
})

test('vector index: providers without IVF report undefined and reject IVF calls', async (t) => {
  await withProvider(async (calls) => {
    const index = await createVectorIndex({ dim: 2 })
    t.is(index.ivf, undefined)
    await index.add({ ids: ['1'], vectors: [[1, 0]] })
    t.is(index.ivf, undefined, 'add reports no IVF state')
    await expectRejects(
      t,
      () => index.setIvf({ nLists: 1, nProbe: 1 }),
      VectorIndexFailedError,
      'setIvf reports a coded error'
    )
    try {
      await index.search({ query: [1, 0], k: 1, nProbe: 1 })
      t.fail('nProbe should reject')
    } catch (error) {
      t.ok(error instanceof VectorIndexFailedError, 'nProbe reports a coded error')
      t.ok(
        error instanceof Error && error.message.includes('does not support IVF search'),
        'the error names the missing support instead of pointing to setIvf()'
      )
    }
    t.is(calls.prepare, 0, 'the refused search runs no warm-up')
    t.is((await index.search({ query: [1, 0], k: 1 })).length, 1, 'plain search still works')
  })
})

test('vector index: IVF arguments are validated before the provider is reached', async (t) => {
  await withProvider(
    async (calls) => {
      const index = await createVectorIndex({ dim: 2 })
      await expectRejects(
        t,
        () => index.search({ query: [1], k: 1, nProbe: 1 }),
        RequestValidationFailedError,
        'the client rejects a query of the wrong length'
      )
      await expectRejects(
        t,
        () => index.setIvf({ nLists: 0, nProbe: 1 }),
        RequestValidationFailedError,
        'the worker rejects a non-positive list count'
      )
      await expectRejects(
        t,
        () => index.setIvf({ nLists: 1, nProbe: 0 }),
        RequestValidationFailedError,
        'the worker rejects a non-positive probe count'
      )
      await expectRejects(
        t,
        () => index.search({ query: [1, 0], k: 1, nProbe: 0 }),
        RequestValidationFailedError,
        'the worker rejects a non-positive per-call probe count'
      )
      t.is(calls.buildIvf, 0)
      t.is(calls.search + calls.searchIvf, 0)
    },
    { ivf: true }
  )
})
