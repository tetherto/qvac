import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { assertStatusAndError } from '../helpers/http.js'

describe('serve: models endpoint', () => {
  const server = useServer({ cors: true })

  it('GET /v1/models returns empty list', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/models' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { object: string; data: unknown[] }
    assert.equal(body.object, 'list')
    assert.equal(body.data.length, 0)
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
