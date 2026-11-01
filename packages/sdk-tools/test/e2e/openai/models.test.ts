import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { assertStatusAndError } from '../helpers/http.js'

describe('serve: models endpoint', () => {
  const server = useServer({ cors: true, corsOrigins: ['https://trusted.example'] })

  it('GET /v1/models lists every configured model (loaded or not)', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/models' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as {
      object: string
      data: Array<{ id: string; object: string; owned_by: string }>
    }
    assert.equal(body.object, 'list')
    // MODELLESS_CONFIG declares one (preload:false) model; it is listed even
    // though it is never loaded, because it would lazy-load on first request.
    assert.deepEqual(
      body.data.map((m) => m.id),
      ['fake-transcribe']
    )
    assert.ok(body.data.every((m) => m.object === 'model' && m.owned_by === 'qvac'))
  })

  it('GET /v1/models/:id returns a configured-but-idle model', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/models/fake-transcribe' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { id: string; object: string; owned_by: string }
    assert.equal(body.id, 'fake-transcribe')
    assert.equal(body.object, 'model')
  })

  it('GET /v1/models/:id returns 404 for unknown model', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/models/nonexistent' })
    assertStatusAndError(res, 404, 'model_not_found')
  })

  it('DELETE /v1/models/:id returns 404 for unknown model', async () => {
    const res = await server().inject({ method: 'DELETE', url: '/v1/models/nonexistent' })
    assertStatusAndError(res, 404, 'model_not_found')
  })
})
