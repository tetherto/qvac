import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createHostLogger, type HostLogger } from '../src/host-logger.ts'
import { startManagedServeHost, type ManagedServeHandle } from '../src/host-runtime.ts'
import type { ManagedServeHostConfig } from '../src/managed-serve-config.ts'
import type { HostListening } from '../src/managed-serve-handshake.ts'

const SERVE_KEY = 's'.repeat(43)
const ROTATED_SERVE_KEY = 'r'.repeat(43)

interface ServeStub {
  readonly baseURL: string
  readonly port: number
  readonly authorizations: string[]
  readonly received: IncomingHttpHeaders[]
  close: () => Promise<void>
}

function quietLogger(): HostLogger {
  return { log: () => {}, trace: () => {}, error: () => {} }
}

function hostConfig(overrides: Partial<ManagedServeHostConfig> = {}): ManagedServeHostConfig {
  return {
    modelId: 'qwen3.5-0.8b',
    modelName: 'Qwen 3.5 0.8B',
    ctxSize: 4096,
    reasoningBudget: 0,
    tools: true,
    openAICompatTransforms: true,
    readyTimeoutMs: 30_000,
    upstreamTimeoutMs: 5_000,
    debug: false,
    logFile: undefined,
    ...overrides
  }
}

function startServeStub(): Promise<ServeStub> {
  const authorizations: string[] = []
  const received: IncomingHttpHeaders[] = []
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    authorizations.push(req.headers.authorization ?? '')
    received.push(req.headers)
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [] }))
  }
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      assert.ok(typeof addr === 'object' && addr !== null)
      resolve({
        baseURL: `http://127.0.0.1:${addr.port}/v1`,
        port: addr.port,
        authorizations,
        received,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getModels(
  baseURL: string,
  token: string | null
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {}
  if (token !== null) headers['authorization'] = `Bearer ${token}`
  const res = await fetch(`${baseURL}/models`, { headers })
  return { status: res.status, body: await res.text() }
}

test('host emits the listening handshake before managed serve resolves', async () => {
  const upstream = await startServeStub()
  let releaseManaged!: (handle: ManagedServeHandle) => void
  const managed = new Promise<ManagedServeHandle>((resolve) => {
    releaseManaged = resolve
  })
  const handshakes: HostListening[] = []

  const host = await startManagedServeHost({
    config: hostConfig(),
    logger: quietLogger(),
    emitHandshake: (payload) => handshakes.push(payload),
    startManagedServe: () => managed
  })
  try {
    assert.equal(handshakes.length, 1)
    const listening = handshakes[0]
    assert.ok(listening)
    assert.match(listening.proxyToken, /^[A-Za-z0-9_-]{43}$/)
    assert.match(listening.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    assert.equal(listening.modelId, 'qwen3.5-0.8b')
    assert.equal(listening.modelName, 'Qwen 3.5 0.8B')

    // An authenticated request that arrives before readiness queues instead of
    // failing, so a cold model download stays first-request work.
    const pending = getModels(listening.baseURL, listening.proxyToken)
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await delay(200)
    assert.equal(settled, false)
    assert.deepEqual(upstream.authorizations, [])

    releaseManaged({
      apiKey: SERVE_KEY,
      baseURL: upstream.baseURL,
      port: upstream.port,
      pid: process.pid,
      close: () => Promise.resolve()
    })

    const res = await pending
    assert.equal(res.status, 200)
    assert.deepEqual(upstream.authorizations, [`Bearer ${SERVE_KEY}`])
  } finally {
    await host.stop('test')
    await upstream.close()
  }
})

test(
  'host authenticates inbound requests before waiting for managed readiness',
  { timeout: 10_000 },
  async () => {
    const handshakes: HostListening[] = []
    const host = await startManagedServeHost({
      config: hostConfig(),
      logger: quietLogger(),
      emitHandshake: (payload) => handshakes.push(payload),
      // Managed serve never becomes ready: a 401 must not depend on it.
      startManagedServe: () => new Promise<ManagedServeHandle>(() => {})
    })
    const listening = handshakes[0]
    assert.ok(listening)
    try {
      const anonymous = await getModels(listening.baseURL, null)
      assert.equal(anonymous.status, 401)
      assert.match(anonymous.body, /invalid_api_key/)

      const wrong = await getModels(listening.baseURL, SERVE_KEY)
      assert.equal(wrong.status, 401)
    } finally {
      await host.stop('test')
    }
  }
)

test('host reads the managed serve key live on every upstream request', async () => {
  const upstream = await startServeStub()
  let liveKey = SERVE_KEY
  const handle: ManagedServeHandle = {
    get apiKey() {
      return liveKey
    },
    baseURL: upstream.baseURL,
    port: upstream.port,
    pid: process.pid,
    close: () => Promise.resolve()
  }
  const handshakes: HostListening[] = []
  const host = await startManagedServeHost({
    config: hostConfig(),
    logger: quietLogger(),
    emitHandshake: (payload) => handshakes.push(payload),
    startManagedServe: () => Promise.resolve(handle)
  })
  const listening = handshakes[0]
  assert.ok(listening)
  try {
    assert.equal((await getModels(listening.baseURL, listening.proxyToken)).status, 200)
    // A replacement serve rotates the key; the next request must use it with no
    // polling window in between.
    liveKey = ROTATED_SERVE_KEY
    assert.equal((await getModels(listening.baseURL, listening.proxyToken)).status, 200)

    assert.deepEqual(upstream.authorizations, [
      `Bearer ${SERVE_KEY}`,
      `Bearer ${ROTATED_SERVE_KEY}`
    ])
    assert.doesNotMatch(JSON.stringify(listening), new RegExp(SERVE_KEY))
  } finally {
    await host.stop('test')
    await upstream.close()
  }
})

test('host fails startup when the managed provider exposes no apiKey', async () => {
  const upstream = await startServeStub()
  let closed = 0
  const handshakes: HostListening[] = []
  const host = await startManagedServeHost({
    config: hostConfig(),
    logger: quietLogger(),
    emitHandshake: (payload) => handshakes.push(payload),
    // A published @qvac/ai-sdk-provider older than the one that added
    // `ManagedQvacProvider.apiKey` resolves a handle without the getter.
    startManagedServe: () =>
      Promise.resolve({
        baseURL: upstream.baseURL,
        port: upstream.port,
        pid: process.pid,
        close: () => {
          closed += 1
          return Promise.resolve()
        }
      } as unknown as ManagedServeHandle)
  })
  try {
    await assert.rejects(host.whenManaged, (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.name, 'IncompatibleProviderError')
      assert.match(err.message, /@qvac\/ai-sdk-provider/)
      assert.match(err.message, /upgrade/i)
      return true
    })
    assert.equal(closed, 1, 'the incompatible managed serve must be released')

    // The proxy never borrows a credential it does not have, and a caller that
    // already has the handshake learns why instead of waiting on a serve that
    // is never coming.
    const listening = handshakes[0]
    assert.ok(listening)
    const res = await getModels(listening.baseURL, listening.proxyToken)
    assert.equal(res.status, 503)
    assert.match(res.body, /@qvac\/ai-sdk-provider/)
    assert.doesNotMatch(res.body, new RegExp(SERVE_KEY))
    assert.deepEqual(upstream.authorizations, [])
  } finally {
    await host.stop('test')
    await upstream.close()
  }
})

test('host fails startup when the managed provider apiKey is not usable', async () => {
  const upstream = await startServeStub()
  const host = await startManagedServeHost({
    config: hostConfig(),
    logger: quietLogger(),
    emitHandshake: () => {},
    startManagedServe: () =>
      Promise.resolve({
        apiKey: '   ',
        baseURL: upstream.baseURL,
        port: upstream.port,
        pid: process.pid,
        close: () => Promise.resolve()
      })
  })
  try {
    await assert.rejects(host.whenManaged, { name: 'IncompatibleProviderError' })
  } finally {
    await host.stop('test')
    await upstream.close()
  }
})

test('host startup failure for an incompatible provider never logs the serve key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-host-incompat-'))
  const logFile = join(dir, 'host.log')
  const out: string[] = []
  const err: string[] = []
  const upstream = await startServeStub()
  const host = await startManagedServeHost({
    config: hostConfig({ debug: true, logFile }),
    logger: createHostLogger({
      debug: true,
      logFile,
      out: (text) => out.push(text),
      err: (text) => err.push(text)
    }),
    emitHandshake: () => {},
    startManagedServe: () =>
      Promise.resolve({
        apiKey: SERVE_KEY,
        baseURL: 'not a url',
        port: upstream.port,
        pid: process.pid,
        close: () => Promise.resolve()
      })
  })
  try {
    await assert.rejects(host.whenManaged, { name: 'IncompatibleProviderError' })
    const sink = out.join('') + err.join('') + (await readFile(logFile, 'utf8'))
    assert.doesNotMatch(sink, new RegExp(SERVE_KEY))
  } finally {
    await host.stop('test')
    await upstream.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('host debug and log output never contain the proxy token or the serve key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-host-log-'))
  const logFile = join(dir, 'host.log')
  const out: string[] = []
  const err: string[] = []
  const upstream = await startServeStub()
  const handshakes: HostListening[] = []
  const host = await startManagedServeHost({
    config: hostConfig({ debug: true, logFile }),
    logger: createHostLogger({
      debug: true,
      logFile,
      out: (text) => out.push(text),
      err: (text) => err.push(text)
    }),
    emitHandshake: (payload) => handshakes.push(payload),
    startManagedServe: () =>
      Promise.resolve({
        apiKey: SERVE_KEY,
        baseURL: upstream.baseURL,
        port: upstream.port,
        pid: process.pid,
        close: () => Promise.resolve()
      })
  })
  const listening = handshakes[0]
  assert.ok(listening)
  try {
    await getModels(listening.baseURL, listening.proxyToken)
    await getModels(listening.baseURL, null)
    await host.whenManaged

    const streams = out.join('') + err.join('')
    const file = await readFile(logFile, 'utf8')
    for (const sink of [streams, file]) {
      assert.ok(sink.length > 0)
      assert.doesNotMatch(sink, new RegExp(listening.proxyToken))
      assert.doesNotMatch(sink, new RegExp(SERVE_KEY))
    }
  } finally {
    await host.stop('test')
    await upstream.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('host refuses a managed serve reported on a non-loopback host', async () => {
  const upstream = await startServeStub()
  let closed = 0
  const handshakes: HostListening[] = []
  const host = await startManagedServeHost({
    config: hostConfig(),
    logger: quietLogger(),
    emitHandshake: (payload) => handshakes.push(payload),
    // The proxy swaps in the serve key on every hop, so a provider that reports
    // an off-host serve would exfiltrate that credential.
    startManagedServe: () =>
      Promise.resolve({
        apiKey: SERVE_KEY,
        baseURL: 'http://203.0.113.7:8080/v1',
        port: 8080,
        pid: process.pid,
        close: () => {
          closed += 1
          return Promise.resolve()
        }
      })
  })
  try {
    await assert.rejects(host.whenManaged, (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.name, 'UntrustedUpstreamError')
      assert.match(err.message, /203\.0\.113\.7/)
      return true
    })
    assert.equal(closed, 1, 'the untrusted managed serve must be released')

    const listening = handshakes[0]
    assert.ok(listening)
    const res = await getModels(listening.baseURL, listening.proxyToken)
    assert.equal(res.status, 503)
    assert.doesNotMatch(res.body, new RegExp(SERVE_KEY))
    assert.deepEqual(upstream.authorizations, [])
  } finally {
    await host.stop('test')
    await upstream.close()
  }
})

test('stopping the host releases requests queued on managed startup', async () => {
  const upstream = await startServeStub()
  const handshakes: HostListening[] = []
  const host = await startManagedServeHost({
    config: hostConfig(),
    logger: quietLogger(),
    emitHandshake: (payload) => handshakes.push(payload),
    // A serve that never becomes healthy: without a release on shutdown the
    // queued request would hang until the host process died.
    startManagedServe: () => new Promise<never>(() => {})
  })
  const listening = handshakes[0]
  assert.ok(listening)
  try {
    const pending = getModels(listening.baseURL, listening.proxyToken)
    await delay(100)
    await host.stop('test')

    const res = await pending
    assert.equal(res.status, 503)
    assert.match(res.body, /shutting down/)
    assert.deepEqual(upstream.authorizations, [])
  } finally {
    await upstream.close()
  }
})

test('hop-by-hop headers are not relayed to serve', async () => {
  const upstream = await startServeStub()
  const handshakes: HostListening[] = []
  const host = await startManagedServeHost({
    config: hostConfig(),
    logger: quietLogger(),
    emitHandshake: (payload) => handshakes.push(payload),
    startManagedServe: () =>
      Promise.resolve({
        apiKey: SERVE_KEY,
        baseURL: upstream.baseURL,
        port: upstream.port,
        pid: process.pid,
        close: () => Promise.resolve()
      })
  })
  const listening = handshakes[0]
  assert.ok(listening)
  try {
    await host.whenManaged
    const target = new URL(`${listening.baseURL}/chat/completions`)
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: {
            authorization: `Bearer ${listening.proxyToken}`,
            'content-type': 'application/json',
            // Node decodes this hop before we ever see the body; relaying it
            // would hand serve two disagreeing framings of one request.
            'transfer-encoding': 'chunked',
            connection: 'keep-alive',
            te: 'trailers',
            upgrade: 'h2c',
            'proxy-connection': 'keep-alive',
            'proxy-authorization': 'Basic c2hvdWxkLW5vdC1yZWxheQ=='
          }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ model: 'qwen3.5-0.8b', messages: [] }))
    })
    assert.equal(status, 200)

    const forwarded = upstream.received[0]
    assert.ok(forwarded)
    // `connection` is excluded: Node regenerates one for its own hop, so its
    // presence upstream says nothing about what we relayed.
    for (const header of [
      'transfer-encoding',
      'te',
      'upgrade',
      'proxy-connection',
      'proxy-authorization'
    ]) {
      assert.equal(forwarded[header], undefined, `${header} must not be relayed`)
    }
    assert.ok(forwarded['content-length'], 'the forwarded body must state its length')
  } finally {
    await host.stop('test')
    await upstream.close()
  }
})
