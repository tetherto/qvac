import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { assertError, JSON_HEADERS } from '../helpers/http.js'

describe('serve: chat completions validation', () => {
  const server = useServer({ cors: true })

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/chat/completions', headers: JSON_HEADERS, payload: '{not valid json}'
    })
    assert.equal(res.statusCode, 400)
    assertError(res, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/chat/completions', payload: { messages: [{ role: 'user', content: 'hi' }] }
    })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_model')
  })

  it('missing messages returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/chat/completions', payload: { model: 'test' }
    })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_messages')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/chat/completions', payload: { model: 'nonexistent', messages: [{ role: 'user', content: 'hi' }] }
    })
    assert.equal(res.statusCode, 404)
    assertError(res, 'model_not_found')
  })
})
