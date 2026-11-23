import test from 'brittle'
import http from 'bare-http1'
import fs from 'bare-fs'
import path from 'bare-path'
import { downloadModelFromHttp } from '@/handlers/load-model/http'
import { PathTraversalError } from '@/errors/index'
import { useTestCacheDir } from './fixtures/test-cache'

const CONTENT = 'shard'

interface Server {
  base: string
  requests: () => number
  close: () => Promise<void>
}

// Serves CONTENT for every path over loopback and counts the requests.
async function startServer(): Promise<Server> {
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    res.writeHead(200, { 'content-length': String(CONTENT.length) })
    res.end(req.method === 'HEAD' ? undefined : CONTENT)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()!
  return {
    base: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('sharded http download: rejects shard names that escape the shard directory', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  // A backslash is a separator on Windows, so these names would leave the
  // shard directory there. The check rejects them on every platform.
  const escapes = [
    '..\\..\\escape-00001-of-00002.gguf',
    'a\\..\\..\\escape-00001-of-00002.gguf',
    '..\\escape-00002-of-00002.gguf'
  ]

  for (const name of escapes) {
    await t.exception(
      () => downloadModelFromHttp(`${server.base}/models/${name}`),
      PathTraversalError as unknown as new () => Error,
      `must reject: ${name}`
    )
  }
  t.is(server.requests(), 0, 'rejected before any request')
})

test('sharded http download: keeps every shard inside the shard directory', async (t) => {
  const cacheDir = useTestCacheDir()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  const server = await startServer()
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const modelPath = await downloadModelFromHttp(`${server.base}/models/model-00001-of-00002.gguf`)
  const shardDir = path.dirname(modelPath)

  t.is(path.basename(modelPath), 'model-00001-of-00002.gguf', 'returns the first shard')
  t.is(path.dirname(shardDir), path.join(cacheDir, 'sharded'), 'in a cache shard directory')
  for (const name of ['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf']) {
    t.is(fs.readFileSync(path.join(shardDir, name), 'utf8'), CONTENT, `${name} downloaded`)
  }
})
