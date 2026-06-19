import { describe, it } from 'node:test'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

describe('serve: embeddings validation', () => {
  const server = useServer({ cors: true })

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/embeddings', headers: JSON_HEADERS, payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/embeddings', payload: { input: 'hello' }
    })
    assertStatusAndError(res, 400, 'missing_model')
  })

  it('missing input returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/embeddings', payload: { model: 'test' }
    })
    assertStatusAndError(res, 400, 'missing_input')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/embeddings', payload: { model: 'nonexistent', input: 'hello' }
    })
    assertStatusAndError(res, 404, 'model_not_found')
  })
})
