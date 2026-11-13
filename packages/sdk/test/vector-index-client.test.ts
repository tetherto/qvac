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
      case 'setIvf': {
        const ivf = req['ivf'] as Record<string, unknown> | null
        return { type: 'vectorIndex', operation: 'setIvf', ivf: ivf && { ...ivf, built: true } }
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
    storage: 'turbovec-q4',
    requestId: sent[0]?.request['requestId']
  })
})

test('vector index client: every operation is sent under a request id the caller can read first', async (t) => {
  const { send, sent } = fakeTransport()
  const { createVectorIndex, loadVectorIndex } = createVectorIndexClient(send)

  const opening = createVectorIndex({ dim: 2 })
  t.is(typeof opening.requestId, 'string', 'the id is readable before the open settles')
  const index = await opening
  t.is(sent[0]?.request['requestId'], opening.requestId, 'the open was sent under that id')

  const adding = index.add({ ids: ['1'], vectors: [[1, 0]] })
  const searching = index.search({ query: [1, 0], k: 1 })
  const checking = index.contains({ ids: ['1'] })
  const removing = index.remove({ ids: ['1'] })
  const writing = index.write({ path: 'a.qvi' })
  const disposing = index.dispose()
  await Promise.all([adding, searching, checking, removing, writing, disposing])
  const ids = [adding, searching, checking, removing, writing, disposing].map((op) => op.requestId)
  t.alike(
    sent.slice(1).map((entry) => entry.request['requestId']),
    ids,
    'each operation carries its own id on the wire'
  )
  t.is(new Set([opening.requestId, ...ids]).size, 7, 'the ids are distinct')

  const loading = loadVectorIndex({ path: 'a.qvi' })
  await loading
  t.is(sent.at(-1)?.request['requestId'], loading.requestId)
})

test('vector index client: a handle keeps the transport it was opened on', async (t) => {
  // A session builds its client over a transport that stamps its id; every
  // later call on the handle must go through the same transport.
  const { send, sent } = fakeTransport()
  const stamped = ((request: unknown, options?: Record<string, unknown>) =>
    send(request, { ...options, sessionId: 's-1' })) as typeof send
  const { createVectorIndex } = createVectorIndexClient(stamped)

  const index = await createVectorIndex({ dim: 2 })
  await index.add({ ids: ['1'], vectors: [[1, 0]] })
  await index.search({ query: [1, 0], k: 1 }, { timeout: 10 })
  await index.dispose()
  t.alike(
    sent.map((entry) => (entry.options as { sessionId?: string }).sessionId),
    ['s-1', 's-1', 's-1', 's-1'],
    'open, add, search and dispose all carry the session'
  )
  t.alike(sent[2]?.options, { timeout: 10, sessionId: 's-1' }, 'per-call options are kept')
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

test('vector index client: calibration and staged search follow confirmed responses', async (t) => {
  let reject = false
  const { send, sent } = fakeTransport({
    create: () => ({
      type: 'vectorIndex',
      operation: 'create',
      indexId: 'i',
      dim: 8,
      storage: 'turbovec-q4',
      length: 0,
      calibrated: false,
      stagedSearch: false
    }),
    add: () => {
      if (reject) throw new Error('add failed')
      return {
        type: 'vectorIndex',
        operation: 'add',
        length: 1000,
        calibrated: true,
        // Another caller turned the setting off on the worker.
        stagedSearch: false
      }
    },
    setStagedSearch: (req) => {
      if (reject) throw new Error('setting failed')
      return { type: 'vectorIndex', operation: 'setStagedSearch', stagedSearch: req['enabled'] }
    },
    load: () => ({
      type: 'vectorIndex',
      operation: 'load',
      indexId: 'loaded',
      dim: 8,
      length: 1000,
      calibrated: true,
      stagedSearch: false
    })
  })
  const client = createVectorIndexClient(send)
  const index = await client.createVectorIndex({ dim: 8 })
  t.is(index.calibrated, false)
  t.is(index.stagedSearch, false)
  const setting = index.setStagedSearch({ enabled: true }, { timeout: 1234 })
  t.alike(await setting, { stagedSearch: true })
  t.is(index.stagedSearch, true)
  t.alike(sent[1]?.request, {
    type: 'vectorIndex',
    operation: 'setStagedSearch',
    indexId: 'i',
    enabled: true,
    requestId: setting.requestId
  })
  t.alike(sent[1]?.options, { timeout: 1234 })
  reject = true
  await t.exception(() => index.setStagedSearch({ enabled: false }), /setting failed/)
  await t.exception(() => index.add({ ids: ['1'], vectors: [new Array(8).fill(1)] }), /add failed/)
  t.is(index.stagedSearch, true, 'a failed setting does not change cached state')
  t.is(index.calibrated, false, 'a failed add does not change cached state')
  reject = false
  await index.add({ ids: ['1'], vectors: [new Array(8).fill(1)] })
  t.is(index.calibrated, true)
  t.is(index.stagedSearch, false, 'add reports the setting held by the worker')
  const loaded = await client.loadVectorIndex({ path: 'calibrated.qvi' })
  t.is(loaded.calibrated, true)
  t.is(loaded.stagedSearch, false, 'loading reports the reset setting')
})

test('vector index client: providers without controls leave state unknown', async (t) => {
  const { send } = fakeTransport()
  const index = await createVectorIndexClient(send).createVectorIndex({ dim: 8 })
  t.is(index.calibrated, undefined)
  t.is(index.stagedSearch, undefined)
})

test('vector index client: setIvf sends the settings and tracks the reported state', async (t) => {
  const { send, sent } = fakeTransport({
    add: () => ({
      type: 'vectorIndex',
      operation: 'add',
      length: 1,
      ivf: { nLists: 4, nProbe: 2, built: false }
    }),
    remove: () => ({ type: 'vectorIndex', operation: 'remove', removed: [true], length: 0 })
  })
  const { createVectorIndex } = createVectorIndexClient(send)
  const index = await createVectorIndex({ dim: 2 })
  t.is(index.ivf, undefined, 'a create response without ivf leaves it unknown')

  const setting = index.setIvf({ nLists: 4, nProbe: 2 })
  const result = await setting
  t.alike(result, { ivf: { nLists: 4, nProbe: 2, built: true } })
  t.alike(index.ivf, result.ivf)
  t.alike(
    sent[1]?.request,
    {
      type: 'vectorIndex',
      operation: 'setIvf',
      indexId: 'idx-1',
      ivf: { nLists: 4, nProbe: 2 },
      requestId: setting.requestId
    },
    'an omitted nIter is left off the wire'
  )
  await index.setIvf({ nLists: 4, nProbe: 2, nIter: 0 }, { timeout: 1000 })
  t.alike(sent[2]?.request['ivf'], { nLists: 4, nProbe: 2, nIter: 0 }, 'nIter 0 is sent')
  t.alike(sent[2]?.options, {}, 'the timeout stays on the client')

  await index.add({ ids: ['1'], vectors: [[1, 0]] })
  t.alike(index.ivf, { nLists: 4, nProbe: 2, built: false }, 'add updates the IVF state')
  await index.remove({ ids: ['1'] })
  t.is(index.ivf, undefined, 'remove updates the IVF state too')

  t.alike(await index.setIvf(null), { ivf: null })
  t.is(sent.at(-1)?.request['ivf'], null, 'null turns IVF off on the wire')
  t.is(index.ivf, null)
})

test('vector index client: a setIvf reply after a timeout still updates ivf', async (t) => {
  let reply: (response: unknown) => void = () => {}
  const { send } = fakeTransport({ setIvf: () => new Promise((resolve) => (reply = resolve)) })
  const { createVectorIndex } = createVectorIndexClient(send)
  const index = await createVectorIndex({ dim: 2 })

  await t.exception(index.setIvf({ nLists: 4, nProbe: 2 }, { timeout: 100 }), /timeout/)
  t.is(index.ivf, undefined, 'the timed-out call leaves ivf as it was')

  reply({ type: 'vectorIndex', operation: 'setIvf', ivf: { nLists: 4, nProbe: 2, built: true } })
  await new Promise((resolve) => setImmediate(resolve))
  t.alike(index.ivf, { nLists: 4, nProbe: 2, built: true }, 'the late reply updates ivf')
})

test('vector index client: search sends nProbe only when given', async (t) => {
  const { send, sent } = fakeTransport()
  const { createVectorIndex } = createVectorIndexClient(send)
  const index = await createVectorIndex({ dim: 2 })

  const searching = index.search({ query: [1, 0], k: 3, nProbe: 2 })
  const hits = await searching
  t.alike(hits, [{ id: '1', score: 0.9 }], 'a single query returns one flat hit list')
  t.alike(sent[1]?.request, {
    type: 'vectorIndex',
    operation: 'search',
    indexId: 'idx-1',
    queries: [[1, 0]],
    k: 3,
    nProbe: 2,
    requestId: searching.requestId
  })
  const rows = await index.search({
    queries: [
      [1, 0],
      [0, 1]
    ],
    k: 1
  })
  t.is(rows.length, 2, 'batch search returns one list per query')
  t.absent('nProbe' in (sent[2]?.request ?? {}), 'an omitted nProbe is left off the wire')
})
