import test from 'brittle'
import http from 'bare-http1'
import type { Readable } from 'bare-stream'
import { safeFetch } from '@/handlers/load-model/safe-fetch'
import { InsecureModelSourceError } from '@/errors/index'

const SHA256 = 'fa0390e7c043f89ae1847bd6682d748041a99d4ef3de0e0b27d33b6af97a8be8'
const anyHost = () => true

async function rejects(
  t: { ok: (v: unknown, msg?: string) => void; fail: (msg?: string) => void },
  fn: () => Promise<unknown>,
  ErrClass: new (...args: never[]) => Error
) {
  try {
    await fn()
    t.fail(`expected ${ErrClass.name}`)
  } catch (err) {
    t.ok(err instanceof ErrClass, `threw ${ErrClass.name}`)
  }
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

async function startServer(handler: Handler) {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()!
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function collectBody(body: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    body.on('data', (chunk) => {
      out += (chunk as Buffer).toString()
    })
    body.on('end', () => resolve(out))
    body.on('error', reject)
  })
}

function router(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? '/'
  if (url === '/resolve') {
    res.writeHead(302, { location: '/cdn', 'x-linked-etag': `"${SHA256}"` })
    res.end()
    return
  }
  if (url === '/cdn') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end('MODEL-BYTES')
    return
  }
  if (url === '/downgrade') {
    res.writeHead(302, { location: 'http://example.com/evil' })
    res.end()
    return
  }
  if (url === '/badetag') {
    res.writeHead(200, { etag: '"abc123-2"' })
    res.end('X')
    return
  }
  if (url === '/loop') {
    res.writeHead(302, { location: '/loop' })
    res.end()
    return
  }
  res.writeHead(200, {})
  res.end('DIRECT')
}

test('safeFetch: walks a redirect and captures the Hub SHA-256 from the resolve hop', async (t) => {
  const server = await startServer(router)
  t.teardown(() => server.close())

  const res = await safeFetch(`${server.base}/resolve`, { captureHashFromHost: anyHost })
  t.is(res.status, 200)
  t.ok(res.redirected)
  t.ok(res.finalUrl.endsWith('/cdn'))
  t.is(res.hubSha256, SHA256)
  t.is(await collectBody(res.body), 'MODEL-BYTES')
})

test('safeFetch: does not capture a hash from a non-trusted host by default', async (t) => {
  const server = await startServer(router)
  t.teardown(() => server.close())

  // Default captureHashFromHost is Hugging Face; 127.0.0.1 is not, so no capture.
  const res = await safeFetch(`${server.base}/resolve`)
  t.is(res.hubSha256, undefined)
  t.is(await collectBody(res.body), 'MODEL-BYTES')
})

test('safeFetch: with enforcement, rejects a downgrade redirect to plaintext non-loopback', async (t) => {
  const server = await startServer(router)
  t.teardown(() => server.close())

  await rejects(
    t,
    () => safeFetch(`${server.base}/downgrade`, { enforceSecureTransport: true }),
    InsecureModelSourceError
  )
})

test('safeFetch: with enforcement, rejects a plaintext non-loopback URL up front', async (t) => {
  await rejects(
    t,
    () => safeFetch('http://198.51.100.9/model.gguf', { enforceSecureTransport: true }),
    InsecureModelSourceError
  )
})

test('safeFetch: without enforcement (default), a plaintext non-loopback URL is not refused', async (t) => {
  // Default is permissive: bring-your-own HTTP on any domain is allowed. Point
  // at a non-routable address (RFC 5737 TEST-NET) so the attempt fails with a
  // network/timeout error rather than InsecureModelSourceError.
  try {
    await safeFetch('http://192.0.2.1/model.gguf', { timeoutMs: 500 })
    t.pass('request was attempted (not refused on transport grounds)')
  } catch (err) {
    t.absent(err instanceof InsecureModelSourceError, 'did not refuse on transport grounds')
  }
})

test('safeFetch: ignores a non-SHA-256 etag', async (t) => {
  const server = await startServer(router)
  t.teardown(() => server.close())

  const res = await safeFetch(`${server.base}/badetag`, { captureHashFromHost: anyHost })
  t.is(res.hubSha256, undefined)
  await collectBody(res.body)
})

test('safeFetch: rejects a redirect loop past the maximum hop count', async (t) => {
  const server = await startServer(router)
  t.teardown(() => server.close())

  await rejects(t, () => safeFetch(`${server.base}/loop`), InsecureModelSourceError)
})

test('safeFetch: HEAD captures the hash from the redirect hop', async (t) => {
  const server = await startServer(router)
  t.teardown(() => server.close())

  const res = await safeFetch(`${server.base}/resolve`, {
    method: 'HEAD',
    captureHashFromHost: anyHost
  })
  t.is(res.status, 200)
  t.is(res.hubSha256, SHA256)
  res.body.resume()
})
