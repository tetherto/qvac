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

describe('serve: Host header check', () => {
  const server = useServer({})

  it('rejects a foreign Host, including on /openapi.json', async () => {
    for (const url of ['/openapi.json', '/v1/models', '/qvac/v1/kv_cache']) {
      const res = await server().inject({
        method: 'GET',
        url,
        headers: { host: 'attacker.example:11434' }
      })
      assertStatusAndError(res, 403, 'host_not_allowed')
    }
  })

  it('rejects a foreign Host before a state-changing route runs', async () => {
    const res = await server().inject({
      method: 'DELETE',
      url: '/qvac/v1/kv_cache',
      headers: { host: 'attacker.example' }
    })
    assertStatusAndError(res, 403, 'host_not_allowed')
  })

  it('serves loopback and IP Hosts with or without the port', async () => {
    for (const host of [
      'localhost',
      'localhost:11434',
      '127.0.0.1:11434',
      '[::1]',
      '10.0.0.5:11434'
    ]) {
      const res = await server().inject({ method: 'GET', url: '/openapi.json', headers: { host } })
      assert.equal(res.statusCode, 200, host)
    }
  })
})

describe('serve: Host header check with allowed hosts', () => {
  const server = useServer({ allowedHosts: ['qvac.internal'] })

  it('serves a listed host and still rejects others', async () => {
    const ok = await server().inject({
      method: 'GET',
      url: '/openapi.json',
      headers: { host: 'qvac.internal:11434' }
    })
    assert.equal(ok.statusCode, 200)
    const blocked = await server().inject({
      method: 'GET',
      url: '/openapi.json',
      headers: { host: 'attacker.example' }
    })
    assertStatusAndError(blocked, 403, 'host_not_allowed')
  })
})

describe('serve: Host header check opted out', () => {
  const server = useServer({ allowAnyHost: true })

  it('serves any Host', async () => {
    const res = await server().inject({
      method: 'GET',
      url: '/openapi.json',
      headers: { host: 'attacker.example' }
    })
    assert.equal(res.statusCode, 200)
  })
})
