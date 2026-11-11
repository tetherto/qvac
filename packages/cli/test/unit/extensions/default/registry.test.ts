import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import {
  ModelRegistryBusyError,
  ModelRegistryModelNotFoundError,
  type ModelRegistryEntry,
  type ModelRegistrySearchParams
} from '@qvac/sdk'
import { buildServer } from '@/serve/index'
import { registryRoutes } from '@/serve/extensions/default/routes/registry'
import {
  REGISTRY_ADDONS,
  REGISTRY_FIELD_CODES,
  registryLookupQuery,
  registryModelsQuery
} from '@/serve/extensions/default/schemas/registry'
import { extensionErrorCodes } from '@/serve/core/extensions'
import { EXTENSIONS } from '@/serve/extensions'

function entry(registryPath: string, registrySource = 'hf'): ModelRegistryEntry {
  const modelId = registryPath.split('/').pop()!
  return {
    name: modelId.replace(/\.\w+$/, ''),
    registryPath,
    registrySource,
    blobCoreKey: 'ab',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0,
    modelId,
    addon: 'llm',
    expectedSize: 1024,
    sha256Checksum: 'cd',
    engine: 'llamacpp-completion',
    quantization: 'q4',
    params: '600M'
  }
}

const ENTRIES = [entry('org/a/blob/1/a.gguf'), entry('org/b/blob/1/b.gguf'), entry('org/c/c.gguf')]

describe('registry query schemas', () => {
  it('accepts every SDK addon and rejects others', () => {
    for (const addon of REGISTRY_ADDONS) {
      assert.equal(registryModelsQuery.safeParse({ addon }).success, true)
    }
    assert.equal(registryModelsQuery.safeParse({ addon: 'nope' }).success, false)
  })

  it('coerces paging and rejects bad values', () => {
    assert.deepEqual(registryModelsQuery.parse({ limit: '2', offset: '0' }), {
      limit: 2,
      offset: 0
    })
    assert.equal(registryModelsQuery.safeParse({ limit: '0' }).success, false)
    assert.equal(registryModelsQuery.safeParse({ offset: '-1' }).success, false)
  })

  it('requires a non-empty source and path for a lookup', () => {
    assert.equal(registryLookupQuery.safeParse({ registrySource: 'hf' }).success, false)
    assert.equal(
      registryLookupQuery.safeParse({ registrySource: '', registryPath: 'a' }).success,
      false
    )
  })

  // Field codes are global across mounted extensions; a clash fails startup.
  it('agrees with every other extension on shared field names', () => {
    assert.doesNotThrow(() => extensionErrorCodes(EXTENSIONS))
    assert.equal(extensionErrorCodes(EXTENSIONS)['addon'], REGISTRY_FIELD_CODES['addon'])
  })
})

describe('registry routes', () => {
  let app: FastifyInstance
  let calls: ModelRegistrySearchParams[]
  let fail: boolean
  let busy: 'current' | 'legacy' | null = null
  let bound: string[] = []

  before(async () => {
    app = await buildServer({
      projectRoot: tmpdir(),
      port: 0,
      host: '127.0.0.1',
      quiet: true,
      extensions: []
    })
    // Records the ids the routes bind for disconnect cancellation.
    app.addHook('onRequest', (req, _reply, done) => {
      const bindCancel = req.bindCancel
      req.bindCancel = (requestId) => {
        bound.push(requestId)
        bindCancel(requestId)
      }
      done()
    })
    const withId = <T>(promise: Promise<T>, requestId: string) =>
      Object.assign(promise, { requestId })
    await app.register(
      registryRoutes({
        search: (params) =>
          withId(
            Promise.resolve().then(() => {
              calls.push(params)
              if (busy) throw new ModelRegistryBusyError(busy, 60_000)
              if (fail) throw new Error('registry offline')
              return ENTRIES
            }),
            'search-1'
          ),
        getModel: (registryPath, registrySource) =>
          withId(
            Promise.resolve().then(() => {
              if (busy) throw new ModelRegistryBusyError(busy, 60_000)
              if (fail) throw new Error('registry offline')
              const entry = ENTRIES.find(
                (m) => m.registrySource === registrySource && m.registryPath === registryPath
              )
              if (!entry) throw new ModelRegistryModelNotFoundError(registrySource, registryPath)
              return entry
            }),
            'lookup-1'
          )
      })
    )
    await app.ready()
  })
  after(async () => {
    await app.close()
  })

  function get(url: string) {
    calls = []
    fail = false
    busy = null
    bound = []
    return app.inject({ method: 'GET', url })
  }

  it('lists every entry when no filter is given', async () => {
    const res = await get('/qvac/v1/registry/models')
    assert.equal(res.statusCode, 200, res.payload)
    const body = res.json() as { object: string; data: ModelRegistryEntry[]; has_more: boolean }
    assert.equal(body.object, 'list')
    assert.equal(body.data.length, 3)
    assert.equal(body.has_more, false)
    assert.deepEqual(calls, [{}])
  })

  it('passes filters to the SDK, renaming search to filter', async () => {
    await get(
      '/qvac/v1/registry/models?search=qwen&addon=llm&engine=llamacpp-completion&quantization=q4'
    )
    assert.deepEqual(calls, [
      { filter: 'qwen', addon: 'llm', engine: 'llamacpp-completion', quantization: 'q4' }
    ])
  })

  it('pages the result', async () => {
    const body = (await get('/qvac/v1/registry/models?limit=1&offset=1')).json() as {
      data: ModelRegistryEntry[]
      has_more: boolean
    }
    assert.deepEqual(
      body.data.map((m) => m.registryPath),
      ['org/b/blob/1/b.gguf']
    )
    assert.equal(body.has_more, true)
  })

  it('looks an entry up by exact source and path', async () => {
    const res = await get(
      `/qvac/v1/registry/models/lookup?registrySource=hf&registryPath=${encodeURIComponent('org/b/blob/1/b.gguf')}`
    )
    assert.equal(res.statusCode, 200, res.payload)
    assert.equal((res.json() as ModelRegistryEntry).modelId, 'b.gguf')
  })

  it('returns 404 when the SDK reports the model missing', async () => {
    for (const query of [
      'registrySource=other&registryPath=org/a/blob/1/a.gguf',
      'registrySource=hf&registryPath=org/a'
    ]) {
      const res = await get(`/qvac/v1/registry/models/lookup?${query}`)
      assert.equal(res.statusCode, 404, query)
      assert.equal((res.json() as { error: { code: string } }).error.code, 'model_not_found')
    }
  })

  it('binds each query so a client disconnect cancels its wait', async () => {
    await get('/qvac/v1/registry/models')
    assert.deepEqual(bound, ['search-1'])
    await get(
      `/qvac/v1/registry/models/lookup?registrySource=hf&registryPath=${encodeURIComponent('org/b/blob/1/b.gguf')}`
    )
    assert.deepEqual(bound, ['lookup-1'])
  })

  it('maps a busy registry to 503 registry_busy on both routes', async () => {
    for (const holder of ['current', 'legacy'] as const) {
      for (const url of [
        '/qvac/v1/registry/models',
        '/qvac/v1/registry/models/lookup?registrySource=hf&registryPath=x'
      ]) {
        calls = []
        fail = false
        busy = holder
        const res = await app.inject({ method: 'GET', url })
        busy = null
        assert.equal(res.statusCode, 503, url)
        const body = res.json() as { error: { code: string; message: string } }
        assert.equal(body.error.code, 'registry_busy')
        assert.match(body.error.message, /Another QVAC process/)
        // Only a holder on this SDK hands the registry over, so only then is a retry soon useful.
        assert.equal(res.headers['retry-after'], holder === 'current' ? '5' : undefined, holder)
      }
    }
  })

  it('maps an SDK failure to 502 on both routes', async () => {
    for (const url of [
      '/qvac/v1/registry/models',
      '/qvac/v1/registry/models/lookup?registrySource=hf&registryPath=x'
    ]) {
      calls = []
      fail = true
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 502, url)
      const body = res.json() as { error: { code: string; message: string } }
      assert.equal(body.error.code, 'registry_query_failed')
      assert.doesNotMatch(body.error.message, /offline/)
    }
  })
})
