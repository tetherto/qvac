import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { spawn, type Subprocess } from 'bare-subprocess'
import { AbortController } from 'bare-abort-controller'
import {
  acquireRegistryClient,
  closeRegistryClient,
  hasActiveRegistryClient
} from '@/runtime/registry-client'
import { handleModelRegistrySearch } from '@/handlers/registry'
import { resolveRegistryModel } from '@/handlers/load-model/resolve'
import type { ResolveResult } from '@/handlers/load-model/types'
import { getRequestRegistry } from '@/runtime/index'
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
