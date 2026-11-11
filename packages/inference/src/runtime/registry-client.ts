import fs from 'bare-fs'
import path from 'bare-path'
import fsx from 'fs-native-extensions'
import type { AbortSignal } from 'bare-abort-controller'
import { QVACRegistryClient } from '@qvac/registry-client'
import { getCacheDir } from '@/utils/cache/paths'
import {
  getLifecycleState,
  registerSwarm,
  unregisterSwarm,
  registerCorestore,
  unregisterCorestore
} from '@/runtime/runtime-lifecycle'
import { getEngineLogger } from '@/logging/index'
import { DEFAULT_REGISTRY_CORE_KEY } from '@/constants/index'
import { DownloadCancelledError, ModelRegistryBusyError } from '@/errors/index'

const logger = getEngineLogger()

// The registry store (a Corestore under <home>/.qvac/registry-corestore/<key>)
// takes an exclusive lock on its CORESTORE file for as long as it is open, so
// only one process at a time can use it. Each registry operation holds a lease;
// the store closes a grace period after the last lease ends, and another
// process waiting for it takes its turn.
//
// Two marker files beside the store coordinate processes on this version:
//   <key>.lease    held exclusively while this process has the store open. A
//                  busy store with a free marker is held by an older SDK, which
//                  keeps it until that process exits.
//   <key>.waiting  held shared by every process waiting for the store. The
//                  holder checks it and gives the store up between operations.
// The OS releases every lock when a process exits, so none can go stale.
//
// Waiting polls with non-blocking tryLock calls. A blocking lock would wait on
// a native thread that JS cannot cancel and that keeps Bare.exit() from
// returning (QVAC-18197).

export interface RegistryClientTimings {
  /** How long the store stays open after the last lease ends. */
  graceMs: number
  /** Cross-process poll interval, and how often the holder checks for waiters. */
  pollMs: number
  /** How long a query waits for the store before giving up. */
  queryWaitMs: number
  /** How long any operation waits for an older SDK that holds the store until it exits. */
  legacyWaitMs: number
}

const DEFAULT_TIMINGS: RegistryClientTimings = {
  graceMs: 5_000,
  pollMs: 250,
  queryWaitMs: 60_000,
  legacyWaitMs: 30_000
}

let timings: RegistryClientTimings = { ...DEFAULT_TIMINGS }

/** Test seam: shorten the timings. Called without arguments, restores the defaults. */
export function setRegistryClientTimingsForTest(next: Partial<RegistryClientTimings> = {}): void {
  timings = { ...DEFAULT_TIMINGS, ...next }
}

/**
 * `download` waits for a holder on this SDK version until the caller cancels.
 * `query` gives up after `queryWaitMs`. Both give up after `legacyWaitMs` when
 * the holder is an older SDK.
 */
export type RegistryWait = 'download' | 'query'

export interface AcquireRegistryClientOptions {
  wait: RegistryWait
  /** Aborting stops the wait. A lease already granted is unaffected. */
  signal?: AbortSignal | undefined
  /** The error a cancelled wait rejects with. Defaults to `DownloadCancelledError`. */
  cancelled?: () => Error
}

/**
 * The registry client, held open until disposed. Acquire one per operation and
 * never acquire a second while holding one: while another process waits for the
 * store, new leases wait for this process to hand it over.
 */
export interface RegistryClientLease extends AsyncDisposable {
  readonly client: QVACRegistryClient
}

interface Waiter {
  wait: RegistryWait
  startedAt: number
  cancelled: () => Error
  resolve: (lease: RegistryClientLease) => void
  reject: (error: unknown) => void
  detach: () => void
}

interface OpenStore {
  client: QVACRegistryClient
  leaseMarker: MarkerLock | null
}

interface MarkerLock {
  release(): void
}

type Holder = 'current' | 'legacy'

let store: OpenStore | null = null
let refs = 0
// Bumped on every close, so a lease from an earlier store cannot release a later one.
let generation = 0
let idleSince = 0
// Set while another process waits: new leases wait until the store has been handed over.
let yielding = false
// After handing the store over, the time before this process tries to take it back.
let handoffUntil = 0
let watchTimer: ReturnType<typeof setInterval> | null = null
let opener: Promise<void> | null = null
let wakeOpener: (() => void) | null = null
let closing: Promise<void> | null = null
let shuttingDown = false
const pending = new Set<Waiter>()

function storeDir(): string {
  return getCacheDir(`registry-corestore/${DEFAULT_REGISTRY_CORE_KEY}`)
}

function markerPath(kind: 'lease' | 'waiting'): string {
  return path.join(getCacheDir('registry-corestore'), `${DEFAULT_REGISTRY_CORE_KEY}.${kind}`)
}

function closeFd(fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {}
}

function lockedFd(fd: number): MarkerLock {
  return {
    release() {
      // Unlock before closing: Windows may release a closed handle's lock late.
      try {
        fsx.unlock(fd)
      } catch {}
      closeFd(fd)
    }
  }
}

// `held` while another open file description has a conflicting lock;
// `unavailable` when the marker cannot be opened or locked on this filesystem.
function tryMarker(
  kind: 'lease' | 'waiting',
  shared: boolean
): MarkerLock | 'held' | 'unavailable' {
  let fd: number
  try {
    // Not 'a': Windows refuses to lock a handle opened for append only.
    fd = fs.openSync(markerPath(kind), 'a+')
  } catch (error) {
    logger.debug(`Registry ${kind} marker unavailable`, { error })
    return 'unavailable'
  }
  try {
    if (fsx.tryLock(fd, { shared })) return lockedFd(fd)
    closeFd(fd)
    return 'held'
  } catch (error) {
    closeFd(fd)
    logger.debug(`Registry ${kind} marker cannot be locked`, { error })
    return 'unavailable'
  }
}

function isMarkerHeld(kind: 'lease' | 'waiting'): boolean | null {
  const marker = tryMarker(kind, false)
  if (marker === 'held') return true
  if (marker === 'unavailable') return null
  marker.release()
  return false
}

// Whether another process has the store open. A shared lock answers without
// blocking the holder's reads on Windows, where locks are mandatory. Anything
// inconclusive reports `free` and lets the open attempt decide.
function probeStore(): 'free' | 'busy' {
  let fd: number
  try {
    fd = fs.openSync(path.join(storeDir(), 'CORESTORE'), 'r+')
  } catch {
    return 'free'
  }
  try {
    if (!fsx.tryLock(fd, { shared: true })) return 'busy'
    fsx.unlock(fd)
    return 'free'
  } catch {
    return 'free'
  } finally {
    closeFd(fd)
  }
}

function isFdLockError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('File descriptor could not be locked')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      wakeOpener = null
      resolve()
    }
    wakeOpener = done
  })
}

function lifecycleActive(): boolean {
  return getLifecycleState() === 'active'
}

/**
 * Lease the registry client, opening the store if needed and waiting while
 * another process has it. Rejects with `ModelRegistryBusyError` when the wait
 * runs out, or with `options.cancelled()` when the signal aborts or the engine
 * closes.
 */
export function acquireRegistryClient(
  options: AcquireRegistryClientOptions
): Promise<RegistryClientLease> {
  const cancelled = options.cancelled ?? (() => new DownloadCancelledError())
  const { signal } = options
  if (signal?.aborted || shuttingDown) return Promise.reject(cancelled())
  if (store && !yielding) return Promise.resolve(takeLease(store))

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (!pending.delete(waiter)) return
      waiter.detach()
      reject(cancelled())
      if (pending.size === 0) wakeOpener?.()
    }
    const waiter: Waiter = {
      wait: options.wait,
      startedAt: Date.now(),
      cancelled,
      resolve,
      reject,
      detach: () => signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.add(waiter)
    ensureOpener()
  })
}

function takeLease(open: OpenStore): RegistryClientLease {
  refs++
  const leaseGeneration = generation
  let released = false
  return {
    client: open.client,
    [Symbol.asyncDispose]: async () => {
      if (released) return
      released = true
      if (leaseGeneration !== generation) return
      refs--
      if (refs === 0) {
        idleSince = Date.now()
        check()
      }
    }
  }
}

function admitPending(): void {
  if (!store) return
  for (const waiter of [...pending]) {
    pending.delete(waiter)
    waiter.detach()
    waiter.resolve(takeLease(store))
  }
}

function rejectPending(error: (waiter: Waiter) => unknown): void {
  for (const waiter of [...pending]) {
    pending.delete(waiter)
    waiter.detach()
    waiter.reject(error(waiter))
  }
}

// Runs while the store is open: on every lease release and every poll.
function check(): void {
  if (!store || !lifecycleActive()) return
  const othersWaiting = isMarkerHeld('waiting') === true
  if (refs > 0) {
    if (othersWaiting && !yielding) {
      yielding = true
      logger.info('Another QVAC process is waiting for the model registry; handing it over')
    } else if (!othersWaiting && yielding) {
      // The other process stopped waiting: leases queued for the handover go ahead.
      yielding = false
      admitPending()
    }
    // Leases queued behind the handover keep their deadlines.
    expireWaiters('current', null)
    return
  }
  if (othersWaiting) {
    void closeStore('yield')
    return
  }
  if (yielding) {
    // The other process stopped waiting before this one finished.
    yielding = false
    admitPending()
    if (refs > 0) return
  }
  if (Date.now() - idleSince >= timings.graceMs) void closeStore('idle')
}

function closeStore(reason: 'idle' | 'yield' | 'shutdown'): Promise<void> {
  const open = store!
  store = null
  refs = 0
  generation++
  yielding = false
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = null
  if (reason === 'yield') handoffUntil = Date.now() + 2 * timings.pollMs

  logger.info(`🔌 Closing registry client (${reason})...`)
  const corestore = open.client.corestore
  const hyperswarm = open.client.hyperswarm
  closing = (async () => {
    try {
      await open.client.close()
      logger.info('✅ Registry client closed')
    } catch (error) {
      logger.error(
        '❌ Error closing registry client:',
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      if (corestore) unregisterCorestore(corestore)
      if (hyperswarm) unregisterSwarm(hyperswarm)
      open.leaseMarker?.release()
    }
  })().finally(() => {
    closing = null
    if (pending.size > 0) ensureOpener()
  })
  return closing
}

function ensureOpener(): void {
  if (opener || closing || shuttingDown) return
  if (store) {
    if (!yielding) admitPending()
    return
  }
  opener = openWhenFree()
    .catch((error: unknown) => rejectPending(() => error))
    .finally(() => {
      opener = null
      if (pending.size > 0 && !shuttingDown) ensureOpener()
    })
}

// Held shared while this process waits, so the holder knows to hand the store over.
class WaitingSignal {
  private marker: MarkerLock | null = null

  raise(): void {
    if (this.marker) return
    // Fails for an instant while the holder checks; the next poll retries.
    const marker = tryMarker('waiting', true)
    if (typeof marker !== 'string') this.marker = marker
  }

  lower(): void {
    this.marker?.release()
    this.marker = null
  }
}

async function openWhenFree(): Promise<void> {
  const waiting = new WaitingSignal()
  let legacySince: number | null = null
  let announced = false

  try {
    if (Date.now() < handoffUntil) {
      waiting.raise()
      await sleep(handoffUntil - Date.now())
    }

    while (pending.size > 0 && !shuttingDown) {
      if (probeStore() === 'free') {
        const opened = await tryOpen()
        if (opened) {
          waiting.lower()
          if (shuttingDown) {
            store = opened
            await closeStore('shutdown')
            return
          }
          store = opened
          idleSince = Date.now()
          watchTimer = setInterval(check, timings.pollMs)
          if (announced) logger.info('The model registry is free again; continuing')
          admitPending()
          if (refs === 0) check()
          return
        }
      }

      waiting.raise()
      const holder: Holder = isMarkerHeld('lease') === false ? 'legacy' : 'current'
      if (holder === 'legacy') legacySince ??= Date.now()
      else legacySince = null
      if (!announced) {
        announced = true
        logger.info(
          holder === 'legacy'
            ? '⏳ An older QVAC process holds the model registry until it exits; waiting'
            : '⏳ Another QVAC process is using the model registry; waiting for it to finish'
        )
      }
      expireWaiters(holder, legacySince)
      if (pending.size === 0) return
      await sleep(timings.pollMs)
    }
  } finally {
    waiting.lower()
  }
}

function expireWaiters(holder: Holder, legacySince: number | null): void {
  const now = Date.now()
  for (const waiter of [...pending]) {
    const legacyFor = legacySince === null ? 0 : now - Math.max(legacySince, waiter.startedAt)
    const waited = now - waiter.startedAt
    const expired =
      (holder === 'legacy' && legacyFor >= timings.legacyWaitMs) ||
      (waiter.wait === 'query' && waited >= timings.queryWaitMs)
    if (!expired) continue
    pending.delete(waiter)
    waiter.detach()
    waiter.reject(new ModelRegistryBusyError(holder, waited))
  }
}

// `null` when another process has the store or took it first. The lease marker
// is taken before the store, so the store is never held by this version without
// it, even while a cold open syncs from the network.
async function tryOpen(): Promise<OpenStore | null> {
  const marker = tryMarker('lease', false)
  // Another process on this version has the store, is opening it, or is
  // checking the marker; the next poll looks again.
  if (marker === 'held') return null
  if (marker === 'unavailable') {
    logger.warn(
      'Cannot mark the model registry as held by this version; other processes will treat it as an older SDK'
    )
  }
  const leaseMarker = marker === 'unavailable' ? null : marker

  logger.info('🔗 Creating new registry client...')
  const client = new QVACRegistryClient({
    registryCoreKey: DEFAULT_REGISTRY_CORE_KEY,
    storage: storeDir(),
    corestoreOpts: { wait: false }
  })
  try {
    await client.ready()
  } catch (error) {
    leaseMarker?.release()
    if (isFdLockError(error) || probeStore() === 'busy') {
      logger.debug('Registry store was taken by another process before this one opened it')
      return null
    }
    throw error
  }

  if (client.corestore) {
    registerCorestore(client.corestore, { label: 'registry-client', createdAt: Date.now() })
  }
  if (client.hyperswarm) {
    registerSwarm(client.hyperswarm, { label: 'registry-client', createdAt: Date.now() })
  }
  logger.info('✅ Registry client ready')
  return { client, leaseMarker }
}

/**
 * Close the store and reject every waiting lease. Leases still held are
 * released by the close. Used by engine shutdown.
 */
export async function closeRegistryClient(): Promise<void> {
  shuttingDown = true
  try {
    rejectPending((waiter) => waiter.cancelled())
    wakeOpener?.()
    if (opener) await opener
    if (store) await closeStore('shutdown')
    if (closing) await closing
  } finally {
    shuttingDown = false
    handoffUntil = 0
  }
}

export function hasActiveRegistryClient(): boolean {
  return store !== null
}
