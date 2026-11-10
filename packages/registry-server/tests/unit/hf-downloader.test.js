'use strict'

const test = require('brittle')
const http = require('http')
const fs = require('fs').promises
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
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
  t.is(warnings[0].error, 'terminated')
  t.is(warnings[0].cause, 'other side closed')
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

test('HF download preserves programming TypeErrors instead of converting them to network failures', async (t) => {
  const fixture = await createDownload(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': payload.length })
    res.end(payload)
  })
  const programmerError = new TypeError('broken progress callback')

  try {
    await downloadHuggingFace({
      ...fixture,
      logger: {
        info() {
          throw programmerError
        },
        warn() {}
      }
    })
    t.fail('Expected programming error')
  } catch (err) {
    t.is(err, programmerError)
  }
})

test('HF socket exhaustion through real Protomux RPC does not terminate Node after caller timeout', async (t) => {
  t.timeout(20000)
  const fixture = await createDownload(t, (req, res) => dropBody(res))
  const script = `
    const { createRequire } = require('module')
    const RPC = require('protomux-rpc')
    const { PassThrough } = createRequire(require.resolve('corestore'))('streamx')
    const { downloadHuggingFace } = require('./lib/hf-downloader')
    const rpc = new RPC(new PassThrough())
    let finish
    const finished = new Promise(resolve => { finish = resolve })
    rpc.respond('add-model', async () => {
      try {
        await downloadHuggingFace({
          url: process.argv[1], localPath: process.argv[2],
          logger: { info() {}, warn() {} }
        })
      } finally { finish() }
    })
    ;(async () => {
      try { await rpc.request('add-model', Buffer.alloc(0), { timeout: 10 }) }
      catch (err) { console.log(err.code) }
      await finished
      await new Promise(resolve => setImmediate(resolve))
      rpc.destroy()
      console.log('registry survived')
    })().catch(err => { console.error(err); process.exitCode = 1 })
  `

  const result = await promisify(execFile)(
    process.execPath,
    ['-e', script, fixture.url, fixture.localPath],
    {
      cwd: path.resolve(__dirname, '../..'),
      timeout: 15000
    }
  )
  t.ok(result.stdout.includes('TIMEOUT_EXCEEDED'))
  t.ok(result.stdout.includes('registry survived'))
  t.is(result.stderr, '')
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
