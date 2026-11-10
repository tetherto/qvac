import test from 'brittle'
import http from 'bare-http1'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Buffer from 'bare-buffer'
import { spawn, type Subprocess } from 'bare-subprocess'
import { AbortController } from 'bare-abort-controller'
import {
  acquireDownloadLock,
  partialDownloadPath,
  tryAcquireDownloadLocks
} from '@/handlers/load-model/download-lock'
import { downloadModelFromHttp } from '@/handlers/load-model/http'
import { validateCachedFile } from '@/handlers/load-model/registry-download-utils'
import {
  cancelTransfer,
  createHttpDownloadKey,
  createRegistryCacheKey
} from '@/handlers/load-model/download-manager'
import { handleDeleteCache } from '@/handlers/delete-cache'
import { getSingleFileCachePath } from '@/utils/cache/paths'
import { QWEN3_600M_INST_Q4 } from '@/models/registry/index'
import {
  calculateCachedFileChecksum,
  calculateFileChecksum,
  generateShortHash,
  renameWithCachedChecksum
} from '@/utils/index'
import { DownloadCancelledError } from '@/errors/index'
import { useTestCacheDir } from './fixtures/test-cache'
import { stubClient } from './fixtures/registry-client-stub'

// Several processes (an app, `qvac sdk serve`, a TUI) can share one models
// directory. These tests cover the download lock and the partial-file layout
// that keep them from corrupting or deleting each other's model files.

// The suite runs from the package root, so the compiled child sits here.
const CHILD_SCRIPT = path.resolve(os.cwd(), 'test/dist/test/fixtures/download-child.js')

const CONTENT = Buffer.alloc(400_000)
for (let i = 0; i < CONTENT.length; i++) CONTENT[i] = (i * 7) % 251

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await sleep(20)
  }
}

function makeTempDir(label: string): string {
  const dir = path.join(
    os.tmpdir(),
    `qvac-xproc-${label}-${os.pid()}-${Math.random().toString(16).slice(2)}`
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function bytesEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// GETs send the first half of the body, then hold until `release()`, so a test
// can act while a download is in progress.
interface GatedServer {
  base: string
  gets: () => number
  ranges: () => string[]
  halfSent: () => boolean
  release: () => void
  close: () => Promise<void>
}

async function startGatedServer(): Promise<GatedServer> {
  let gets = 0
  let halfSent = false
  const ranges: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const server = http.createServer((req, res) => {
    res.on('error', () => {})
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(CONTENT.length) })
      res.end()
      return
    }

    gets++
    const range = req.headers['range']
    let start = 0
    if (range !== undefined) {
      ranges.push(String(range))
      const match = /bytes=(\d+)-/.exec(String(range))
      start = match && match[1] ? parseInt(match[1]) : 0
      res.writeHead(206, {
        'content-range': `bytes ${start}-${CONTENT.length - 1}/${CONTENT.length}`,
        'content-length': String(CONTENT.length - start)
      })
    } else {
      res.writeHead(200, { 'content-length': String(CONTENT.length) })
    }

    const body = CONTENT.subarray(start)
    const half = Math.floor(body.length / 2)
    res.write(body.subarray(0, half))
    halfSent = true
    void gate.then(() => {
      if (!res.destroyed) res.end(body.subarray(half))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()!
  return {
    base: `http://127.0.0.1:${port}`,
    gets: () => gets,
    ranges: () => ranges,
    halfSent: () => halfSent,
    release,
    close: () => {
      release()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

interface ChildResult {
  ok: boolean
  path?: string
  locked?: boolean
  error?: string
}

// Captured at load: a registry client stub replaces Bare.argv during a test.
const BARE = Bare.argv[0] ?? 'bare'

function startChild(args: string[]): { child: Subprocess; exited: Promise<void> } {
  const child = spawn(BARE, [CHILD_SCRIPT, ...args], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
  return { child, exited }
}

function readResult(resultFile: string): ChildResult {
  return JSON.parse(fs.readFileSync(resultFile, 'utf8') as unknown as string) as ChildResult
}

function cachedHttpPath(cacheDir: string, url: string, filename: string): string {
  return path.join(cacheDir, `${generateShortHash(url)}_${filename}`)
}

test('acquireDownloadLock: a second holder waits until the first releases', async (t) => {
  useTestCacheDir()
  const key = `lock-test:${Math.random()}`

  const first = await acquireDownloadLock(key, new AbortController().signal)
  let secondHolds = false
  const second = acquireDownloadLock(key, new AbortController().signal).then((lock) => {
    secondHolds = true
    return lock
  })

  await sleep(400)
  t.absent(secondHolds, 'the second holder waits while the first holds the lock')

  await first[Symbol.asyncDispose]()
  const lock = await second
  t.ok(secondHolds, 'the second holder gets the lock once the first releases it')
  await lock[Symbol.asyncDispose]()
})

test('acquireDownloadLock: cancelling a waiter rejects it without disturbing the holder', async (t) => {
  useTestCacheDir()
  const key = `lock-test:${Math.random()}`

  const holder = await acquireDownloadLock(key, new AbortController().signal)
  const controller = new AbortController()
  const waiter = acquireDownloadLock(key, controller.signal)
  await sleep(100)
  controller.abort(undefined)

  try {
    await waiter
    t.fail('a cancelled waiter must not get the lock')
  } catch (error) {
    t.ok(error instanceof DownloadCancelledError, 'the waiter rejects with DownloadCancelledError')
  }

  await holder[Symbol.asyncDispose]()
  const next = await acquireDownloadLock(key, new AbortController().signal)
  t.pass('the lock is free again after the holder releases it')
  await next[Symbol.asyncDispose]()
})

test('acquireDownloadLock: different downloads do not wait on each other', async (t) => {
  useTestCacheDir()
  const a = await acquireDownloadLock(`lock-test:a:${Math.random()}`, new AbortController().signal)
  const b = await Promise.race([
    acquireDownloadLock(`lock-test:b:${Math.random()}`, new AbortController().signal),
    sleep(2_000).then(() => null)
  ])
  t.ok(b, 'a different download gets its own lock immediately')
  await a[Symbol.asyncDispose]()
  if (b) await b[Symbol.asyncDispose]()
})

test('tryAcquireDownloadLocks: takes every lock or none, without waiting', async (t) => {
  useTestCacheDir()
  const free = `lock-test:free:${Math.random()}`
  const busy = `lock-test:busy:${Math.random()}`

  const holder = await acquireDownloadLock(busy, new AbortController().signal)
  t.is(await tryAcquireDownloadLocks([free, busy]), null, 'refused while one key is held')

  const freeLock = await tryAcquireDownloadLocks([free])
  t.ok(freeLock, 'the refused attempt released the lock it had taken')
  await freeLock?.[Symbol.asyncDispose]()

  await holder[Symbol.asyncDispose]()
  const both = await tryAcquireDownloadLocks([free, busy])
  t.ok(both, 'granted once no key is held')
  await both?.[Symbol.asyncDispose]()
})

test('deleteCache: refused while another process downloads the model, and deletes nothing', async (t) => {
  const cacheDir = useTestCacheDir()
  let cleared = false
  stubClient(t, {
    clearBlob: async () => {
      cleared = true
    }
  })
  const resultDir = makeTempDir('delete')
  const resultFile = path.join(resultDir, 'result.json')
  const partialPath = partialDownloadPath(getSingleFileCachePath(QWEN3_600M_INST_Q4.registryPath))
  fs.mkdirSync(path.dirname(partialPath), { recursive: true })
  fs.writeFileSync(partialPath, 'in-progress bytes')

  const { child, exited } = startChild([
    'hold-lock',
    cacheDir,
    resultFile,
    createRegistryCacheKey(QWEN3_600M_INST_Q4.registryPath),
    '30000'
  ])
  t.teardown(async () => {
    child.kill()
    await exited
    fs.rmSync(partialPath, { force: true })
    fs.rmSync(resultDir, { recursive: true, force: true })
  })
  await waitUntil(() => fs.existsSync(resultFile))

  const response = await handleDeleteCache({
    type: 'deleteCache',
    modelSrc: QWEN3_600M_INST_Q4.src
  })

  t.is(response.success, false)
  t.ok(response.error?.includes('another process'), 'reports the other process download')
  t.ok(fs.existsSync(partialPath), 'the other process partial file is untouched')
  t.absent(cleared, 'no stored blocks were cleared')
})

test('acquireDownloadLock: the OS releases a lock when its holding process exits', async (t) => {
  const cacheDir = useTestCacheDir()
  const key = `lock-test:${Math.random()}`
  const resultDir = makeTempDir('hold')
  const resultFile = path.join(resultDir, 'result.json')
  t.teardown(() => fs.rmSync(resultDir, { recursive: true, force: true }))

  const { exited } = startChild(['hold-lock', cacheDir, resultFile, key, '800'])
  await waitUntil(() => fs.existsSync(resultFile))
  t.ok(readResult(resultFile).locked, 'the other process holds the lock')

  let acquired = false
  const acquiring = acquireDownloadLock(key, new AbortController().signal).then((lock) => {
    acquired = true
    return lock
  })
  await sleep(300)
  t.absent(acquired, 'this process waits while the other process holds the lock')

  const lock = await acquiring
  await exited
  t.ok(acquired, 'the lock is granted after the other process exits without releasing it')
  await lock[Symbol.asyncDispose]()
})

test('two processes downloading the same URL into one models directory leave one intact file', async (t) => {
  const server = await startGatedServer()
  const cacheDir = makeTempDir('shared-models')
  const resultDir = makeTempDir('results')
  t.teardown(async () => {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
    fs.rmSync(resultDir, { recursive: true, force: true })
  })

  const url = `${server.base}/shared-model.gguf`
  const first = path.join(resultDir, 'first.json')
  const second = path.join(resultDir, 'second.json')

  const firstChild = startChild(['download', cacheDir, first, url])
  await waitUntil(() => server.halfSent())

  // The second process starts while the first is mid-download. Without the
  // lock it would range-resume onto the first process's partial file. Waiting
  // for it to start keeps a slow spawn from turning this into a cache hit.
  const secondChild = startChild(['download', cacheDir, second, url])
  await waitUntil(() => fs.existsSync(`${second}.started`))
  await sleep(1_000)
  t.is(server.gets(), 1, 'the second process does not start its own transfer')
  t.absent(fs.existsSync(second), 'the second process is still waiting for the first')

  server.release()
  await Promise.all([firstChild.exited, secondChild.exited])

  const firstResult = readResult(first)
  const secondResult = readResult(second)
  t.ok(firstResult.ok, `the first process succeeds ${firstResult.error ?? ''}`)
  t.ok(secondResult.ok, `the second process succeeds ${secondResult.error ?? ''}`)
  t.is(secondResult.path, firstResult.path, 'both processes use the same cached file')
  t.is(server.gets(), 1, 'the model was transferred once')
  t.alike(server.ranges(), [], 'no process appended to another one partial file')

  const modelPath = firstResult.path
  if (!modelPath) return
  t.ok(bytesEqual(fs.readFileSync(modelPath) as Buffer, CONTENT), 'the cached file is intact')
  t.absent(fs.existsSync(partialDownloadPath(modelPath)), 'no partial file is left behind')
})

test('downloadModelFromHttp: a download is not visible at the model path until it completes', async (t) => {
  const cacheDir = useTestCacheDir()
  const server = await startGatedServer()
  t.teardown(() => server.close())

  const url = `${server.base}/visible-${Math.random().toString(16).slice(2)}.gguf`
  const modelPath = cachedHttpPath(cacheDir, url, path.basename(url))
  const partialPath = partialDownloadPath(modelPath)

  const download = downloadModelFromHttp(url)
  await waitUntil(() => server.halfSent() && fs.existsSync(partialPath))
  t.absent(fs.existsSync(modelPath), 'nothing is at the model path mid-download')

  server.release()
  t.is(await download, modelPath)
  t.ok(bytesEqual(fs.readFileSync(modelPath) as Buffer, CONTENT), 'the published file is complete')
  t.absent(fs.existsSync(partialPath), 'the partial file was moved into place')
  fs.rmSync(modelPath, { force: true })
})

test('downloadModelFromHttp: cancelling with clearCache deletes only this download partial', async (t) => {
  const cacheDir = useTestCacheDir()
  const server = await startGatedServer()
  t.teardown(() => server.close())

  const url = `${server.base}/clear-${Math.random().toString(16).slice(2)}.gguf`
  const modelPath = cachedHttpPath(cacheDir, url, path.basename(url))
  const partialPath = partialDownloadPath(modelPath)

  const download = downloadModelFromHttp(url)
  await waitUntil(() => server.halfSent() && fs.existsSync(partialPath))
  cancelTransfer(createHttpDownloadKey(url), true)

  try {
    await download
    t.fail('the cancelled download must reject')
  } catch (error) {
    t.ok(error instanceof DownloadCancelledError, 'the download rejects as cancelled')
  }
  await waitUntil(() => !fs.existsSync(partialPath))
  t.pass('the partial file is deleted')
  t.absent(fs.existsSync(modelPath), 'nothing was written at the model path')
})

test('downloadModelFromHttp: a paused download resumes from its partial file', async (t) => {
  const cacheDir = useTestCacheDir()
  const server = await startGatedServer()
  t.teardown(() => server.close())

  const url = `${server.base}/pause-${Math.random().toString(16).slice(2)}.gguf`
  const modelPath = cachedHttpPath(cacheDir, url, path.basename(url))
  const partialPath = partialDownloadPath(modelPath)

  const download = downloadModelFromHttp(url)
  await waitUntil(
    () =>
      server.halfSent() &&
      fs.existsSync(partialPath) &&
      fs.statSync(partialPath).size >= CONTENT.length / 2
  )
  cancelTransfer(createHttpDownloadKey(url), false)
  await download.catch(() => {})

  // Let the cancelled download release its lock before resuming.
  await sleep(300)
  t.ok(fs.existsSync(partialPath), 'the partial file is kept for resume')
  t.absent(fs.existsSync(modelPath), 'the partial is not treated as a cached model')

  server.release()
  t.is(await downloadModelFromHttp(url), modelPath)
  t.is(server.ranges().length, 1, 'the second attempt resumed with a Range request')
  t.ok(bytesEqual(fs.readFileSync(modelPath) as Buffer, CONTENT), 'the resumed file is complete')
  t.absent(fs.existsSync(partialPath), 'the partial file was moved into place')
  fs.rmSync(modelPath, { force: true })
})

test('registry validateCachedFile: a mismatched file is reported, never deleted', async (t) => {
  const dir = makeTempDir('registry-validate')
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'model.gguf')
  fs.writeFileSync(filePath, CONTENT.subarray(0, 1000))

  t.is(await validateCachedFile(filePath, 'model.gguf', 2000), null, 'wrong size is a cache miss')
  t.ok(fs.existsSync(filePath), 'a wrong-size file may be another download and is kept')

  t.is(
    await validateCachedFile(filePath, 'model.gguf', 1000, 'f'.repeat(64)),
    null,
    'wrong checksum is a cache miss'
  )
  t.ok(fs.existsSync(filePath), 'a wrong-checksum file is kept until a download replaces it')
})

test('renameWithCachedChecksum: moves the file and still detects later changes', async (t) => {
  const dir = makeTempDir('rename-checksum')
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const from = path.join(dir, 'model.gguf.part')
  const to = path.join(dir, 'model.gguf')
  fs.writeFileSync(from, CONTENT)

  const digest = await calculateCachedFileChecksum(from)
  await renameWithCachedChecksum(from, to)

  t.absent(fs.existsSync(from), 'the source path is gone')
  t.is(await calculateCachedFileChecksum(to), digest, 'the destination has the same digest')

  const changed = Buffer.from(CONTENT)
  changed[0] = (changed[0]! + 1) % 251
  fs.writeFileSync(to, changed)
  t.is(
    await calculateCachedFileChecksum(to),
    await calculateFileChecksum(to),
    'a later change to the destination is re-hashed'
  )
})
