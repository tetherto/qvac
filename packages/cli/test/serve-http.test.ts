import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { buildServer } from '../src/serve/index.js'

// Wire-level validation is covered by the bats e2e suite. This file only
// pins the OpenAPI document because that's a unique testability angle.
describe('serve openapi', () => {
  it('exposes every route at /openapi.json', async () => {
    const app = await buildServer({
      projectRoot: tmpdir(),
      port: 0,
      host: '127.0.0.1'
    })
    try {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' })
      assert.equal(res.statusCode, 200)
      const doc = JSON.parse(res.payload) as { openapi: string; paths: Record<string, unknown> }
      assert.match(doc.openapi, /^3\./)
      for (const path of [
        '/v1/chat/completions',
        '/v1/completions',
        '/v1/embeddings',
        '/v1/responses',
        '/v1/audio/transcriptions',
        '/v1/audio/translations',
        '/v1/audio/speech',
        '/v1/audio/voices',
        '/v1/audio/models',
        '/v1/images/generations',
        '/v1/images/edits',
        '/v1/files',
        '/v1/vector_stores',
        '/v1/models'
      ]) {
        assert.ok(path in doc.paths, `missing ${path} in openapi.json`)
      }
    } finally {
      await app.close()
    }
  })
})
