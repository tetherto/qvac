import test from 'brittle'
import { createVectorIndexClient } from '@/client/api/vector-index'
import { InvalidResponseError, RequestValidationFailedError } from '@/utils/errors-client'

interface Sent {
  request: Record<string, unknown>
  options: unknown
}

// A fake transport that answers every operation the way the worker would,
// recording each request so the wire shape can be asserted.
function fakeTransport(
  overrides: Partial<Record<string, (request: Record<string, unknown>) => unknown>> = {}
) {
  const sent: Sent[] = []
  let length = 0
  async function send(request: unknown, options?: unknown) {
    const req = request as Record<string, unknown>
    sent.push({ request: req, options })
    const override = overrides[String(req['operation'])]
    if (override) return override(req)
    switch (req['operation']) {
      case 'create':
        return {
          type: 'vectorIndex',
          operation: 'create',
          indexId: 'idx-1',
          dim: req['dim'],
          storage: req['storage'],
          length: 0
        }
      case 'load':
        return { type: 'vectorIndex', operation: 'load', indexId: 'idx-2', dim: 3, length: 5 }
      case 'add':
        length += (req['ids'] as unknown[]).length
        return { type: 'vectorIndex', operation: 'add', length }
      case 'search':
        return {
          type: 'vectorIndex',
          operation: 'search',
          results: (req['queries'] as unknown[]).map((_row, i) => [
            { id: String(i + 1), score: 0.9 }
          ])
        }
      case 'remove':
        length -= 1
        return { type: 'vectorIndex', operation: 'remove', removed: [true, false], length }
      case 'contains':
        return { type: 'vectorIndex', operation: 'contains', present: [true, false] }
      case 'write':
        return {
          type: 'vectorIndex',
          operation: 'write',
          path: '/data/.qvac/' + String(req['path'])
        }
      case 'dispose':
        return { type: 'vectorIndex', operation: 'dispose', disposed: true }
      default:
        throw new Error(`unexpected operation ${String(req['operation'])}`)
    }
  }
  return { send: send as never, sent }
}

test('vector index client: create applies the default storage and returns a populated handle', async (t) => {
  const { send, sent } = fakeTransport()
  const { createVectorIndex } = createVectorIndexClient(send)

  const index = await createVectorIndex({ dim: 3 })
  t.is(index.indexId, 'idx-1')
  t.is(index.dim, 3)
  t.is(index.storage, 'turbovec-q4')
  t.is(index.length, 0)
  t.alike(sent[0]?.request, {
    type: 'vectorIndex',
    operation: 'create',
    dim: 3,
    storage: 'turbovec-q4'
  })
})

test('vector index client: ids are normalized to wire form and length follows the worker', async (t) => {
  const { send, sent } = fakeTransport()
  const { createVectorIndex } = createVectorIndexClient(send)
  const index = await createVectorIndex({ dim: 2, storage: 'f32' })

  const added = await index.add({
    ids: [1n, '2', 3],
    vectors: [
      [1, 0],
      [0, 1],
      [1, 1]
    ]
  })
  t.is(added.length, 3)
  t.is(index.length, 3)
  t.alike(
    sent[1]?.request['ids'],
    ['1', '2', 3],
    'bigint becomes a decimal string, others pass through'
  )

  const removed = await index.remove({ ids: [1n, 9] })
  t.alike(removed, [true, false])
  t.is(index.length, 2)
  t.alike(sent[2]?.request['ids'], ['1', 9])

  t.alike(await index.contains({ ids: ['1', '9'] }), [true, false])
})

test('vector index client: single and batch search shapes', async (t) => {
  const { send, sent } = fakeTransport()
  const { createVectorIndex } = createVectorIndexClient(send)
  const index = await createVectorIndex({ dim: 2 })

  const hits = await index.search({ query: [1, 0], k: 1 })
  t.alike(hits, [{ id: '1', score: 0.9 }], 'a single query returns one flat hit list')
  t.alike(sent[1]?.request['queries'], [[1, 0]], 'the single query is sent as one row')

  const rows = await index.search(
    {
      queries: [
        [1, 0],
        [0, 1]
      ],
      k: 1
    },
    { timeout: 5000 }
  )
  t.is(rows.length, 2, 'batch search returns one list per query')
  t.alike(sent[2]?.options, { timeout: 5000 }, 'RPC options reach the transport')
})

test('vector index client: row length mismatches are rejected before sending', async (t) => {
  const { send, sent } = fakeTransport()
  const { createVectorIndex } = createVectorIndexClient(send)
  const index = await createVectorIndex({ dim: 2 })
  const requestsAfterCreate = sent.length

  await t.exception(
    () => index.add({ ids: ['1'], vectors: [[1, 2, 3]] }),
    /vectors\[0\] has 3 components, expected 2/
  )
  await t.exception(
    () => index.search({ query: [1], k: 1 }),
    /queries\[0\] has 1 components, expected 2/
  )
  try {
    await index.search({ queries: [[1, 2], [3]], k: 1 })
    t.fail('expected a rejection')
  } catch (error) {
    t.ok(error instanceof RequestValidationFailedError)
  }
  t.is(sent.length, requestsAfterCreate, 'nothing was sent')
})

test('vector index client: write returns the resolved path and dispose is idempotent', async (t) => {
  const { send, sent } = fakeTransport()
  const { createVectorIndex } = createVectorIndexClient(send)
  const index = await createVectorIndex({ dim: 2 })

  const written = await index.write({ path: 'indexes/a.qvi' })
  t.is(written.path, '/data/.qvac/indexes/a.qvi')

  await index.dispose()
  await index.dispose()
  const disposeRequests = sent.filter((entry) => entry.request['operation'] === 'dispose')
  t.is(disposeRequests.length, 1, 'the second dispose does not reach the worker')

  if (typeof Symbol.asyncDispose === 'symbol') {
    const other = await createVectorIndex({ dim: 2 })
    await other[Symbol.asyncDispose]()
    t.is(sent.filter((entry) => entry.request['operation'] === 'dispose').length, 2)
  }
})

test('vector index client: a failed dispose can be retried', async (t) => {
  let failNext = true
  const { send, sent } = fakeTransport({
    dispose: () => {
      if (failNext) {
        failNext = false
        throw new Error('worker busy')
      }
      return { type: 'vectorIndex', operation: 'dispose', disposed: true }
    }
  })
  const { createVectorIndex } = createVectorIndexClient(send)
  const index = await createVectorIndex({ dim: 2 })

  try {
    await index.dispose()
    t.fail('expected the first dispose to reject')
  } catch (error) {
    t.ok(error instanceof Error && error.message === 'worker busy')
  }
  await index.dispose()
  await index.dispose()
  const disposeRequests = sent.filter((entry) => entry.request['operation'] === 'dispose')
  t.is(
    disposeRequests.length,
    2,
    'the retry reaches the worker; the confirmed dispose does not repeat'
  )
})

test('vector index client: load reports dim and length and leaves storage undefined when absent', async (t) => {
  const { send } = fakeTransport()
  const { loadVectorIndex } = createVectorIndexClient(send)
  const index = await loadVectorIndex({ path: 'indexes/a.qvi' })
  t.is(index.indexId, 'idx-2')
  t.is(index.dim, 3)
  t.is(index.length, 5)
  t.is(index.storage, undefined)
})

test('vector index client: a response of another type is rejected', async (t) => {
  const { send } = fakeTransport({
    create: () => ({ type: 'heartbeat', number: 1 })
  })
  const { createVectorIndex } = createVectorIndexClient(send)
  try {
    await createVectorIndex({ dim: 2 })
    t.fail('expected a rejection')
  } catch (error) {
    t.ok(error instanceof InvalidResponseError)
  }
})
