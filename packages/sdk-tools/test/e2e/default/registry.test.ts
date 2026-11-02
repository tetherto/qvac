import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { assertStatusAndError } from '../helpers/http.js'

describe('qvac registry: validation', () => {
  const server = useServer()

  function get(url: string) {
    return server().inject({ method: 'GET', url })
  }

  it('rejects an unknown addon', async () => {
    assertStatusAndError(await get('/qvac/v1/registry/models?addon=nope'), 400, 'invalid_addon')
  })

  it('rejects bad paging', async () => {
    assertStatusAndError(await get('/qvac/v1/registry/models?limit=0'), 400, 'invalid_limit')
    assertStatusAndError(await get('/qvac/v1/registry/models?limit=x'), 400, 'invalid_limit')
    assertStatusAndError(await get('/qvac/v1/registry/models?offset=-1'), 400, 'invalid_offset')
  })

  it('requires a lookup source and path', async () => {
    assertStatusAndError(
      await get('/qvac/v1/registry/models/lookup?registryPath=a.gguf'),
      400,
      'invalid_registry_source'
    )
    assertStatusAndError(
      await get('/qvac/v1/registry/models/lookup?registrySource=hf&registryPath='),
      400,
      'invalid_registry_path'
    )
  })
})

interface OpenApiOperation {
  tags?: string[]
  responses?: Record<string, { description?: string }>
}

describe('qvac registry: surface', () => {
  const server = useServer()

  async function operation(path: string): Promise<OpenApiOperation | undefined> {
    const res = await server().inject({ method: 'GET', url: '/openapi.json' })
    assert.equal(res.statusCode, 200)
    const doc = res.json() as { paths: Record<string, Record<string, OpenApiOperation>> }
    return doc.paths[path]?.['get']
  }

  it('lists each error code under its status', async () => {
    const list = await operation('/qvac/v1/registry/models')
    assert.deepEqual(list?.tags, ['Registry'])
    for (const code of ['invalid_addon', 'invalid_limit', 'invalid_offset']) {
      assert.match(list?.responses?.['400']?.description ?? '', new RegExp(`\`${code}\``))
    }
    assert.match(list?.responses?.['502']?.description ?? '', /`registry_query_failed`/)

    const lookup = await operation('/qvac/v1/registry/models/lookup')
    assert.deepEqual(lookup?.tags, ['Registry'])
    for (const code of ['invalid_registry_source', 'invalid_registry_path']) {
      assert.match(lookup?.responses?.['400']?.description ?? '', new RegExp(`\`${code}\``))
    }
    assert.match(lookup?.responses?.['404']?.description ?? '', /`model_not_found`/)
    assert.match(lookup?.responses?.['502']?.description ?? '', /`registry_query_failed`/)
  })
})

describe('qvac registry: not mounted without the QVAC surface', () => {
  const server = useServer({ extensions: ['openai'] })

  it('returns 404', async () => {
    const res = await server().inject({ method: 'GET', url: '/qvac/v1/registry/models' })
    assert.equal(res.statusCode, 404)
  })
})
