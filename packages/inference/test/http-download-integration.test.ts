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
import { unloadModel } from '@/plugins/ops/unload-model'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { ModelType } from '@/schemas/index'
import { completeMarkerPath } from '@/utils/cache/paths'
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
    if (req.method === 'HEAD' && url === '/head-unsized.bin') {
      // A HEAD with no size never matches the cache, so the client re-requests with a Range.
      res.writeHead(200)
      res.end()
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(CONTENT.length) })
      res.end()
      return
    }
    if (url === '/unsized.bin') {
      // No content-length, so the client can't tell a whole body from a cut one.
      res.writeHead(200)
      res.write(CONTENT)
      res.end()
      return
    }
    const range = req.headers['range']
    if (range !== undefined) {
      const match = /bytes=(\d+)-/.exec(String(range))
      const start = match && match[1] ? parseInt(match[1]) : 0
      if (start >= CONTENT.length) {
        res.writeHead(416, { 'content-range': `bytes */${CONTENT.length}` })
        res.end()
        return
      }
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

test('downloadModelFromHttp: serves a finished non-GGUF download from cache when offline', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

  // CONTENT has no GGUF header, like a whisper.cpp .bin.
  const url = `${server.base}/ggml-model.bin`
  const modelPath = await downloadModelFromHttp(url)
  await server.close()

  t.is(await downloadModelFromHttp(url), modelPath, 'offline load uses the cached file')
})

test('downloadModelFromHttp: an offline partial is still refused', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

  const url = `${server.base}/ggml-partial.bin`
  const modelPath = await downloadModelFromHttp(url)
  await server.close()
  fs.writeFileSync(modelPath, CONTENT.subarray(0, CONTENT.length / 2))

  await t.exception(() => downloadModelFromHttp(url), /Cannot resume partial download/)
})

test('downloadModelFromHttp: a download of unknown size is not trusted offline', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

  const url = `${server.base}/unsized.bin`
  await downloadModelFromHttp(url)
  await server.close()

  await t.exception(() => downloadModelFromHttp(url), /Cannot resume partial download/)
})

test('downloadModelFromHttp: an unmarked cache is marked on an online load, then loads offline', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

  const url = `${server.base}/ggml-legacy.bin`
  const modelPath = await downloadModelFromHttp(url)
  // A file cached before the marker existed.
  fs.rmSync(completeMarkerPath(modelPath))

  await downloadModelFromHttp(url)
  t.ok(fs.existsSync(completeMarkerPath(modelPath)), 'the online size check wrote the marker')
  await server.close()

  t.is(await downloadModelFromHttp(url), modelPath, 'offline load uses the cached file')
})

test('downloadModelFromHttp: a 416 for the whole file marks it complete', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

  const url = `${server.base}/head-unsized.bin`
  const modelPath = await downloadModelFromHttp(url)
  // HEAD gives no size, so this load sends a Range past the end and gets a 416.
  await downloadModelFromHttp(url)
  await server.close()

  t.is(await downloadModelFromHttp(url), modelPath, 'offline load uses the cached file')
})

test('downloadModelFromHttp: an empty cache is not marked when HEAD gives no size', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

  const url = `${server.base}/head-unsized.bin`
  const modelPath = await downloadModelFromHttp(url)
  // An interrupted download that left nothing on disk.
  fs.writeFileSync(modelPath, Buffer.alloc(0))
  fs.rmSync(completeMarkerPath(modelPath))

  await downloadModelFromHttp(url)
  t.ok(bytesEqual(fs.readFileSync(modelPath) as Buffer, CONTENT), 'the empty file was downloaded again')
  t.is(fs.readFileSync(completeMarkerPath(modelPath), 'utf8'), String(CONTENT.length), 'the marker has the real size')
  await server.close()
})

test('downloadModelFromHttp: a 416 for a file longer than the server has is not marked', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const url = `${server.base}/ggml-long.bin`
  const modelPath = await downloadModelFromHttp(url)
  fs.writeFileSync(modelPath, Buffer.concat([CONTENT, Buffer.alloc(10)]))

  await downloadModelFromHttp(url)
  t.absent(fs.existsSync(completeMarkerPath(modelPath)), 'no marker for a size the server denies')
})

test('unloadModel: clearStorage removes the complete marker with the model', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const modelPath = await downloadModelFromHttp(`${server.base}/ggml-cleared.bin`)
  t.ok(fs.existsSync(completeMarkerPath(modelPath)), 'the download wrote the marker')

  const modelId = 'test-clear-storage-marker'
  registerModel(modelId, {
    model: { unload: async () => {} },
    path: modelPath,
    config: {},
    modelType: ModelType.whispercppTranscription
  } as never)
  t.teardown(() => unregisterModel(modelId))

  await unloadModel({ modelId, clearStorage: true })
  t.absent(fs.existsSync(modelPath), 'the model file is gone')
  t.absent(fs.existsSync(completeMarkerPath(modelPath)), 'and so is its marker')
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
