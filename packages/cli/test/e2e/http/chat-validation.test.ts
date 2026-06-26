import { describe, it } from 'node:test'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

describe('serve: chat completions validation', () => {
  const server = useServer({ cors: true })

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: JSON_HEADERS,
      payload: '{not valid json}'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hi' }] }
    })
    assertStatusAndError(res, 400, 'missing_model')
  })

  it('missing messages returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'test' }
    })
    assertStatusAndError(res, 400, 'missing_messages')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'nonexistent', messages: [{ role: 'user', content: 'hi' }] }
    })
    assertStatusAndError(res, 404, 'model_not_found')
  })
})
