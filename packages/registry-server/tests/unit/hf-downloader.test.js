'use strict'

const test = require('brittle')
const http = require('http')
const dns = require('dns')
const tls = require('tls')
const fs = require('fs').promises
const path = require('path')
const { createTempStorage } = require('../helpers/test-utils')
const { downloadHuggingFace } = require('../../lib/hf-downloader')

const payload = Buffer.concat([Buffer.alloc(16384, 'a'), Buffer.alloc(49152, 'b')])
const logger = { info() {}, warn() {} }

test('HF download resumes a dropped HTTP body without repeating the prefix', async (t) => {
  const requests = []
  const warnings = []
  const fixture = await createDownload(t, (req, res) => {
    requests.push({ range: req.headers.range, ifRange: req.headers['if-range'] })
    if (requests.length === 1) return dropBody(res)
    sendRemainder(res)
  })

  await downloadHuggingFace({
    ...fixture,
    logger: { info() {}, warn: (data) => warnings.push(data) }
  })

  t.alike(await fs.readFile(fixture.localPath), payload)
  t.alike(requests, [
    { range: undefined, ifRange: undefined },
    { range: 'bytes=16384-', ifRange: '"fixture-v1"' }
  ])
  t.is(warnings[0].code, 'UND_ERR_SOCKET')
  t.is(warnings[0].bytesDownloaded, 16384)
  t.is(warnings[0].expectedBytes, 65536)
  await t.exception(fs.stat(`${fixture.localPath}.incomplete`), /ENOENT/)
})

test('HF download replaces the partial file when a server ignores Range', async (t) => {
  let requests = 0
  const replacement = Buffer.alloc(65536, 'c')
  const fixture = await createDownload(t, (req, res) => {
    if (++requests === 1) return dropBody(res)
    res.writeHead(200, { 'Content-Length': replacement.length, ETag: '"fixture-v2"' })
    res.end(replacement)
  })

  await downloadHuggingFace({ ...fixture, logger })

  t.is(requests, 2)
  t.alike(await fs.readFile(fixture.localPath), replacement)
})

for (const [name, headers] of [
  ['wrong offset', { 'Content-Range': 'bytes 0-49151/65536', ETag: '"fixture-v1"' }],
  ['wrong total', { 'Content-Range': 'bytes 16384-65535/65537', ETag: '"fixture-v1"' }],
  ['missing range', { ETag: '"fixture-v1"' }],
  ['changed validator', { 'Content-Range': 'bytes 16384-65535/65536', ETag: '"fixture-v2"' }]
]) {
  test(`HF download never publishes a resumed body with ${name}`, async (t) => {
    let requests = 0
    const fixture = await createDownload(t, (req, res) => {
      if (++requests === 1) return dropBody(res)
      res.writeHead(206, { 'Content-Length': 49152, ...headers })
      res.end(payload.subarray(16384))
    })

    await t.exception(downloadHuggingFace({ ...fixture, logger }), /range|validator/i)
    await t.exception(fs.stat(fixture.localPath), /ENOENT/)
    t.is((await fs.stat(`${fixture.localPath}.incomplete`)).size, 16384)
  })
}

for (const etag of ['W/"fixture-v1"', 'unquoted-validator']) {
  test(`HF download restarts safely with a non-strong ETag ${etag}`, async (t) => {
    const ranges = []
    const fixture = await createDownload(t, (req, res) => {
      ranges.push(req.headers.range)
      if (ranges.length === 1) return dropBody(res, { ETag: etag })
      res.writeHead(200, { 'Content-Length': payload.length })
      res.end(payload)
    })

    await downloadHuggingFace({ ...fixture, logger })

    t.alike(ranges, [undefined, undefined])
    t.alike(await fs.readFile(fixture.localPath), payload)
  })
}

test('HF download retries exhausted fetch TypeErrors as an operational error with its cause', async (t) => {
  let requests = 0
  const fixture = await createDownload(t, (req, res) => {
    requests++
    if (req.headers.range) {
      res.writeHead(206, {
        'Content-Length': 49152,
        'Content-Range': 'bytes 16384-65535/65536',
        ETag: '"fixture-v1"'
      })
      res.flushHeaders()
      setTimeout(() => res.destroy(), 20)
    } else {
      dropBody(res)
    }
  })

  try {
    await downloadHuggingFace({ ...fixture, logger })
    t.fail('Expected download failure')
  } catch (err) {
    t.absent(err instanceof TypeError)
    t.ok(err.cause instanceof TypeError)
    t.is(err.code, 'UND_ERR_SOCKET')
    t.is(err.cause.cause.code, 'UND_ERR_SOCKET')
  }
  t.is(requests, 3)
  await t.exception(fs.stat(fixture.localPath), /ENOENT/)
})

test('HF download does not retry permanent HTTP failures', async (t) => {
  let requests = 0
  const fixture = await createDownload(t, (req, res) => {
    requests++
    res.writeHead(403)
    res.end('Forbidden')
  })

  await t.exception(downloadHuggingFace({ ...fixture, logger }), /403/)
  t.is(requests, 1)
  await t.exception(fs.stat(fixture.localPath), /ENOENT/)
})

test('HF download returns DNS failures as operational errors without retrying', async (t) => {
  const storage = await createTempStorage(t)
  const originalLookup = dns.lookup
  let lookups = 0
  dns.lookup = (hostname, options, callback) => {
    if (hostname !== 'registry-download.invalid') return originalLookup(hostname, options, callback)
    lookups++
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND registry-download.invalid'), {
      code: 'ENOTFOUND'
    })
    process.nextTick(callback, err)
  }

  try {
    await downloadHuggingFace({
      url: 'https://registry-download.invalid/model.gguf',
      localPath: path.join(storage, 'model.gguf'),
      logger
    })
    t.fail('Expected DNS failure')
  } catch (err) {
    t.absent(err instanceof TypeError)
    t.is(err.code, 'ENOTFOUND')
    t.ok(err.cause instanceof TypeError)
    t.is(err.cause?.cause?.code, 'ENOTFOUND')
  } finally {
    dns.lookup = originalLookup
  }
  t.is(lookups, 1, 'permanent DNS failure is not retried')
})

test('HF download returns TLS handshake failures as operational errors without retrying', async (t) => {
  const storage = await createTempStorage(t)
  // A server with no certificate rejects the handshake before any HTTP data.
  const server = tls.createServer()
  let handshakes = 0
  server.on('tlsClientError', () => handshakes++)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)))

  try {
    await downloadHuggingFace({
      url: `https://127.0.0.1:${server.address().port}/model.gguf`,
      localPath: path.join(storage, 'model.gguf'),
      logger
    })
    t.fail('Expected TLS failure')
  } catch (err) {
    t.absent(err instanceof TypeError)
    t.ok(/^ERR_(SSL|TLS)_/.test(err.code))
    t.ok(err.cause instanceof TypeError)
    t.is(err.code, err.cause?.cause?.code, 'preserves the original TLS error code')
  }
  t.is(handshakes, 1, 'permanent TLS failure is not retried')
})

test('HF download preserves invalid request arguments as programming errors', async (t) => {
  const storage = await createTempStorage(t)
  try {
    await downloadHuggingFace({
      url: 'not a URL',
      localPath: path.join(storage, 'model.gguf'),
      logger
    })
    t.fail('Expected programming error')
  } catch (err) {
    t.ok(err instanceof TypeError)
    t.is(err.cause.code, 'ERR_INVALID_URL')
  }
})

async function createDownload(t, handler) {
  const storage = await createTempStorage(t)
  const server = http.createServer(handler)
  server.on('clientError', (err, socket) => socket.destroy())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return {
    url: `http://127.0.0.1:${server.address().port}/model.gguf`,
    localPath: path.join(storage, 'model.gguf')
  }
}

function dropBody(res, headers = {}) {
  res.writeHead(200, { 'Content-Length': payload.length, ETag: '"fixture-v1"', ...headers })
  res.flushHeaders()
  res.write(payload.subarray(0, 16384))
  setTimeout(() => res.destroy(), 20)
}

function sendRemainder(res) {
  res.writeHead(206, {
    'Content-Length': 49152,
    'Content-Range': 'bytes 16384-65535/65536',
    ETag: '"fixture-v1"'
  })
  res.end(payload.subarray(16384))
}
