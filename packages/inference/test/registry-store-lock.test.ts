import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { spawn, type Subprocess } from 'bare-subprocess'
import { AbortController } from 'bare-abort-controller'
import { QVACRegistryClient } from '@qvac/registry-client'
import {
  acquireRegistryClient,
  closeRegistryClient,
  hasActiveRegistryClient
} from '@/runtime/registry-client'
import { handleModelRegistrySearch } from '@/handlers/registry'
import { fetchFitStub } from '@/model-fit/description/fetch'
import { resolveRegistryModel } from '@/handlers/load-model/resolve'
import { downloadModelFromRegistry } from '@/handlers/load-model/registry'
import type { ResolveResult } from '@/handlers/load-model/types'
import { models, type RegistryItem } from '@/models/registry/models'
import { getRequestRegistry } from '@/runtime/index'
import { getRuntimeContext } from '@/runtime/state'
import { getSingleFileCachePath } from '@/utils/cache/paths'
import { measureChecksum } from '@/utils/checksum'
import { getLifecycleState, resumeRuntime, suspendRuntime } from '@/runtime/runtime-lifecycle'
import {
  DownloadCancelledError,
  InferenceCancelledError,
  ModelRegistryBusyError
} from '@/errors/index'
import {
  TEST_TIMINGS,
  holdMarker,
  holdStore,
  makeTempHome,
  tryOpenStoreOnce,
  useRegistryHome
} from './fixtures/registry-store'

// Processes on one machine share the registry store, which only one of them
// can have open at a time. Each takes it per operation and hands it over.

// Captured at load: useRegistryHome replaces Bare.argv during a test.
const BARE = Bare.argv[0] ?? 'bare'
// The suite runs from the package root, so the compiled child sits here.
const CHILD_SCRIPT = path.resolve(os.cwd(), 'test/dist/test/fixtures/registry-store-child.js')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await sleep(20)
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true)
  )
  return () => settled
}

// A client call that stays pending until the test opens it.
interface Gate {
  call: () => Promise<unknown>
  started: () => boolean
  open: () => void
}

function gate(value: unknown): Gate {
  let open = () => {}
  let started = false
  const promise = new Promise<unknown>((resolve) => {
    open = () => resolve(value)
  })
  return {
    call: () => {
      started = true
      return promise
    },
    started: () => started,
    open
  }
}

function stubClientMethod(
  t: { teardown(fn: () => void): void },
  name: string,
  impl: () => Promise<unknown>
): void {
  const proto = QVACRegistryClient.prototype as unknown as Record<string, unknown>
  const original = proto[name]
  proto[name] = impl
  t.teardown(() => {
    proto[name] = original
  })
}

function setup(
  t: { teardown(fn: () => Promise<void>): void },
  label: string,
  timings = TEST_TIMINGS
): string {
  const home = makeTempHome(label)
  const restore = useRegistryHome(home, timings)
  t.teardown(async () => {
    await restore()
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

interface ChildResult {
  ok: boolean
  holding?: boolean
  releasedAt?: number
  leases?: number
  endedAt?: number
  error?: string
}

function readResult(file: string): ChildResult | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8') as unknown as string) as ChildResult
  } catch {
    return null
  }
}

function startChild(
  t: { teardown(fn: () => void): void },
  args: string[]
): { child: Subprocess; exited: Promise<void> } {
  const child = spawn(BARE, [CHILD_SCRIPT, ...args], { stdio: ['ignore', 'ignore', 'inherit'] })
  let running = true
  const exited = new Promise<void>((resolve) =>
    child.on('exit', () => {
      running = false
      resolve()
    })
  )
  t.teardown(() => {
    if (running) child.kill()
  })
  return { child, exited }
}

// ---------- One process ----------

test('a lease reuses the open store, which closes once the grace period passes', async (t) => {
  setup(t, 'reuse')

  const first = await acquireRegistryClient({ wait: 'query' })
  const client = first.client
  await first[Symbol.asyncDispose]()

  const second = await acquireRegistryClient({ wait: 'query' })
  t.is(second.client, client, 'a lease inside the grace period reuses the store')
  await second[Symbol.asyncDispose]()
  t.ok(hasActiveRegistryClient(), 'the store stays open during the grace period')

  await waitUntil(() => !hasActiveRegistryClient(), TEST_TIMINGS.graceMs * 5)
  await sleep(50)
  const other = await tryOpenStoreOnce()
  t.ok(other, 'another process can open the store once it closed')
  await other?.release()
})

test('behind a holder on this version, a query gives up and a download keeps waiting', async (t) => {
  setup(t, 'current')
  const holder = await holdStore({ asCurrent: true })

  const busy = await rejection(acquireRegistryClient({ wait: 'query' }))
  t.ok(busy instanceof ModelRegistryBusyError, 'a query rejects with ModelRegistryBusyError')
  const typed = busy as ModelRegistryBusyError
  t.is(typed.code, 53952)
  t.is(typed.holder, 'current')
  t.ok(typed.waitedMs >= TEST_TIMINGS.queryWaitMs, 'after the query wait')
  t.alike(typed.toErrorResponseFields(), { holder: 'current', waitedMs: typed.waitedMs })

  const download = acquireRegistryClient({ wait: 'download' })
  const settled = settledFlag(download)
  await sleep(TEST_TIMINGS.legacyWaitMs + TEST_TIMINGS.queryWaitMs)
  t.absent(settled(), 'a download keeps waiting past both budgets')

  await holder.release()
  const lease = await download
  t.ok(lease.client, 'the download gets the store once the holder releases it')
  await lease[Symbol.asyncDispose]()
})

test('behind an older SDK that keeps the store, a download gives up with holder legacy', async (t) => {
  setup(t, 'legacy')
  const holder = await holdStore()
  t.teardown(() => holder.release())

  const busy = await rejection(acquireRegistryClient({ wait: 'download' }))
  t.ok(busy instanceof ModelRegistryBusyError)
  const typed = busy as ModelRegistryBusyError
  t.is(typed.holder, 'legacy')
  t.ok(typed.waitedMs >= TEST_TIMINGS.legacyWaitMs, 'after the legacy wait')
  t.ok(typed.waitedMs < TEST_TIMINGS.queryWaitMs + 1000, 'without waiting for the download')
  t.ok(/older SDK/.test(typed.message), 'the message names the cause')
})

test('a process on this version still opening the store is not taken for an older SDK', async (t) => {
  setup(t, 'opening')
  // Held before the store is locked, through a cold open's network sync.
  const opening = holdMarker('lease', false)

  const download = acquireRegistryClient({ wait: 'download' })
  const settled = settledFlag(download)
  await sleep(TEST_TIMINGS.legacyWaitMs + 300)
  t.absent(settled(), 'keeps waiting past the legacy wait')

  await opening.release()
  const lease = await download
  t.ok(lease.client, 'and opens the store once the other process lets go')
  await lease[Symbol.asyncDispose]()
})

test('aborting a wait rejects promptly with the caller error', async (t) => {
  setup(t, 'abort')
  const holder = await holdStore({ asCurrent: true })
  t.teardown(() => holder.release())

  const ac = new AbortController()
  const wait = acquireRegistryClient({
    wait: 'download',
    signal: ac.signal,
    cancelled: () => new Error('stopped by the caller')
  })
  await sleep(100)
  const abortedAt = Date.now()
  ac.abort(undefined)
  const error = await rejection(wait)
  t.is(error.message, 'stopped by the caller')
  t.ok(Date.now() - abortedAt < 200, 'without waiting for the next poll to finish')

  const already = await rejection(acquireRegistryClient({ wait: 'download', signal: ac.signal }))
  t.ok(already instanceof DownloadCancelledError, 'an aborted signal rejects at once')
})

test('closing the engine rejects waiting leases', async (t) => {
  setup(t, 'shutdown')
  const holder = await holdStore({ asCurrent: true })
  t.teardown(() => holder.release())

  const wait = acquireRegistryClient({ wait: 'download', cancelled: () => new Error('closed') })
  await sleep(50)
  await closeRegistryClient()
  t.is((await rejection(wait)).message, 'closed')
})

test('hands the store over between leases while another process waits', async (t) => {
  // A long grace period: only the waiting process can explain an early close.
  setup(t, 'yield', { ...TEST_TIMINGS, graceMs: 30_000 })

  const first = await acquireRegistryClient({ wait: 'query' })
  const waiting = holdMarker('waiting', true)
  await sleep(TEST_TIMINGS.pollMs * 4)

  const next = acquireRegistryClient({ wait: 'download' })
  const settled = settledFlag(next)
  await sleep(100)
  t.absent(settled(), 'a new lease waits while another process is owed the store')

  await first[Symbol.asyncDispose]()
  await waitUntil(() => !hasActiveRegistryClient(), 1000)
  t.pass('the store closes as soon as the last lease ends')

  await waiting.release()
  const lease = await next
  t.not(lease.client, first.client, 'the waiting lease reopens the store')
  await lease[Symbol.asyncDispose]()
})

test('a lease lasts until the registry work it covers finishes', async (t) => {
  // Another process waits throughout, so the store closes as soon as no lease is
  // held; the long grace period rules out any other reason to close.
  const home = setup(t, 'lease-scope', { ...TEST_TIMINGS, graceMs: 30_000 })
  const waiting = holdMarker('waiting', true)
  t.teardown(() => waiting.release())

  async function heldUntilDone(label: string, call: Gate, run: Promise<unknown>): Promise<void> {
    await waitUntil(call.started)
    await sleep(TEST_TIMINGS.pollMs * 4)
    t.ok(hasActiveRegistryClient(), `${label}: the store stays open while the call runs`)
    call.open()
    await run
    await waitUntil(() => !hasActiveRegistryClient(), 1000)
  }

  const search = gate([])
  stubClientMethod(t, 'findBy', search.call)
  await heldUntilDone('search', search, handleModelRegistrySearch({ type: 'modelRegistrySearch' }))

  const lookup = gate(null)
  const blob = gate(undefined)
  const entry = { fitBlobBinding: { sha256: 'a'.repeat(64), byteLength: 1 } }
  let lookups = 0
  stubClientMethod(t, 'getModel', () => (lookups++ === 0 ? lookup.call() : Promise.resolve(entry)))
  stubClientMethod(t, 'downloadBlob', blob.call)
  const ref = {
    name: 'model.gguf',
    sha256Checksum: 'b'.repeat(64),
    registryPath: 'm/model.gguf',
    registrySource: 's3'
  }
  const options = { cacheDir: path.join(home, 'fit-stubs') }
  await heldUntilDone('fit stub lookup', lookup, fetchFitStub(ref, options))
  await heldUntilDone('fit stub download', blob, fetchFitStub(ref, options))
})

test('a lease queued behind a handover keeps its deadline, and goes ahead once nobody waits', async (t) => {
  setup(t, 'queued', { ...TEST_TIMINGS, graceMs: 30_000 })
  const download = await acquireRegistryClient({ wait: 'download' })
  const waiting = holdMarker('waiting', true)
  await sleep(TEST_TIMINGS.pollMs * 4)

  const busy = await rejection(acquireRegistryClient({ wait: 'query' }))
  t.ok(busy instanceof ModelRegistryBusyError, 'a query queued behind the handover gives up')
  const typed = busy as ModelRegistryBusyError
  t.is(typed.holder, 'current')
  t.ok(/next in line/.test(typed.message), 'the message covers a process owed the store next')
  t.ok(typed.waitedMs >= TEST_TIMINGS.queryWaitMs, 'after the query wait')
  t.ok(typed.waitedMs < TEST_TIMINGS.queryWaitMs + 500, 'not after the download ends')
  t.ok(hasActiveRegistryClient(), 'while the download keeps the store')

  const next = acquireRegistryClient({ wait: 'download' })
  const settled = settledFlag(next)
  await sleep(TEST_TIMINGS.pollMs * 4)
  t.absent(settled(), 'a queued download keeps waiting for the handover')

  await waiting.release()
  const lease = await next
  t.is(
    lease.client,
    download.client,
    'and shares the open store once the other process stops waiting'
  )
  await lease[Symbol.asyncDispose]()
  await download[Symbol.asyncDispose]()
})

test('a cache-status lookup gives up soon behind another holder', async (t) => {
  setup(t, 'status')
  const holder = await holdStore({ asCurrent: true })
  t.teardown(() => holder.release())

  const busy = await rejection(acquireRegistryClient({ wait: 'status' }))
  t.ok(busy instanceof ModelRegistryBusyError)
  const waited = (busy as ModelRegistryBusyError).waitedMs
  t.ok(waited >= TEST_TIMINGS.statusWaitMs, 'after the status wait')
  t.ok(waited < TEST_TIMINGS.queryWaitMs, `well before a query would give up (${waited}ms)`)
})

test('suspending closes an idle store, and nothing opens one until the runtime resumes', async (t) => {
  setup(t, 'suspend-idle', { ...TEST_TIMINGS, graceMs: 30_000 })
  t.teardown(() => resumeRuntime())
  const first = await acquireRegistryClient({ wait: 'query' })
  await first[Symbol.asyncDispose]()

  await suspendRuntime()
  t.absent(hasActiveRegistryClient(), 'the idle store is closed rather than suspended')
  const other = await tryOpenStoreOnce()
  t.ok(other, 'another process can use the store meanwhile')
  await other?.release()

  const next = acquireRegistryClient({ wait: 'download' })
  const settled = settledFlag(next)
  await sleep(TEST_TIMINGS.pollMs * 6)
  t.absent(settled() || hasActiveRegistryClient(), 'nothing opens the store while suspended')

  await resumeRuntime()
  const lease = await next
  t.ok(lease.client, 'the wait opens the store once the runtime resumes')
  await lease[Symbol.asyncDispose]()
})

test('a store with a lease in flight is suspended with it, and resumes', async (t) => {
  setup(t, 'suspend-busy')
  t.teardown(() => resumeRuntime())
  const lease = await acquireRegistryClient({ wait: 'download' })

  await suspendRuntime()
  t.ok(hasActiveRegistryClient(), 'the store is not closed under the lease')
  await resumeRuntime()
  t.is(getLifecycleState(), 'active', 'and resumes with the runtime')

  const again = await acquireRegistryClient({ wait: 'query' })
  t.is(again.client, lease.client, 'the same store serves leases after the resume')
  await again[Symbol.asyncDispose]()
  await lease[Symbol.asyncDispose]()
})

test('a failed open releases the store instead of taking itself for another process', async (t) => {
  setup(t, 'failed-open')
  const proto = QVACRegistryClient.prototype as unknown as Record<string, unknown>
  const opensStore = proto['_open']
  // The store opens and locks, then the registry view fails to sync.
  proto['_open'] = async function (this: { corestore: { ready(): Promise<void> } }) {
    await this.corestore.ready()
    throw new Error('registry view did not sync')
  }
  try {
    const error = await rejection(acquireRegistryClient({ wait: 'query' }))
    t.is(error.message, 'registry view did not sync', 'the open error reaches the caller')
  } finally {
    proto['_open'] = opensStore
  }

  const other = await tryOpenStoreOnce()
  t.ok(other, 'the half-open store released its lock')
  await other?.release()
})

test('registry search passes the busy error through and stops on cancel', async (t) => {
  setup(t, 'handler')
  const holder = await holdStore()
  t.teardown(() => holder.release())

  const busy = await rejection(handleModelRegistrySearch({ type: 'modelRegistrySearch' }))
  t.ok(busy instanceof ModelRegistryBusyError, 'not wrapped as QVAC_MODEL_REGISTRY_QUERY_FAILED')

  const search = handleModelRegistrySearch({
    type: 'modelRegistrySearch',
    requestId: 'registry-wait-cancel'
  })
  await sleep(100)
  t.is(getRequestRegistry().cancel({ requestId: 'registry-wait-cancel' }), 1)
  const cancelled = await rejection(search)
  t.ok(cancelled instanceof InferenceCancelledError, 'cancel({ requestId }) stops the wait')
})

test('a busy registry falls back to fallbackSrc, and otherwise passes through', async (t) => {
  const busy = new ModelRegistryBusyError('legacy', 30_000)
  const fallback: ResolveResult = { path: '/models/fallback.gguf', sourceType: 'http' }
  const params = {
    isKnownModel: true,
    downloadPrimary: () => Promise.reject(busy),
    resolveFallback: () => Promise.resolve(fallback),
    buildUnreachableError: () => new Error('unreachable on this network')
  }

  t.is(await rejection(resolveRegistryModel({ ...params, hasFallback: false })), busy)
  t.is((await resolveRegistryModel({ ...params, hasFallback: true })).path, fallback.path)
})

test('a cached GGUF loads when the optional Core ML lookup finds the registry busy', async (t) => {
  setup(t, 'coreml-cached')
  const context = getRuntimeContext()
  const platform = context.platform
  context.platform = 'darwin'
  t.teardown(() => {
    context.platform = platform
  })

  // A Core ML model whose GGUF an earlier load cached without the sidecars.
  const registryPath =
    'qvac_models_compiled/ggml/parakeet/registry-lock-test/parakeet-tdt-0.6b-v3.q8_0.gguf'
  const ggufPath = getSingleFileCachePath(registryPath)
  fs.mkdirSync(path.dirname(ggufPath), { recursive: true })
  fs.writeFileSync(ggufPath, 'gguf')
  const model: RegistryItem = {
    name: 'TEST_PARAKEET_COREML',
    registryPath,
    registrySource: 's3',
    modelId: 'parakeet-tdt-0.6b-v3.q8_0.gguf',
    addon: 'parakeet',
    engine: 'parakeet-transcription',
    quantization: 'q8_0',
    params: '0.6B',
    expectedSize: 4,
    sha256Checksum: await measureChecksum(ggufPath),
    blobCoreKey: 'core-key',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0
  }
  const catalog = models as unknown as RegistryItem[]
  catalog.push(model)
  t.teardown(() => {
    catalog.splice(catalog.indexOf(model), 1)
  })

  const holder = await holdStore()
  t.teardown(() => holder.release())

  t.is(await downloadModelFromRegistry(registryPath, 's3'), ggufPath)
})

// ---------- Two processes ----------

test('a second process gets the store once the first finishes its work', async (t) => {
  const home = setup(t, 'xproc-handover')
  const resultFile = path.join(home, 'child.json')
  // A grace period longer than the test: only the handover can free the store.
  startChild(t, ['hold', home, resultFile, '800', '60000'])
  await waitUntil(() => readResult(resultFile)?.holding === true)

  const lease = await acquireRegistryClient({ wait: 'download' })
  const gotAt = Date.now()
  const releasedAt = readResult(resultFile)?.releasedAt
  t.ok(releasedAt, 'the first process finished first')
  t.ok(gotAt - releasedAt! < 2000, 'and handed the store over while it stayed alive')
  await lease[Symbol.asyncDispose]()
})

test('a busy process hands the store over between its operations', async (t) => {
  const home = setup(t, 'xproc-busy')
  const resultFile = path.join(home, 'child.json')
  const { exited } = startChild(t, ['busy', home, resultFile, '3000'])
  await waitUntil(() => readResult(resultFile)?.holding === true)

  const lease = await acquireRegistryClient({ wait: 'query' })
  t.pass('a query got in within its wait while the other process kept taking leases')
  await sleep(100)
  await lease[Symbol.asyncDispose]()

  await exited
  const result = readResult(resultFile)
  t.ok(result?.ok, result?.error ?? 'the busy process carried on afterwards')
  t.ok((result?.leases ?? 0) > 1)
})

test('a process on an older SDK that keeps the store yields a typed error', async (t) => {
  const home = setup(t, 'xproc-legacy')
  const resultFile = path.join(home, 'child.json')
  startChild(t, ['legacy', home, resultFile, '15000'])
  await waitUntil(() => readResult(resultFile)?.holding === true)

  const busy = await rejection(acquireRegistryClient({ wait: 'download' }))
  t.ok(busy instanceof ModelRegistryBusyError)
  t.is((busy as ModelRegistryBusyError).holder, 'legacy')
})

test('a process on an older SDK gets the store once this one goes idle', async (t) => {
  const home = setup(t, 'xproc-old-waiter')
  const resultFile = path.join(home, 'child.json')
  startChild(t, ['hold', home, resultFile, '200', String(TEST_TIMINGS.graceMs)])
  await waitUntil(() => typeof readResult(resultFile)?.releasedAt === 'number')

  // An older SDK only retries the open; it never signals that it waits.
  const deadline = Date.now() + 10_000
  let opened = await tryOpenStoreOnce()
  while (!opened && Date.now() < deadline) {
    await sleep(50)
    opened = await tryOpenStoreOnce()
  }
  if (!opened) throw new Error('the store never became free')
  const releasedAt = readResult(resultFile)!.releasedAt!
  t.ok(Date.now() - releasedAt < TEST_TIMINGS.graceMs + 2000, 'after the grace period')
  await opened.release()
})
