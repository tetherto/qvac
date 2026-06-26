import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { assertStatusAndError } from '../helpers/http.js'

describe('serve: routing', () => {
  const server = useServer({ cors: true })

  it('GET /unknown returns 404', async () => {
    const res = await server().inject({ method: 'GET', url: '/unknown' })
    assertStatusAndError(res, 404, 'not_found')
  })

  it('GET /v1/unknown returns 404', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/unknown' })
    assertStatusAndError(res, 404, 'not_found')
  })
})

describe('serve: CORS enabled', () => {
  const server = useServer({ cors: true })

  it('OPTIONS /v1/models returns 204 with CORS headers', async () => {
    const res = await server().inject({ method: 'OPTIONS', url: '/v1/models' })
    assert.equal(res.statusCode, 204)
    assert.ok(res.headers['access-control-allow-origin'], 'expected access-control-allow-origin')
    assert.match(String(res.headers['access-control-allow-methods']), /POST/)
  })

  it('CORS headers present on regular GET', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/models' })
    assert.ok(res.headers['access-control-allow-origin'], 'expected access-control-allow-origin')
  })
})

describe('serve: CORS disabled', () => {
  const server = useServer({})

  it('OPTIONS returns 204 without CORS headers', async () => {
    const res = await server().inject({ method: 'OPTIONS', url: '/v1/models' })
    assert.equal(res.statusCode, 204)
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  })

  it('regular GET has no CORS headers', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/models' })
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  })
})

describe('serve: auth', () => {
  const server = useServer({ apiKey: 'test-secret-key-12345' })

  it('no key returns 401', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/models' })
    assertStatusAndError(res, 401, 'invalid_api_key')
  })

  it('wrong key returns 401', async () => {
    const res = await server().inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer wrong-key' }
    })
    assertStatusAndError(res, 401, 'invalid_api_key')
  })

  it('correct key returns 200', async () => {
    const res = await server().inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer test-secret-key-12345' }
    })
    assert.equal(res.statusCode, 200)
  })
})
