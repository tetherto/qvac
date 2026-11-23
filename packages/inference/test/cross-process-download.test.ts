import test from 'brittle'
import http from 'bare-http1'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Buffer from 'bare-buffer'
import { spawn, type Subprocess } from 'bare-subprocess'
import { AbortController } from 'bare-abort-controller'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import {
  acquireDownloadLock,
  holdsDownloadLockHere,
  partialDownloadPath,
  tryAcquireDownloadLocks,
  waitForDownloadLocksHere
} from '@/handlers/load-model/download-lock'
import { downloadModelFromHttp } from '@/handlers/load-model/http'
import {
  downloadAndValidateFile,
  downloadModelFromHyperdrive
} from '@/handlers/load-model/hyperdrive'
import { downloadModelFromRegistry } from '@/handlers/load-model/registry'
import { validateCachedFile } from '@/handlers/load-model/registry-download-utils'
import {
  cancelTransfer,
  createHttpDownloadKey,
  createHyperdriveDownloadKey,
  createRegistryCacheKey,
  createRegistryDownloadKey
} from '@/handlers/load-model/download-manager'
import { handleDeleteCache } from '@/handlers/delete-cache'
import { getShardedModelCacheDir, getSingleFileCachePath } from '@/utils/cache/paths'
import { parsePatternBasedShardUrl } from '@/utils/shard-utils'
import { getQvacPath } from '@/utils/qvac-paths'
import { initEnv } from '@/runtime/env'
import { models, QWEN3_600M_INST_Q4, type RegistryItem } from '@/models/registry/index'
import {
  calculateCachedFileChecksum,
  calculateFileChecksum,
  generateShortHash,
  renameWithCachedChecksum
} from '@/utils/index'
import { DownloadCancelledError, HTTPError } from '@/errors/index'
import { useTestCacheDir } from './fixtures/test-cache'
import { stubClient } from './fixtures/registry-client-stub'
import { MODEL_CONTENT } from './fixtures/xproc-content'

// Processes sharing one models directory must not corrupt or delete each
// other's model files.

// The suite runs from the package root, so the compiled child sits here.
const CHILD_SCRIPT = path.resolve(os.cwd(), 'test/dist/test/fixtures/download-child.js')

const CONTENT = MODEL_CONTENT

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
  downloads?: number
  home?: string
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

// Points the SDK home at a temp directory for one test.
function useTempSdkHome(t: { teardown(fn: () => void): void }): string {
  const home = makeTempDir('home')
  const argv = Bare.argv.slice()
  Bare.argv.length = 0
  Bare.argv.push('', '', JSON.stringify({ HOME_DIR: home }))
  initEnv()
  t.teardown(() => {
    Bare.argv.length = 0
    Bare.argv.push(...argv)
    initEnv()
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

function cachedHttpPath(cacheDir: string, url: string, filename: string): string {
  return path.join(cacheDir, `${generateShortHash(url)}_${filename}`)
}

// Slows every write to a partial file so one is in flight when a download is cancelled.
function slowPartialWrites(t: { teardown(fn: () => void): void }): { closed: () => boolean } {
  let closed = false
  const createWriteStream = fs.createWriteStream
  fs.createWriteStream = (...args: Parameters<typeof createWriteStream>) => {
    const stream = createWriteStream(...args)
    if (String(args[0]).endsWith('.part')) {
      const slow = stream as unknown as { _writev(batch: unknown, cb: () => void): void }
      const writev = slow._writev.bind(stream)
      slow._writev = (batch, cb) => setTimeout(() => writev(batch, cb), 300)
      stream.on('close', () => {
        closed = true
      })
    }
    return stream
  }
  t.teardown(() => {
    fs.createWriteStream = createWriteStream
  })
  return { closed: () => closed }
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

test('tryAcquireDownloadLocks: releases the locks it took when a later one cannot be opened', async (t) => {
  const cacheDir = useTestCacheDir()
  const first = `lock-test:first:${Math.random()}`
  const broken = `lock-test:broken:${Math.random()}`
  // A directory where the lock file belongs cannot be opened as one.
  const brokenPath = path.join(cacheDir, '.locks', `${generateShortHash(broken)}.lock`)
  fs.mkdirSync(brokenPath, { recursive: true })
  t.teardown(() => fs.rmSync(brokenPath, { recursive: true, force: true }))

  await t.exception(tryAcquireDownloadLocks([first, broken]))
  const lock = await tryAcquireDownloadLocks([first])
  t.ok(lock, 'the lock taken before the failure was released')
  await lock?.[Symbol.asyncDispose]()
})

// Makes each path read-only until `restore()`. `effective` is false when that
// has no effect, for example when running as root.
function makeReadOnly(paths: string[]): { effective: boolean; restore: () => void } {
  const modes = paths.map((target) => fs.statSync(target).mode & 0o777)
  paths.forEach((target, i) => fs.chmodSync(target, modes[i]! & 0o555))
  const effective = paths.every((target) => {
    try {
      fs.accessSync(target, fs.constants.W_OK)
      return false
    } catch {
      return true
    }
  })
  return {
    effective,
    restore: () => paths.forEach((target, i) => fs.chmodSync(target, modes[i]!))
  }
}

// `root` and everything under it. Test files share one cache directory, so a
// read-only case must cover what earlier files left there.
function treeOf(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true }) as unknown as Array<{
    name: string
    isDirectory(): boolean
  }>
  return [
    root,
    ...entries.flatMap((entry) => {
      const entryPath = path.join(root, entry.name)
      return entry.isDirectory() ? treeOf(entryPath) : [entryPath]
    })
  ]
}

test('downloadModelFromHttp: a cached model still loads from a read-only models directory', async (t) => {
  const cacheDir = useTestCacheDir()
  const server = await startGatedServer()
  const url = `${server.base}/read-only-${Math.random().toString(16).slice(2)}.gguf`
  const modelPath = cachedHttpPath(cacheDir, url, url.split('/').pop()!)
  const lockDir = path.join(cacheDir, '.locks')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(modelPath, CONTENT)
  // A writable model file is fine: downloads only replace files through folders.
  const readOnly = makeReadOnly(treeOf(cacheDir).filter((target) => target !== modelPath))
  t.teardown(async () => {
    readOnly.restore()
    await server.close()
    fs.rmSync(modelPath, { force: true })
  })
  if (!readOnly.effective) {
    t.comment('directories stay writable for this user, so the case cannot be set up')
    return
  }

  const result = await downloadModelFromHttp(url).catch((error: unknown) => error)
  t.is(
    result,
    modelPath,
    `the cached model is used ${result instanceof Error ? result.message : ''}`
  )
  t.is(server.gets(), 0, 'nothing is downloaded')
})

test('a writable models directory without a writable lock refuses downloads and deletion', async (t) => {
  const cacheDir = useTestCacheDir()
  stubClient(t, { clearBlob: async () => {} })
  const server = await startGatedServer()
  const url = `${server.base}/no-lock-${Math.random().toString(16).slice(2)}.gguf`
  const modelPath = cachedHttpPath(cacheDir, url, url.split('/').pop()!)
  const registryPartial = partialDownloadPath(
    getSingleFileCachePath(QWEN3_600M_INST_Q4.registryPath)
  )
  const lockDir = path.join(cacheDir, '.locks')
  fs.mkdirSync(path.dirname(registryPartial), { recursive: true })
  fs.writeFileSync(registryPartial, 'another process download')
  fs.mkdirSync(lockDir, { recursive: true })
  const readOnly = makeReadOnly(treeOf(lockDir))
  t.teardown(async () => {
    readOnly.restore()
    await server.close()
    fs.rmSync(partialDownloadPath(modelPath), { force: true })
    fs.rmSync(registryPartial, { force: true })
  })
  if (!readOnly.effective) {
    t.comment('the lock directory stays writable for this user, so the case cannot be set up')
    return
  }
  // Serve in full, so a download that wrongly runs without the lock finishes fast.
  server.release()

  const result = await downloadModelFromHttp(url).catch((error: unknown) => error)
  t.ok(result instanceof Error, 'the download fails instead of running without the lock')
  t.is(server.gets(), 0, 'nothing is downloaded')
  t.absent(fs.existsSync(partialDownloadPath(modelPath)), 'no partial file is written')

  const deletion = await handleDeleteCache({
    type: 'deleteCache',
    modelSrc: QWEN3_600M_INST_Q4.src
  })
  t.is(deletion.success, false, 'deletion is refused')
  t.ok(fs.existsSync(registryPartial), 'the other download partial file is untouched')
})

test('a read-only models directory with a writable folder inside refuses downloads and deletion', async (t) => {
  const cacheDir = useTestCacheDir()
  stubClient(t, { clearBlob: async () => {} })
  const server = await startGatedServer()
  const url = `${server.base}/ro-shards-${Math.random().toString(16).slice(2)}/model-00001-of-00002.gguf`
  const shardDir = getShardedModelCacheDir(parsePatternBasedShardUrl(url).cacheKey)
  const sharded = (models as readonly RegistryItem[]).find((model) => model.shardMetadata?.length)!
  const registryShardDir = getShardedModelCacheDir(generateShortHash(sharded.registryPath))
  const registryShard = path.join(registryShardDir, sharded.shardMetadata![0]!.filename)
  fs.writeFileSync(registryShard, 'another process shard')
  fs.mkdirSync(path.join(cacheDir, '.locks'), { recursive: true })
  const writable = new Set([shardDir, registryShardDir, registryShard])
  const readOnly = makeReadOnly(treeOf(cacheDir).filter((target) => !writable.has(target)))
  t.teardown(async () => {
    readOnly.restore()
    await server.close()
    fs.rmSync(shardDir, { recursive: true, force: true })
    fs.rmSync(registryShardDir, { recursive: true, force: true })
  })
  if (!readOnly.effective) {
    t.comment('directories stay writable for this user, so the case cannot be set up')
    return
  }
  // Serve in full, so a download that wrongly runs without the lock finishes fast.
  server.release()

  const result = await downloadModelFromHttp(url).catch((error: unknown) => error)
  t.ok(result instanceof Error, 'the download fails instead of running without the lock')
  t.is(server.gets(), 0, 'nothing is downloaded')
  t.alike(fs.readdirSync(shardDir), [], 'nothing is written to the writable folder')

  const deletion = await handleDeleteCache({
    type: 'deleteCache',
    modelSrc: `registry://${sharded.registrySource}/${sharded.registryPath}`
  })
  t.is(deletion.success, false, 'deletion is refused')
  t.ok(fs.existsSync(registryShard), 'the shard in the writable folder is untouched')
})

test('downloadModelFromHttp: an archive download holds its lock until the archive is written', async (t) => {
  useTestCacheDir()
  const server = await startGatedServer()
  const url = `${server.base}/archive-${Math.random().toString(16).slice(2)}/model.tar`
  const hash = generateShortHash(url)
  t.teardown(async () => {
    await server.close()
    fs.rmSync(getShardedModelCacheDir(hash), { recursive: true, force: true })
  })

  const download = downloadModelFromHttp(url).catch((error: unknown) => error)
  await waitUntil(() => server.halfSent())
  const lock = await tryAcquireDownloadLocks([`http-archive:${hash}`])
  t.is(lock, null, 'the lock is held while the archive downloads')
  await lock?.[Symbol.asyncDispose]()

  server.release()
  t.ok(
    (await download) instanceof Error,
    'the served bytes are not an archive, so extraction fails'
  )
})

test('downloadModelFromHttp: a failed shard stops the other shards before the download fails', async (t) => {
  useTestCacheDir()
  let otherShardStarted = false
  let otherShardClosed = false
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
    if ((req.url ?? '').endsWith('-00001-of-00002.gguf')) {
      // Fail the first shard only once the second one is mid-transfer.
      void waitUntil(() => otherShardStarted).then(() => {
        res.writeHead(404)
        res.end()
      })
      return
    }
    res.on('close', () => {
      otherShardClosed = true
    })
    res.writeHead(200, { 'content-length': String(CONTENT.length) })
    res.write(CONTENT.subarray(0, CONTENT.length / 2))
    otherShardStarted = true
    void gate.then(() => {
      if (!res.destroyed) res.end(CONTENT.subarray(CONTENT.length / 2))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const url = `http://127.0.0.1:${server.address()!.port}/shards-${Math.random().toString(16).slice(2)}/model-00001-of-00002.gguf`
  t.teardown(async () => {
    release()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const { cacheKey } = parsePatternBasedShardUrl(url)
    fs.rmSync(getShardedModelCacheDir(cacheKey), { recursive: true, force: true })
  })

  try {
    await downloadModelFromHttp(url)
    t.fail('a missing shard must fail the download')
  } catch (error) {
    t.ok(error instanceof HTTPError, 'the failed shard error surfaces')
  }
  // Left running, the other shard would keep writing after the lock is released.
  const stopped = await waitUntil(() => otherShardClosed, 2_000).then(
    () => true,
    () => false
  )
  t.ok(stopped, 'the other shard download was stopped')
})

test('downloadModelFromHttp: a sharded download that waited recreates a folder the previous holder cleared', async (t) => {
  useTestCacheDir()
  const server = await startGatedServer()
  const url = `${server.base}/cleared-${Math.random().toString(16).slice(2)}/model-00001-of-00002.gguf`
  const { cacheKey } = parsePatternBasedShardUrl(url)
  t.teardown(async () => {
    await server.close()
    fs.rmSync(getShardedModelCacheDir(cacheKey), { recursive: true, force: true })
  })

  const first = downloadModelFromHttp(url).catch((error: unknown) => error)
  await waitUntil(() => server.halfSent())
  // Cancel with clearCache, which deletes the shard folder, while a second
  // download of the same model waits for the lock.
  cancelTransfer(`http-sharded:${cacheKey}`, true)
  const second = downloadModelFromHttp(url)
  t.ok((await first) instanceof DownloadCancelledError, 'the first download is cancelled')
  server.release()

  const firstShard = await second.catch((error: unknown) => error)
  t.is(typeof firstShard, 'string', `the waiting download completes ${String(firstShard)}`)
  if (typeof firstShard !== 'string') return
  t.ok(bytesEqual(fs.readFileSync(firstShard) as Buffer, CONTENT), 'the shard is intact')
})

test('downloadModelFromHttp: a cancelled download releases its lock only after its last write lands', async (t) => {
  const cacheDir = useTestCacheDir()
  const server = await startGatedServer()
  const url = `${server.base}/slow-write-${Math.random().toString(16).slice(2)}.gguf`
  const key = createHttpDownloadKey(url)
  const partialWrites = slowPartialWrites(t)
  t.teardown(async () => {
    await server.close()
    const modelPath = cachedHttpPath(cacheDir, url, url.split('/').pop()!)
    fs.rmSync(partialDownloadPath(modelPath), { force: true })
  })

  const download = downloadModelFromHttp(url).catch((error: unknown) => error)
  await waitUntil(() => server.halfSent())
  cancelTransfer(key)

  let lock: AsyncDisposable | null = null
  for (let i = 0; i < 500 && !lock; i++) {
    lock = await tryAcquireDownloadLocks([key])
    if (!lock) await sleep(5)
  }
  t.ok(lock, 'the cancelled download releases its lock')
  t.ok(partialWrites.closed(), 'its partial file was closed before the lock was released')
  await lock?.[Symbol.asyncDispose]()
  t.ok((await download) instanceof DownloadCancelledError, 'the download is cancelled')
})

test('downloadAndValidateFile: a cancelled Hyperdrive download returns only after its last write lands', async (t) => {
  const dir = makeTempDir('hyperdrive-cancel')
  const store = new Corestore(path.join(dir, 'store'))
  const drive = new Hyperdrive(store)
  await drive.ready()
  // The engine's Hyperdrive typings cover reads only.
  await (drive as unknown as { put(name: string, data: Buffer): Promise<void> }).put(
    '/model.gguf',
    CONTENT
  )
  const partialWrites = slowPartialWrites(t)
  t.teardown(async () => {
    await drive.close()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // A seeded download leaves its drive open, so its caller releases the lock as soon as this returns.
  const targetPath = path.join(dir, 'model.gguf')
  const controller = new AbortController()
  const download = downloadAndValidateFile(
    drive,
    'model.gguf',
    targetPath,
    0,
    '',
    undefined,
    controller.signal
  ).then(
    () => null,
    (error: unknown) => ({ error, closed: partialWrites.closed() })
  )
  await waitUntil(() => fs.existsSync(partialDownloadPath(targetPath)))
  controller.abort(undefined)

  const result = await download
  t.ok(result?.error instanceof DownloadCancelledError, 'the download is cancelled')
  t.ok(result?.closed, 'its partial file was closed before it returned')
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

// A registry client download that writes a partial file and, once cancelled,
// takes a moment to clear what it stored, as the real client does.
function slowCancellingDownload(cleanupMs = 200): {
  cleanedUp: () => boolean
  download: (...args: unknown[]) => Promise<void>
} {
  let cleanedUp = false
  return {
    cleanedUp: () => cleanedUp,
    download: async (...args: unknown[]) => {
      const { outputFile, signal } = args[args.length - 1] as {
        outputFile: string
        signal: { aborted: boolean; addEventListener(type: 'abort', fn: () => void): void }
      }
      fs.writeFileSync(outputFile, 'partial bytes')
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve)
      })
      await sleep(cleanupMs)
      cleanedUp = true
      throw new DownloadCancelledError()
    }
  }
}

async function deleteRightAfterCancel(
  t: ReturnType<typeof test>,
  retryBeforeDelete: boolean
): Promise<void> {
  useTestCacheDir()
  const stopping = slowCancellingDownload()
  let clearedAfterCleanup: boolean | undefined
  stubClient(t, {
    downloadModel: stopping.download,
    downloadBlob: stopping.download,
    clearBlob: async () => {
      clearedAfterCleanup ??= stopping.cleanedUp()
    }
  })
  const { registryPath, registrySource } = QWEN3_600M_INST_Q4
  const key = createRegistryDownloadKey(registrySource, registryPath)
  const partialPath = partialDownloadPath(getSingleFileCachePath(registryPath))
  t.teardown(() => fs.rmSync(partialPath, { force: true }))

  const download = downloadModelFromRegistry(registryPath, registrySource).catch(
    (error: unknown) => error
  )
  await waitUntil(() => fs.existsSync(partialPath))
  cancelTransfer(key)
  t.ok((await download) instanceof DownloadCancelledError, 'the cancel settles the caller at once')

  if (retryBeforeDelete) {
    // The retry replaces the cancelled download in this process's transfer list.
    const retry = downloadModelFromRegistry(registryPath, registrySource).catch(
      (error: unknown) => error
    )
    cancelTransfer(key)
    t.ok((await retry) instanceof DownloadCancelledError, 'the retry is cancelled too')
  }
  t.absent(stopping.cleanedUp(), 'the cancelled download is still cleaning up')

  const response = await handleDeleteCache({
    type: 'deleteCache',
    modelSrc: QWEN3_600M_INST_Q4.src
  })
  t.ok(response.success, `deleteCache succeeds ${response.error ?? ''}`)
  t.is(clearedAfterCleanup, true, 'it deleted only after the cancelled download cleaned up')
  t.absent(fs.existsSync(partialPath), 'the partial file is deleted')
}

test('deleteCache: right after a cancel, waits for the cancelled download to clean up', (t) =>
  deleteRightAfterCancel(t, false))

test('deleteCache: waits for a cancelled download that a cancelled retry replaced', (t) =>
  deleteRightAfterCancel(t, true))

test('waitForDownloadLocksHere: waits for this process to release a lock, up to a time limit', async (t) => {
  useTestCacheDir()
  const key = `held-here:${Math.random()}`
  const lock = await acquireDownloadLock(key, new AbortController().signal)
  t.ok(holdsDownloadLockHere([key]), 'the lock is known to be held here')
  t.absent(await waitForDownloadLocksHere([key], 50), 'gives up while the lock is still held')

  const released = waitForDownloadLocksHere([key], 5_000)
  await lock[Symbol.asyncDispose]()
  t.ok(await released, 'returns once the lock is released')
  t.absent(holdsDownloadLockHere([key]), 'the lock is no longer held here')
  const again = await tryAcquireDownloadLocks([key])
  t.ok(again, 'the lock can be taken again')
  await again?.[Symbol.asyncDispose]()
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

  // Without the lock the second process would range-resume onto the first
  // one's partial. Waiting for it to start keeps a slow spawn from racing.
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

test('two processes downloading the same registry model into one models directory leave one intact file', async (t) => {
  // Separate SDK homes sharing one models directory, like a TUI next to `qvac sdk serve`.
  const cacheDir = makeTempDir('registry-models')
  const resultDir = makeTempDir('registry-results')
  const gate = path.join(resultDir, 'gate')
  const registryPath = `xproc/${Math.random().toString(16).slice(2)}/model.gguf`
  const first = path.join(resultDir, 'first.json')
  const second = path.join(resultDir, 'second.json')

  const firstChild = startChild(['registry-download', cacheDir, first, registryPath, gate])
  let secondChild: ReturnType<typeof startChild> | undefined
  t.teardown(async () => {
    fs.writeFileSync(gate, '')
    await Promise.all([firstChild.exited, secondChild?.exited])
    for (const result of [first, second]) {
      const home = fs.existsSync(result) ? readResult(result).home : undefined
      if (home) fs.rmSync(home, { recursive: true, force: true })
    }
    fs.rmSync(cacheDir, { recursive: true, force: true })
    fs.rmSync(resultDir, { recursive: true, force: true })
  })
  await waitUntil(() => fs.existsSync(`${first}.half`))

  // Without the lock the second process would rewrite the first one's partial.
  secondChild = startChild(['registry-download', cacheDir, second, registryPath, gate])
  await waitUntil(() => fs.existsSync(`${second}.started`))
  await sleep(1_000)
  t.absent(fs.existsSync(`${second}.half`), 'the second process does not start its own download')
  t.absent(fs.existsSync(second), 'the second process is still waiting for the first')

  fs.writeFileSync(gate, '')
  await Promise.all([firstChild.exited, secondChild.exited])

  const firstResult = readResult(first)
  const secondResult = readResult(second)
  t.ok(firstResult.ok, `the first process succeeds ${firstResult.error ?? ''}`)
  t.ok(secondResult.ok, `the second process succeeds ${secondResult.error ?? ''}`)
  t.is(firstResult.downloads, 1, 'the first process downloads the model')
  t.is(secondResult.downloads, 0, 'the second process finds the finished file in the cache')
  t.is(secondResult.path, firstResult.path, 'both processes use the same cached file')

  const modelPath = firstResult.path
  if (!modelPath) return
  t.ok(bytesEqual(fs.readFileSync(modelPath) as Buffer, CONTENT), 'the cached file is intact')
  t.absent(fs.existsSync(partialDownloadPath(modelPath)), 'no partial file is left behind')
})

test('downloadModelFromHyperdrive: waits for another process, never exposes a partial file, then publishes', async (t) => {
  const cacheDir = useTestCacheDir()
  const resultDir = makeTempDir('hyperdrive')
  const resultFile = path.join(resultDir, 'result.json')
  useTempSdkHome(t)

  // The drive's blocks are already in this home's corestore, so no peer is needed.
  const seedDir = path.join(resultDir, 'seed-store')
  const store = new Corestore(seedDir)
  const drive = new Hyperdrive(store)
  await drive.ready()
  // The engine's Hyperdrive typings cover reads only.
  await (drive as unknown as { put(name: string, data: Buffer): Promise<void> }).put(
    '/model.gguf',
    CONTENT
  )
  const driveKey = drive.key.toString('hex')
  await drive.close()
  await store.close()
  fs.mkdirSync(path.dirname(getQvacPath('corestore', driveKey)), { recursive: true })
  fs.renameSync(seedDir, getQvacPath('corestore', driveKey))

  const modelPath = path.join(cacheDir, `${generateShortHash(`${driveKey}/model.gguf`)}_model.gguf`)
  const { exited } = startChild([
    'hold-lock',
    cacheDir,
    resultFile,
    createHyperdriveDownloadKey(driveKey, 'model.gguf'),
    '1500'
  ])
  t.teardown(async () => {
    await exited
    fs.rmSync(modelPath, { force: true })
    fs.rmSync(resultDir, { recursive: true, force: true })
  })
  await waitUntil(() => fs.existsSync(resultFile))

  let settled = false
  const download = downloadModelFromHyperdrive(driveKey, 'model.gguf').finally(() => {
    settled = true
  })
  await sleep(500)
  t.absent(settled, 'the download waits while another process holds its lock')
  t.absent(fs.existsSync(modelPath), 'nothing is written at the model path while waiting')
  t.absent(
    fs.existsSync(partialDownloadPath(modelPath)),
    'no partial file is started while waiting'
  )

  t.is(await download, modelPath, 'the download completes once the other process exits')
  t.ok(bytesEqual(fs.readFileSync(modelPath) as Buffer, CONTENT), 'the published file is complete')
  t.absent(fs.existsSync(partialDownloadPath(modelPath)), 'the partial file was moved into place')
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
  // Linux file timestamps are coarse; wait so the rewrite gets a new one.
  await sleep(20)
  fs.writeFileSync(to, changed)
  t.is(
    await calculateCachedFileChecksum(to),
    await calculateFileChecksum(to),
    'a later change to the destination is re-hashed'
  )
})
