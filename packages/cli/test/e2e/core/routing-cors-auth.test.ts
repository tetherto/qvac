import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { assertStatusAndError } from '../helpers/http.js'

describe('serve: routing', () => {
  const server = useServer({})

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
  const server = useServer({ cors: true, corsOrigins: ['https://trusted.example'] })

  it('allowlisted origin receives CORS headers', async () => {
    const res = await server().inject({
      method: 'OPTIONS',
      url: '/v1/models',
      headers: {
        origin: 'https://trusted.example',
        'access-control-request-method': 'GET'
      }
    })
    assert.equal(res.statusCode, 204)
    assert.equal(res.headers['access-control-allow-origin'], 'https://trusted.example')
    assert.match(String(res.headers['access-control-allow-methods']), /POST/)
  })

  it('arbitrary origin does not receive CORS headers', async () => {
    const res = await server().inject({
      method: 'GET',
      url: '/v1/models',
      headers: { origin: 'https://attacker.example' }
    })
    assert.equal(res.headers['access-control-allow-origin'], undefined)
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
