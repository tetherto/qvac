import test from 'brittle'
import http from 'bare-http1'
import fs from 'bare-fs'
import Buffer from 'bare-buffer'
import { downloadModelFromHttp, isResumableTransferError } from '@/handlers/load-model/http'
import {
  ChecksumUnavailableError,
  ChecksumValidationFailedError,
  HTTPError,
  InsecureModelSourceError
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
  close: () => Promise<void>
}

async function startServer(): Promise<Server> {
  let sent206 = false
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
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

  // Truncate the cached file to a partial, then re-download: the size mismatch
  // forces a Range request the server answers with 206, appending the remainder.
  fs.writeFileSync(modelPath, CONTENT.subarray(0, CONTENT.length / 2))
  const resumedPath = await downloadModelFromHttp(url)

  t.ok(server.served206(), 'server answered a Range request with 206')
  t.ok(
    bytesEqual(fs.readFileSync(resumedPath) as Buffer, CONTENT),
    'resumed file is complete and correct'
  )
})

test('downloadModelFromHttp: a failed shard stops the other shard transfers before rejecting', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  // Shard 1 streams slowly; shard 2 is missing, so the sharded download fails
  // while shard 1 is still mid-transfer.
  const chunk = Buffer.alloc(16 * 1024, 3)
  const chunks = 80
  let siblingClosed = false
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').includes('-00002-of-00002')) {
      res.writeHead(404, { 'content-length': '0' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-length': String(chunk.length * chunks) })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.on('close', () => {
      siblingClosed = true
    })
    let sent = 0
    const tick = () => {
      if (siblingClosed || res.destroyed) return
      res.write(chunk)
      if (++sent >= chunks) res.end()
      else setTimeout(tick, 25)
    }
    tick()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as { port: number }
  t.teardown(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  let error: unknown
  try {
    await downloadModelFromHttp(`http://127.0.0.1:${port}/split-00001-of-00002.gguf`)
  } catch (e) {
    error = e
  }
  t.ok(error instanceof HTTPError, 'the download rejects with the missing shard')

  for (let i = 0; i < 20 && !siblingClosed; i++) {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 25))
  }
  t.ok(siblingClosed, 'the in-flight sibling shard request was aborted')
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
