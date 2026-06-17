import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { assertError, JSON_HEADERS } from '../helpers/http.js'

// Ported from cli.bats "Serve: embeddings validation".
describe('serve: embeddings validation', () => {
  const server = useServer({ cors: true })

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/embeddings', headers: JSON_HEADERS, payload: '{{bad'
    })
    assert.equal(res.statusCode, 400)
    assertError(res, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/embeddings', payload: { input: 'hello' }
    })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_model')
  })

  it('missing input returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/embeddings', payload: { model: 'test' }
    })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_input')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/embeddings', payload: { model: 'nonexistent', input: 'hello' }
    })
    assert.equal(res.statusCode, 404)
    assertError(res, 'model_not_found')
  })
})
