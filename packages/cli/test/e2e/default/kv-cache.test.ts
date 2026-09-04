import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'

describe('qvac kv_cache: surface', () => {
  const server = useServer()

  it('is advertised in the OpenAPI document', async () => {
    const res = await server().inject({ method: 'GET', url: '/openapi.json' })

    assert.equal(res.statusCode, 200)
    const doc = res.json() as { paths: Record<string, { delete?: unknown }> }
    assert.ok('/qvac/v1/kv_cache' in doc.paths, 'kv_cache path missing from openapi.json')
    assert.ok(doc.paths['/qvac/v1/kv_cache']?.delete, 'kv_cache is mounted as DELETE')
  })
})

describe('qvac kv_cache: not mounted without the QVAC surface', () => {
  const server = useServer({ extensions: ['openai'] })

  it('returns 404', async () => {
    const res = await server().inject({ method: 'DELETE', url: '/qvac/v1/kv_cache' })

    assert.equal(res.statusCode, 404)
  })
})
