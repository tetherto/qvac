import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'

const TEST_PORT = 19876
const BASE = `http://127.0.0.1:${TEST_PORT}`

let server: http.Server

async function startTestServer (opts: { apiKey?: string; cors?: boolean } = {}): Promise<http.Server> {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'qvac-serve-test-'))
  const { startServer } = await import('../src/serve/index.js')
  return startServer({
    projectRoot,
    port: TEST_PORT,
    host: '127.0.0.1',
    apiKey: opts.apiKey,
    cors: opts.cors,
    verbose: false
  })
}

async function req (
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: payload
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: parsed
  }
}

function assertErrorEnvelope (body: unknown, code: string): void {
  assert.ok(typeof body === 'object' && body !== null)
  const err = (body as Record<string, unknown>)['error']
  assert.ok(typeof err === 'object' && err !== null)
  assert.equal((err as Record<string, unknown>)['code'], code)
  assert.ok(typeof (err as Record<string, unknown>)['message'] === 'string')
}

describe('serve e2e (no models)', () => {
  before(async () => {
    server = await startTestServer({ cors: true })
  })

  after(async () => {
    server.close()
  })

  // -- Models endpoint --

  it('GET /v1/models returns empty list', async () => {
    const res = await req('GET', '/v1/models')
    assert.equal(res.status, 200)
    const data = res.body as Record<string, unknown>
    assert.equal(data['object'], 'list')
    assert.ok(Array.isArray(data['data']))
    assert.equal((data['data'] as unknown[]).length, 0)
  })

  it('GET /v1/models/:id returns 404 for unknown model', async () => {
    const res = await req('GET', '/v1/models/nonexistent')
    assert.equal(res.status, 404)
    assertErrorEnvelope(res.body, 'model_not_found')
  })

  it('DELETE /v1/models/:id returns 404 for unknown model', async () => {
    const res = await req('DELETE', '/v1/models/nonexistent')
    assert.equal(res.status, 404)
    assertErrorEnvelope(res.body, 'model_not_found')
  })

  // -- Chat completions --

  it('POST /v1/chat/completions with invalid JSON returns 400', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json}'
    })
    assert.equal(res.status, 400)
    const body = await res.json() as Record<string, unknown>
    assertErrorEnvelope(body, 'invalid_json')
  })

  it('POST /v1/chat/completions without model returns 400', async () => {
    const res = await req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(res.status, 400)
    assertErrorEnvelope(res.body, 'missing_model')
  })

  it('POST /v1/chat/completions without messages returns 400', async () => {
    const res = await req('POST', '/v1/chat/completions', { model: 'test' })
    assert.equal(res.status, 400)
    assertErrorEnvelope(res.body, 'missing_messages')
  })

  it('POST /v1/chat/completions with unknown model returns 404', async () => {
    const res = await req('POST', '/v1/chat/completions', {
      model: 'nonexistent',
      messages: [{ role: 'user', content: 'hi' }]
    })
    assert.equal(res.status, 404)
    assertErrorEnvelope(res.body, 'model_not_found')
  })

  // -- Embeddings --

  it('POST /v1/embeddings with invalid JSON returns 400', async () => {
    const res = await fetch(`${BASE}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{{bad'
    })
    assert.equal(res.status, 400)
    const body = await res.json() as Record<string, unknown>
    assertErrorEnvelope(body, 'invalid_json')
  })

  it('POST /v1/embeddings without model returns 400', async () => {
    const res = await req('POST', '/v1/embeddings', { input: 'hello' })
    assert.equal(res.status, 400)
    assertErrorEnvelope(res.body, 'missing_model')
  })

  it('POST /v1/embeddings without input returns 400', async () => {
    const res = await req('POST', '/v1/embeddings', { model: 'test' })
    assert.equal(res.status, 400)
    assertErrorEnvelope(res.body, 'missing_input')
  })

  it('POST /v1/embeddings with unknown model returns 404', async () => {
    const res = await req('POST', '/v1/embeddings', { model: 'nonexistent', input: 'hello' })
    assert.equal(res.status, 404)
    assertErrorEnvelope(res.body, 'model_not_found')
  })

  // -- Routing --

  it('GET /unknown returns 404', async () => {
    const res = await req('GET', '/unknown')
    assert.equal(res.status, 404)
    assertErrorEnvelope(res.body, 'not_found')
  })

  it('GET /v1/unknown returns 404 from adapter', async () => {
    const res = await req('GET', '/v1/unknown')
    assert.equal(res.status, 404)
    assertErrorEnvelope(res.body, 'not_found')
  })

  // -- CORS --

  it('OPTIONS /v1/models returns 204 with CORS headers', async () => {
    const res = await fetch(`${BASE}/v1/models`, { method: 'OPTIONS' })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.ok(res.headers.get('access-control-allow-methods')?.includes('POST'))
  })

  it('CORS headers present on regular requests', async () => {
    const res = await req('GET', '/v1/models')
    assert.equal(res.headers['access-control-allow-origin'], '*')
  })
})

describe('serve e2e (auth)', () => {
  let authServer: http.Server
  const API_KEY = 'test-secret-key-12345'
  const AUTH_PORT = 19877
  const AUTH_BASE = `http://127.0.0.1:${AUTH_PORT}`

  before(async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'qvac-serve-auth-test-'))
    const { startServer } = await import('../src/serve/index.js')
    authServer = await startServer({
      projectRoot,
      port: AUTH_PORT,
      host: '127.0.0.1',
      apiKey: API_KEY,
      verbose: false
    })
  })

  after(async () => {
    authServer.close()
  })

  it('rejects requests without API key', async () => {
    const res = await fetch(`${AUTH_BASE}/v1/models`)
    assert.equal(res.status, 401)
    const body = await res.json() as Record<string, unknown>
    assertErrorEnvelope(body, 'invalid_api_key')
  })

  it('rejects requests with wrong API key', async () => {
    const res = await fetch(`${AUTH_BASE}/v1/models`, {
      headers: { Authorization: 'Bearer wrong-key' }
    })
    assert.equal(res.status, 401)
    const body = await res.json() as Record<string, unknown>
    assertErrorEnvelope(body, 'invalid_api_key')
  })

  it('accepts requests with correct API key', async () => {
    const res = await fetch(`${AUTH_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` }
    })
    assert.equal(res.status, 200)
  })
})

describe('serve e2e (no CORS)', () => {
  let noCorsServer: http.Server
  const NO_CORS_PORT = 19878
  const NO_CORS_BASE = `http://127.0.0.1:${NO_CORS_PORT}`

  before(async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'qvac-serve-nocors-test-'))
    const { startServer } = await import('../src/serve/index.js')
    noCorsServer = await startServer({
      projectRoot,
      port: NO_CORS_PORT,
      host: '127.0.0.1',
      verbose: false
    })
  })

  after(async () => {
    noCorsServer.close()
  })

  it('OPTIONS returns 204 even without CORS enabled', async () => {
    const res = await fetch(`${NO_CORS_BASE}/v1/models`, { method: 'OPTIONS' })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })

  it('regular requests have no CORS headers', async () => {
    const res = await fetch(`${NO_CORS_BASE}/v1/models`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })
})
