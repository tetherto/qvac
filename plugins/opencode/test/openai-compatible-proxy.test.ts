import assert from 'node:assert/strict'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { test } from 'node:test'

import type { HostLogger } from '../src/host-logger.ts'
import {
  startOpenAICompatibleProxy,
  type ProxyOptions,
  type Upstream
} from '../src/openai-compatible-proxy.ts'

const logger: HostLogger = {
  log: () => {},
  trace: () => {},
  error: () => {}
}

// Distinct secrets so a test can tell which credential reached which hop.
const PROXY_TOKEN = 'p'.repeat(43)
const SERVE_KEY = 's'.repeat(43)

interface StartedServer {
  readonly port: number
  close: () => Promise<void>
}

interface TestResponse {
  readonly statusCode: number
  readonly body: string
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<StartedServer> {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      assert.ok(typeof addr === 'object' && addr !== null)
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err === undefined) res()
              else rej(err)
            })
          })
      })
    })
  })
}

// Every proxy in these tests is authenticated: `proxyToken` guards the inbound
// hop and `getApiKey` supplies the upstream credential.
function startProxy(
  overrides: Partial<ProxyOptions>
): ReturnType<typeof startOpenAICompatibleProxy> {
  return startOpenAICompatibleProxy({
    proxyToken: PROXY_TOKEN,
    getUpstream: () => undefined,
    getApiKey: () => SERVE_KEY,
    whenUpstream: Promise.resolve(),
    openAICompatTransforms: true,
    upstreamTimeoutMs: 1000,
    logger,
    ...overrides
  })
}

// `authorization: null` omits the header entirely; anything else is sent as-is.
function postJson(
  port: number,
  path: string,
  body: unknown,
  authorization: string | null = `Bearer ${PROXY_TOKEN}`
): Promise<TestResponse> {
  const raw = JSON.stringify(body)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw))
  }
  if (authorization !== null) headers['authorization'] = authorization
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.write(raw)
    req.end()
  })
}

// Announces a large body but sends only its first chunk, then resolves on the
// response. A proxy that buffers the body before authenticating can never
// answer this request, because the request never ends.
function postUnfinishedBody(
  port: number,
  path: string,
  authorization: string
): Promise<TestResponse> {
  const chunk = 'x'.repeat(1024)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(chunk.length * 1024),
          authorization
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          req.destroy()
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        })
        res.on('error', reject)
      }
    )
    // Abandoning a half-sent request raises here; the response is what matters.
    req.on('error', () => {})
    req.write(chunk)
  })
}

function postRaw(port: number, path: string, body: string): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          authorization: `Bearer ${PROXY_TOKEN}`
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

test('proxy rejects a request with no authorization before touching the upstream', async () => {
  let upstreamHits = 0
  const upstreamServer = await startServer((_req, res) => {
    upstreamHits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) })
  })
  try {
    const res = await postJson(proxy.port, '/v1/models', {}, null)
    assert.equal(res.statusCode, 401)
    assert.deepEqual(JSON.parse(res.body), {
      error: {
        message: 'Invalid or missing API key.',
        type: 'invalid_request_error',
        code: 'invalid_api_key'
      }
    })
    assert.equal(upstreamHits, 0)
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy rejects a wrong proxy token without reaching the upstream', async () => {
  let upstreamHits = 0
  const upstreamServer = await startServer((_req, res) => {
    upstreamHits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) })
  })
  try {
    for (const authorization of [
      `Bearer ${SERVE_KEY}`,
      `Bearer ${PROXY_TOKEN}x`,
      `Bearer ${'p'.repeat(42)}`,
      PROXY_TOKEN,
      `bearer ${PROXY_TOKEN}`,
      `Basic ${PROXY_TOKEN}`
    ]) {
      const res = await postJson(
        proxy.port,
        '/v1/chat/completions',
        { messages: [] },
        authorization
      )
      assert.equal(res.statusCode, 401, `expected 401 for ${authorization}`)
      assert.match(res.body, /invalid_api_key/)
    }
    assert.equal(upstreamHits, 0)
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test(
  'proxy rejects an unauthenticated request while the upstream is still starting',
  { timeout: 5_000 },
  async () => {
    // A never-resolving readiness promise: a 401 must not wait on managed startup.
    const proxy = await startProxy({ whenUpstream: new Promise<void>(() => {}) })
    try {
      const res = await postJson(proxy.port, '/v1/models', {}, 'Bearer nope')
      assert.equal(res.statusCode, 401)
    } finally {
      await proxy.close()
    }
  }
)

// The rejection has to happen in the connection handler, not after the body is
// assembled: an unauthenticated caller must not be able to make the host buffer
// a body-sized allocation for a request it has already refused.
test(
  'proxy rejects an unauthorized request before reading its body',
  { timeout: 5_000 },
  async () => {
    let upstreamHits = 0
    const upstreamServer = await startServer((_req, res) => {
      upstreamHits += 1
      res.writeHead(200)
      res.end()
    })
    const proxy = await startProxy({
      getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) })
    })
    try {
      const res = await postUnfinishedBody(proxy.port, '/v1/chat/completions', 'Bearer nope')
      assert.equal(res.statusCode, 401)
      assert.match(res.body, /invalid_api_key/)
      assert.equal(upstreamHits, 0)
    } finally {
      await proxy.close()
      await upstreamServer.close()
    }
  }
)

test('proxy swaps the caller token for the live managed serve key upstream', async () => {
  let forwardedAuthorization: string | undefined
  const upstreamServer = await startServer((req, res) => {
    forwardedAuthorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  let serveKey = SERVE_KEY
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) }),
    getApiKey: () => serveKey
  })
  try {
    const res = await postJson(proxy.port, '/v1/models', {})
    assert.equal(res.statusCode, 200)
    assert.equal(forwardedAuthorization, `Bearer ${SERVE_KEY}`)

    // A recovery-time key rotation is picked up on the next request, not cached.
    serveKey = 'r'.repeat(43)
    await postJson(proxy.port, '/v1/models', {})
    assert.equal(forwardedAuthorization, `Bearer ${'r'.repeat(43)}`)
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy fails closed when no managed serve key is available', async () => {
  let upstreamHits = 0
  const upstreamServer = await startServer((_req, res) => {
    upstreamHits += 1
    res.writeHead(200)
    res.end()
  })
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) }),
    getApiKey: () => undefined
  })
  try {
    const res = await postJson(proxy.port, '/v1/models', {})
    assert.equal(res.statusCode, 503)
    assert.equal(upstreamHits, 0)
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy flattens OpenCode array message content before forwarding', async () => {
  let forwarded: unknown
  const upstreamServer = await startServer((req, res) => {
    void readBody(req).then((body) => {
      forwarded = JSON.parse(body.toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  let upstream: Upstream | undefined = { hostname: '127.0.0.1', port: String(upstreamServer.port) }
  const proxy = await startProxy({ getUpstream: () => upstream })
  try {
    const res = await postJson(proxy.port, '/v1/chat/completions', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(forwarded, { messages: [{ role: 'user', content: 'hi' }] })
  } finally {
    upstream = undefined
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy passes through non-SSE upstream responses', async () => {
  const upstreamServer = await startServer((_req, res) => {
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ value: '<think>not streamed</think>' }))
  })
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) })
  })
  try {
    const res = await postJson(proxy.port, '/v1/models', {})
    assert.equal(res.statusCode, 202)
    assert.equal(res.body, JSON.stringify({ value: '<think>not streamed</think>' }))
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy passes SSE through unchanged when compatibility transforms are disabled', async () => {
  const payload =
    'data: {"choices":[{"delta":{"content":"<think>why</think>answer"}}]}\n\ndata: [DONE]\n\n'
  const upstreamServer = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(payload)
  })
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) }),
    openAICompatTransforms: false
  })
  try {
    const res = await postJson(proxy.port, '/v1/chat/completions', { messages: [] })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, payload)
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy splits reasoning from SSE content when compatibility transforms are enabled', async () => {
  const upstreamServer = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      'data: {"choices":[{"delta":{"content":"<think>why</think>answer"}}]}\n\ndata: [DONE]\n\n'
    )
  })
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) })
  })
  try {
    const res = await postJson(proxy.port, '/v1/chat/completions', { messages: [] })
    assert.equal(res.statusCode, 200)
    assert.match(res.body, /"reasoning_content":"why"/)
    assert.match(res.body, /"content":"answer"/)
    assert.doesNotMatch(res.body, /<think>/)
    assert.match(res.body, /data: \[DONE\]/)
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy handles think tags split across SSE chunks end to end', async () => {
  const upstreamServer = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"before <thi"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"nk>secret</think>after"}}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) })
  })
  try {
    const res = await postJson(proxy.port, '/v1/chat/completions', { messages: [] })
    assert.equal(res.statusCode, 200)
    assert.match(res.body, /"content":"before "/)
    assert.match(res.body, /"reasoning_content":"secret"/)
    assert.match(res.body, /"content":"after"/)
    assert.match(res.body, /data: \[DONE\]/)
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy returns 503 when the upstream is not available after startup', async () => {
  const proxy = await startProxy({ getUpstream: () => undefined })
  try {
    const res = await postJson(proxy.port, '/v1/models', {})
    assert.equal(res.statusCode, 503)
  } finally {
    await proxy.close()
  }
})

test('proxy returns 502 when the upstream connection fails', async () => {
  const upstreamServer = await startServer((_req, res) => {
    res.writeHead(200)
    res.end()
  })
  const port = upstreamServer.port
  await upstreamServer.close()
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(port) })
  })
  try {
    const res = await postJson(proxy.port, '/v1/models', {})
    assert.equal(res.statusCode, 502)
  } finally {
    await proxy.close()
  }
})

test('proxy times out wedged upstream requests', async () => {
  const upstreamServer = await startServer(() => {})
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) }),
    upstreamTimeoutMs: 20
  })
  try {
    const res = await postJson(proxy.port, '/v1/chat/completions', { messages: [] })
    assert.equal(res.statusCode, 504)
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy forwards malformed JSON bodies unchanged', async () => {
  let forwarded = ''
  const upstreamServer = await startServer((req, res) => {
    void readBody(req).then((body) => {
      forwarded = body.toString('utf8')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) })
  })
  try {
    const res = await postRaw(proxy.port, '/v1/chat/completions', '{ not-json')
    assert.equal(res.statusCode, 200)
    assert.equal(forwarded, '{ not-json')
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy serializes chat completion requests', async () => {
  let active = 0
  let maxActive = 0
  const upstreamServer = await startServer((req, res) => {
    void readBody(req).then(() => {
      active += 1
      maxActive = Math.max(maxActive, active)
      setTimeout(() => {
        active -= 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }, 25)
    })
  })
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) })
  })
  try {
    const [a, b] = await Promise.all([
      postJson(proxy.port, '/v1/chat/completions', { messages: [] }),
      postJson(proxy.port, '/v1/chat/completions', { messages: [] })
    ])
    assert.equal(a.statusCode, 200)
    assert.equal(b.statusCode, 200)
    assert.equal(maxActive, 1)
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})

test('proxy flushes final partial think-tag text before SSE done', async () => {
  const upstreamServer = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"hello <thi"}}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  const proxy = await startProxy({
    getUpstream: () => ({ hostname: '127.0.0.1', port: String(upstreamServer.port) })
  })
  try {
    const res = await postJson(proxy.port, '/v1/chat/completions', { messages: [] })
    assert.equal(res.statusCode, 200)
    assert.match(res.body, /"content":"hello "/)
    assert.match(res.body, /"content":"<thi"/)
    assert.match(res.body, /data: \[DONE\]/)
  } finally {
    await proxy.close()
    await upstreamServer.close()
  }
})
