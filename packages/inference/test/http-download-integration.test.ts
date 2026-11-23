import test from 'brittle'
import http from 'bare-http1'
import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'bare-crypto'
import Buffer from 'bare-buffer'
import AbortController from 'bare-abort-controller'
import {
  downloadHttpFileToPath,
  downloadModelFromHttp,
  isResumableTransferError
} from '@/handlers/load-model/http'
import { partialDownloadPath } from '@/handlers/load-model/download-lock'
import {
  ChecksumUnavailableError,
  ChecksumValidationFailedError,
  DownloadCancelledError,
  HTTPError,
  InsecureModelSourceError,
  PartialDownloadOfflineError
} from '@/errors/index'
import { useTestCacheDir } from './fixtures/test-cache'

// Deterministic, offline coverage of the hand-rolled download client driving the
// real http.ts path (redirect walk -> pipe-to-file, and Range/206 resume) over a
// loopback bare-http1 server. Loopback plaintext is allowed, so no TLS is needed;
// the actual bare-https/TLS path is covered by the real Hugging Face e2e.

const CONTENT = Buffer.alloc(200_000)
for (let i = 0; i < CONTENT.length; i++) CONTENT[i] = i % 251

function bytesEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

interface Server {
  base: string
  served206: () => boolean
  requestedRange: () => boolean
  truncated: () => boolean
  close: () => Promise<void>
}

async function startServer(): Promise<Server> {
  let sent206 = false
  let sawRange = false
  let truncated = false
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/redirect') {
      res.writeHead(302, { location: '/model.gguf' })
      res.end()
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(CONTENT.length) })
      res.end()
      return
    }
    const range = req.headers['range']
    if (range !== undefined) sawRange = true
    if (url === '/ignore-range') {
      res.writeHead(200, { 'content-length': String(CONTENT.length) })
      res.end(CONTENT)
      return
    }
    if (url === '/truncate-once' && range === undefined && !truncated) {
      truncated = true
      res.writeHead(200, { 'content-length': String(CONTENT.length) })
      res.end(CONTENT.subarray(0, CONTENT.length / 2))
      return
    }
    if (url === '/slow-cancel' && range === undefined) {
      res.writeHead(200, { 'content-length': String(CONTENT.length) })
      res.write(CONTENT.subarray(0, CONTENT.length / 2))
      setTimeout(() => res.end(CONTENT.subarray(CONTENT.length / 2)), 100)
      return
    }
    if (range !== undefined) {
      const match = /bytes=(\d+)-/.exec(String(range))
      const start = match && match[1] ? parseInt(match[1]) : 0
      const chunk = CONTENT.subarray(start)
      sent206 = true
      res.writeHead(206, {
        'content-range': `bytes ${start}-${CONTENT.length - 1}/${CONTENT.length}`,
        'content-length': String(chunk.length)
      })
      res.end(chunk)
      return
    }
    res.writeHead(200, { 'content-length': String(CONTENT.length) })
    res.end(CONTENT)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()!
  return {
    base: `http://127.0.0.1:${port}`,
    served206: () => sent206,
    requestedRange: () => sawRange,
    truncated: () => truncated,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function sha256(bytes: Uint8Array): string {
  const hash = crypto.createHash('sha-256')
  hash.update(Buffer.from(bytes))
  return hash.digest('hex')
}

test('downloadModelFromHttp: follows a redirect and streams the body to disk intact', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const modelPath = await downloadModelFromHttp(`${server.base}/redirect`)
  t.ok(
    bytesEqual(fs.readFileSync(modelPath) as Buffer, CONTENT),
    'downloaded bytes match the served content'
  )
})

test('downloadModelFromHttp: resumes a partial download via a Range/206 request', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const url = `${server.base}/range-model.gguf`
  const modelPath = await downloadModelFromHttp(url)

  // An interrupted download's partial forces a Range request answered with 206.
  fs.rmSync(modelPath)
  fs.writeFileSync(partialDownloadPath(modelPath), CONTENT.subarray(0, CONTENT.length / 2))
  const resumedPath = await downloadModelFromHttp(url)

  t.ok(server.served206(), 'server answered a Range request with 206')
  t.ok(
    bytesEqual(fs.readFileSync(resumedPath) as Buffer, CONTENT),
    'resumed file is complete and correct'
  )
  t.absent(fs.existsSync(partialDownloadPath(modelPath)), 'the partial file was moved into place')
})

test('downloadModelFromHttp: replaces a partial when the server ignores Range with 200', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const url = `${server.base}/ignore-range`
  const modelPath = await downloadModelFromHttp(url)
  fs.rmSync(modelPath)
  fs.writeFileSync(partialDownloadPath(modelPath), CONTENT.subarray(0, CONTENT.length / 2))
  await downloadModelFromHttp(url)

  t.ok(server.requestedRange(), 'the existing partial caused a Range request')
  t.ok(
    bytesEqual(fs.readFileSync(modelPath) as Buffer, CONTENT),
    'the 200 body replaced the partial'
  )
})

test('downloadHttpFileToPath: retries a cleanly truncated response before publishing', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const finalPath = path.join(cacheDir, 'truncated.gguf')
  await downloadHttpFileToPath({
    url: `${server.base}/truncate-once`,
    finalPath,
    downloadKey: 'truncated',
    expectedSize: CONTENT.length,
    expectedChecksum: sha256(CONTENT)
  })

  t.ok(server.truncated(), 'the first response ended before its declared length')
  t.ok(
    bytesEqual(fs.readFileSync(finalPath) as Buffer, CONTENT),
    'only the verified file was published'
  )
})

test('downloadHttpFileToPath: rejects an invalid digest and publishes nothing', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const finalPath = path.join(cacheDir, 'invalid-digest.gguf')
  let error: unknown
  try {
    await downloadHttpFileToPath({
      url: `${server.base}/model.gguf`,
      finalPath,
      downloadKey: 'invalid-digest',
      expectedSize: CONTENT.length,
      expectedChecksum: '0'.repeat(64)
    })
  } catch (caught) {
    error = caught
  }
  t.ok(error instanceof ChecksumValidationFailedError, 'the digest mismatch is typed')
  t.absent(fs.existsSync(finalPath), 'the rejected file was never published')
  t.absent(fs.existsSync(partialDownloadPath(finalPath)), 'the rejected partial was deleted')
})

test('downloadHttpFileToPath: cancellation publishes nothing and a later call resumes', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const finalPath = path.join(cacheDir, 'cancel-resume.gguf')
  const controller = new AbortController()
  let cancelled = false
  await t.exception(
    downloadHttpFileToPath({
      url: `${server.base}/slow-cancel`,
      finalPath,
      downloadKey: 'cancel-resume',
      expectedSize: CONTENT.length,
      expectedChecksum: sha256(CONTENT),
      signal: controller.signal,
      progressCallback: () => {
        if (!cancelled) {
          cancelled = true
          setTimeout(() => controller.abort(undefined), 0)
        }
      }
    }),
    DownloadCancelledError
  )
  t.absent(fs.existsSync(finalPath), 'a cancelled partial is not published')

  await downloadHttpFileToPath({
    url: `${server.base}/slow-cancel`,
    finalPath,
    downloadKey: 'cancel-resume',
    expectedSize: CONTENT.length,
    expectedChecksum: sha256(CONTENT)
  })
  t.ok(server.requestedRange(), 'the later call resumed from the cancelled partial')
  t.ok(bytesEqual(fs.readFileSync(finalPath) as Buffer, CONTENT))
})

test('downloadHttpFileToPath: streams, verifies, and publishes 20 times in one process', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  for (let iteration = 0; iteration < 20; iteration++) {
    const finalPath = path.join(cacheDir, `stress-${iteration}.gguf`)
    await downloadHttpFileToPath({
      url: `${server.base}/model.gguf`,
      finalPath,
      downloadKey: `stress-${iteration}`,
      expectedSize: CONTENT.length,
      expectedChecksum: sha256(CONTENT)
    })
    t.ok(bytesEqual(fs.readFileSync(finalPath) as Buffer, CONTENT))
    t.absent(fs.existsSync(partialDownloadPath(finalPath)))
  }
})

test('downloadModelFromHttp: offline with only a partial download fails as an offline partial', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  t.teardown(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

  const server = await startServer()
  const url = `${server.base}/offline-model.gguf`
  const modelPath = await downloadModelFromHttp(url)
  await server.close()

  // An interrupted download left only its partial, and the server is gone.
  fs.rmSync(modelPath)
  const partial = CONTENT.subarray(0, CONTENT.length / 2)
  fs.writeFileSync(partialDownloadPath(modelPath), partial)

  let error: unknown
  try {
    await downloadModelFromHttp(url)
  } catch (caught) {
    error = caught
  }
  t.ok(error instanceof PartialDownloadOfflineError, 'fails as an offline partial download')
  t.is(
    fs.statSync(partialDownloadPath(modelPath)).size,
    partial.length,
    'the partial is kept for a later resume'
  )
})

test('downloadModelFromHttp: replaces an incomplete file at the model path instead of appending', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const url = `${server.base}/in-place-model.gguf`
  const modelPath = await downloadModelFromHttp(url)

  // A half file at the model path may be an older SDK's download in progress;
  // appending to it corrupted shared caches, so it is replaced instead.
  fs.writeFileSync(modelPath, CONTENT.subarray(0, CONTENT.length / 2))
  const replacedPath = await downloadModelFromHttp(url)

  t.absent(server.served206(), 'no Range request was made against the in-place file')
  t.ok(
    bytesEqual(fs.readFileSync(replacedPath) as Buffer, CONTENT),
    'the model path now holds the complete file'
  )
})

test('isResumableTransferError: integrity and insecure failures are terminal, transient network errors resume', (t) => {
  // A verification failure must never resume — resuming would range-append onto
  // already-rejected bytes.
  t.absent(isResumableTransferError(new ChecksumValidationFailedError('u')))
  t.absent(isResumableTransferError(new ChecksumUnavailableError('u')))
  t.absent(isResumableTransferError(new InsecureModelSourceError('u', 'r')))
  // A real HTTP status is terminal; a connection failure (status 0) resumes.
  t.absent(isResumableTransferError(new HTTPError(404, 'Not Found')))
  t.ok(isResumableTransferError(new HTTPError(0, 'Connection failed')))
  t.ok(isResumableTransferError(new Error('socket hang up')))
})
