import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import {
  findMatchingCache,
  generateConfigHash,
  getCacheFilePath,
  getCurrentCacheInfo,
  pruneEmptyCacheDirectories,
  renameCacheFile,
  deleteCache as deleteCacheUtil
} from '@/plugins/ops/kv-cache-utils'
import {
  isCachePathWithinDirectory,
  markAutoCacheKey,
  planAutoCacheEvictions,
  removeAutoCacheMarker,
  removeAutoCacheMarkerIfMissing
} from '@/plugins/ops/kv-cache-retention'
import { isMobile } from '@/runtime/state'
import { type CacheMessage, getKVCacheDir } from '@/utils/index'
import {
  logCacheSaveError,
  logCacheStatus
} from '@/plugins/builtin/llamacpp-completion/ops/cache-logger'
import { getEngineLogger } from '@/logging/index'
import type { Logger } from '@/logging/types'
import { type AbortSignal } from 'bare-abort-controller'

// Used by cross-model paths that have no `RequestContext` (e.g.
// `deleteKvCacheState`). Per-session call sites receive a logger from
// the caller — typically `withRequestContext(...)`.
const moduleLogger = getEngineLogger()

/**
 * Coordinates five KV-cache state layers:
 *
 * 1. `cachedPrefixes` — saved message boundaries, and whether a tool
 *    block was rendered into them.
 * 2. `initializedCaches` — caches primed in this process.
 * 3. On-disk `.bin` files written by the addon.
 * 4. `activeCachePaths` — per-path refs that block in-flight eviction.
 * 5. `.auto-cache-<key>` markers — engine-generated cache ownership.
 *
 * Every turn must finish through `commitTurn`, `rollback`, or the
 * non-destructive `releaseTurn` so all inference state stays aligned,
 * the active-path ref is released, and marker metadata follows the
 * cache directory lifecycle.
 */

// ----- module-scoped state. The session is the single mutation point
// for the in-memory KV-cache bookkeeping. -----

/** What the kv-cache file at a given path is known to hold. */
interface CachedPrefix {
  /** Number of chat messages the file on disk is known to cover. */
  messages: number
  /**
   * Whether a static tool block was rendered into that prefix. Tracked
   * rather than inferred from `messages`, because a committed turn is not
   * proof that its tool block reached the model: the addon drops tools and
   * still returns a usable prompt when the chat template rejects them.
   */
  toolBlock: boolean
}

/**
 * What the kv-cache file on disk is known to cover, keyed by cache path.
 * Written by `commitTurn`, read by `getSavedCount`, deleted by `rollback` /
 * `delete` / `dropStaleSavedCount`. The same INVARIANT that existed in
 * `kv-cache-state.ts` still holds: an entry is present only when the
 * corresponding `.bin` file is considered trustworthy. Cancelled or
 * zero-token turns must remove the entry so the next-turn slice doesn't read
 * a stale boundary.
 */
const cachedPrefixes = new Map<string, CachedPrefix>()

/**
 * In-memory registry of caches initialized this session. The addon
 * defers disk writes, so the absence of a `.bin` file on disk isn't
 * proof that the cache hasn't been primed in this process. Keyed
 * by the resolved cache path, so aliased keys that name one file share an
 * entry and on-disk caches from older process runs still hit the lazy-load
 * path in `beginTurn`.
 */
const initializedCaches = new Set<string>()
const activeCachePaths = new Map<string, number>()

const DESKTOP_AUTO_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024
const MOBILE_AUTO_CACHE_MAX_BYTES = 512 * 1024 * 1024
const AUTO_CACHE_MAX_IDLE_MS = 24 * 60 * 60 * 1000
const AUTO_CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000

let lastAutoCacheSweepMs = 0
let autoCacheSweepInFlight: Promise<void> | null = null
let cacheStateLockTail = Promise.resolve()

// Per-path write locks: same file serialises, different files run concurrently.
// FIFO queue so an aborted waiter drops out instead of holding its admission slot.
type CacheLockWaiter = { grant: () => void; drop: (reason: Error) => void }
type CacheLock = { held: boolean; waiters: CacheLockWaiter[] }
const cachePathLocks = new Map<string, CacheLock>()

// Internal sentinel so acquisition paths prune directories/markers only when a
// queued lock wait was aborted, not when lock acquisition failed for another
// reason.
class CacheLockAbortError extends Error {
  constructor(cause?: unknown) {
    super('cache lock wait aborted', cause !== undefined ? { cause } : undefined)
    this.name = 'CacheLockAbortError'
  }
}

// Case-fold the lock-map key so case-only path variants (e.g. "Session" vs
// "session"), which name the SAME file on case-insensitive filesystems (default
// macOS/Windows), serialise on one lock and can't interleave writes. Over-locks
// case-only variants on case-sensitive filesystems, which is safe. NOTE: the
// other per-path bookkeeping (activeCachePaths, cachedPrefixes, retention)
// stays case-sensitive, so case-only key variants are otherwise unsupported —
// see the KV-cache system doc.
function lockKeyFor(cachePath: string): string {
  return cachePath.toLowerCase()
}

function releaseCachePathWriteLock(lockKey: string): void {
  const lock = cachePathLocks.get(lockKey)
  if (!lock) return
  const next = lock.waiters.shift()
  if (next) {
    next.grant()
    return
  }
  lock.held = false
  cachePathLocks.delete(lockKey)
}

// Returns the release fn. Aborting while queued rejects and removes the waiter.
async function acquireCachePathWriteLock(
  cachePath: string,
  signal?: AbortSignal
): Promise<() => void> {
  const lockKey = lockKeyFor(cachePath)
  let lock = cachePathLocks.get(lockKey)
  if (!lock) {
    lock = { held: false, waiters: [] }
    cachePathLocks.set(lockKey, lock)
  }
  if (!lock.held) {
    lock.held = true
    return () => releaseCachePathWriteLock(lockKey)
  }

  await new Promise<void>((resolve, reject) => {
    const waiter: CacheLockWaiter = {
      grant: () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      },
      drop: (reason: Error) => reject(reason)
    }
    const onAbort = () => {
      const index = lock.waiters.indexOf(waiter)
      if (index !== -1) lock.waiters.splice(index, 1)
      waiter.drop(new CacheLockAbortError(signal?.reason))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    lock.waiters.push(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

  return () => releaseCachePathWriteLock(lockKey)
}

function markCachePathActive(cachePath: string): void {
  activeCachePaths.set(cachePath, (activeCachePaths.get(cachePath) ?? 0) + 1)
}

function releaseCachePath(cachePath: string): void {
  const count = activeCachePaths.get(cachePath)
  if (count === undefined) return
  if (count === 1) {
    activeCachePaths.delete(cachePath)
    return
  }
  activeCachePaths.set(cachePath, count - 1)
}

// Paths in-flight turns hold, so pruning skips a directory still in use.
function snapshotActivePaths(): string[] {
  return Array.from(activeCachePaths.keys())
}

function isCacheKeyActive(cacheKey: string): boolean {
  const cacheDirectory = path.join(getKVCacheDir(), cacheKey)
  return Array.from(activeCachePaths.keys()).some((cachePath) =>
    isCachePathWithinDirectory(cacheDirectory, cachePath)
  )
}

function getAutoCacheMaxBytes(): number {
  return isMobile() ? MOBILE_AUTO_CACHE_MAX_BYTES : DESKTOP_AUTO_CACHE_MAX_BYTES
}

async function withCacheStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = cacheStateLockTail
  let releaseLock = () => {}
  cacheStateLockTail = new Promise<void>((resolve) => {
    releaseLock = resolve
  })

  await previous
  try {
    return await operation()
  } finally {
    releaseLock()
  }
}

async function maybeSweepAutoCaches(
  logger: Logger,
  overrides?: {
    force?: boolean
    maxBytes?: number
    maxIdleMs?: number
    nowMs?: number
  }
): Promise<void> {
  const nowMs = overrides?.nowMs ?? Date.now()
  if (autoCacheSweepInFlight !== null) {
    await autoCacheSweepInFlight
    if (!overrides?.force) return
    return maybeSweepAutoCaches(logger, overrides)
  }
  if (!overrides?.force && nowMs - lastAutoCacheSweepMs < AUTO_CACHE_SWEEP_INTERVAL_MS) return

  lastAutoCacheSweepMs = nowMs
  const sweep = async () => {
    try {
      const cacheKeys = await planAutoCacheEvictions({
        activeCachePaths: Array.from(activeCachePaths.keys()),
        maxBytes: overrides?.maxBytes ?? getAutoCacheMaxBytes(),
        maxIdleMs: overrides?.maxIdleMs ?? AUTO_CACHE_MAX_IDLE_MS,
        nowMs
      })
      let evictionCount = 0
      await withCacheStateLock(async () => {
        for (const cacheKey of cacheKeys) {
          if (isCacheKeyActive(cacheKey)) continue
          await deleteKvCacheState({ kvCacheKey: cacheKey })
          evictionCount++
        }
      })
      if (evictionCount > 0) {
        logger.debug(`[kv-cache] Evicted ${evictionCount} inactive auto-cache entries`)
      }
    } catch (error) {
      logger.warn(
        `[kv-cache] Auto-cache retention sweep failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const sweepPromise = sweep()
  autoCacheSweepInFlight = sweepPromise
  try {
    await sweepPromise
  } finally {
    autoCacheSweepInFlight = null
  }
}

function scheduleAutoCacheSweep(logger: Logger): void {
  void maybeSweepAutoCaches(logger).catch((error) => {
    logger.warn(
      `[kv-cache] Failed to schedule auto-cache retention sweep: ${error instanceof Error ? error.message : String(error)}`
    )
  })
}

// ----- public types -----

export interface TurnHandle {
  /** Resolved on-disk cache file path the addon will read from / write to. */
  readonly cachePath: string
  /**
   * Snapshot of the on-disk saved-message count at `beginTurn` time
   * (0 if the cache was just primed). Consumed by `decideCachedHistorySlice`
   * to pick the message tail for the next addon call.
   */
  readonly savedCount: number
  /**
   * Whether the cached prefix already holds a rendered static tool block, so
   * this turn can leave it out of its payload. False on a fresh prime and
   * whenever the previous turn couldn't confirm the block reached the model.
   */
  readonly toolBlockCached: boolean
}

export interface BeginCustomTurnInput {
  kind: 'custom'
  /** User-provided session key (`completion({ kvCache: "session-a" })`). */
  customKey: string
  /** Hash of system prompt + complete tool definitions. */
  configHash: string
  /**
   * Prime the cache by sending the system prompt to the addon. Tools are not
   * primed — a prefix with no user turn is not a renderable conversation for
   * every template — so they travel with a turn instead. Called when the cache
   * doesn't exist in-memory OR on disk. Kept as an injected closure so this
   * module has no dependency on the model registry / addon.
   */
  primeIfMissing: (cachePath: string) => Promise<void>
  /**
   * Request abort signal. When it aborts while this turn is queued behind a
   * same-file peer's write lock, the wait is abandoned so the request's scope
   * unwinds and releases its admission slot instead of blocking on the holder.
   */
  signal?: AbortSignal
}

export interface BeginAutoTurnInput {
  kind: 'auto'
  /** Hash of system prompt + complete tool definitions. */
  configHash: string
  /** Conversation history used to compute the pre-response cache key. */
  history: CacheMessage[]
  /** See `BeginCustomTurnInput.primeIfMissing`. */
  primeIfMissing: (cachePath: string) => Promise<void>
  /** See `BeginCustomTurnInput.signal`. */
  signal?: AbortSignal
}

export type BeginTurnInput = BeginCustomTurnInput | BeginAutoTurnInput

/**
 * Whether the committed prefix holds a rendered static tool block. The
 * handler owns this because only it knows whether the payload carried the
 * block and whether the message list was one the template renders tools for.
 */
interface ToolBlockCommit {
  toolBlockCached: boolean
}

export interface StaticCommitResult extends ToolBlockCommit {
  kind: 'static'
  /** `history.length + 1` — recorded at the turn's current `cachePath`. */
  messageCount: number
}

export interface AutoRenameCommitResult extends ToolBlockCommit {
  kind: 'autoRename'
  /**
   * Destination path the addon's pre-response cache file should be
   * renamed to (computed from `cacheMessages + responseText`). The
   * stale entry at the source path is dropped from `cachedPrefixes`
   * and the new count is recorded at this target path.
   */
  targetCachePath: string
  /** Number of messages the renamed cache represents (`savedHistory.length`). */
  messageCount: number
}

export type CommitResult = StaticCommitResult | AutoRenameCommitResult

export interface KvCacheSession {
  /**
   * Open a new turn against the cache. Resolves the cache file path,
   * primes the system-prompt cache if needed (delegated to
   * `input.primeIfMissing`), marks the cache initialized, and returns a
   * `TurnHandle` the handler attaches to `ctx.scope.defer(...)` for the
   * rollback hook. Auto-cache path resolution is serialized with
   * retention deletion before the handle is returned.
   */
  beginTurn(input: BeginTurnInput): Promise<TurnHandle>

  /**
   * Commit a successful turn — records the new saved-message count,
   * preserves the cache file, and (for auto-cache turns) renames the
   * addon's pre-response file to the post-response path. Flips the
   * turn's internal `committed` flag so the deferred `rollback` becomes
   * a no-op on the happy path.
   */
  commitTurn(turn: TurnHandle, result: CommitResult): Promise<void>

  /**
   * Roll back an in-flight turn — atomically deletes the on-disk cache
   * file, clears the in-memory `initializedCaches` entry, forgets the
   * `cachedPrefixes` entry, releases the active-path ref, and
   * removes orphaned marker metadata. Idempotent: a turn that has
   * already been committed or rolled back is a no-op on subsequent
   * calls. Handlers register this via `ctx.scope.defer(...)` so it
   * runs regardless of how the handler exits (success branch removes
   * itself via `commitTurn`).
   */
  rollback(turn: TurnHandle): Promise<void>
  /**
   * Non-destructive counterpart of `rollback`: a thrown addon overflow or
   * admission refusal never persists the in-flight turn, so the last
   * committed disk cache and its recorded prefix stay valid for the next
   * turn. Releases locks, active-refs, and the deferred retention sweep.
   */
  releaseTurn(turn: TurnHandle): Promise<void>

  /**
   * Forget the in-memory saved-message count for the turn's path
   * without unlinking the file or clearing the init flag. Used when
   * `decideCachedHistorySlice` detects a stale boundary
   * (`clearStaleCount: true`) — the next turn re-sends the full history
   * but the cache itself is still usable.
   */
  dropStaleSavedCount(turn: TurnHandle): void
}

interface InternalTurnState {
  cachePath: string
  autoCacheKey?: string
  /** Request abort signal, so commit's target-lock wait stays abortable. */
  signal?: AbortSignal
  /** Releases this turn's per-cache-path write lock; idempotent. */
  releaseWriteLock: () => void
  /** Flipped by `commitTurn`; consulted at the top of `rollback`. */
  committed: boolean
  /** Flipped at the end of `rollback`; protects against double-rollback. */
  rolledBack: boolean
}

// ----- factory -----

/**
 * Construct a session bound to one `(modelId, turn-owning request)`
 * scope. `options.logger` is the per-instance logger the session emits
 * through (typically `withRequestContext(getEngineLogger(), ctx)`);
 * falls back to the module-scoped logger when omitted.
 */
export function createKvCacheSession(
  modelId: string,
  options?: { logger?: Logger }
): KvCacheSession {
  const logger = options?.logger ?? moduleLogger
  // Per-session map: each `TurnHandle` carries an opaque entry here. A
  // WeakMap so handles drop their state once the handler scope releases
  // the reference; the module-scoped maps above survive.
  const turnState = new WeakMap<TurnHandle, InternalTurnState>()

  function makeHandle(
    cachePath: string,
    autoCacheKey?: string,
    releaseWriteLock: () => void = () => {},
    signal?: AbortSignal
  ): TurnHandle {
    const cached = cachedPrefixes.get(cachePath)
    const handle: TurnHandle = {
      cachePath,
      savedCount: cached?.messages ?? 0,
      toolBlockCached: cached?.toolBlock ?? false
    }
    turnState.set(handle, {
      cachePath,
      ...(autoCacheKey !== undefined && { autoCacheKey }),
      ...(signal !== undefined && { signal }),
      releaseWriteLock,
      committed: false,
      rolledBack: false
    })
    markCachePathActive(cachePath)
    return handle
  }

  async function beginCustom(input: BeginCustomTurnInput): Promise<TurnHandle> {
    const cachePath = await getCacheFilePath(modelId, input.configHash, input.customKey)
    // Held for the whole turn so a same-file peer can't interleave writes.
    // Released on commit/rollback/error; throws if aborted while queued.
    let releaseWriteLock: () => void
    try {
      releaseWriteLock = await acquireCachePathWriteLock(cachePath, input.signal)
    } catch (error) {
      // Aborted while queued: no lock is held to release, and getCacheFilePath
      // already mkdir'd this key's parent (a distinct dir under a case variant),
      // so prune it before the cancellation propagates.
      if (error instanceof CacheLockAbortError) {
        await pruneEmptyCacheDirectories(cachePath, snapshotActivePaths())
      }
      throw error
    }
    // A turn cancelled by the time it holds the lock must not prime (native work).
    // getCacheFilePath already mkdir'd the parent, so prune it before surfacing
    // the cancellation the plugin rides.
    if (input.signal?.aborted) {
      await pruneEmptyCacheDirectories(cachePath, snapshotActivePaths())
      releaseWriteLock()
      throw new CacheLockAbortError(input.signal.reason)
    }
    const handle = makeHandle(cachePath, undefined, releaseWriteLock, input.signal)

    try {
      // In-memory registry check first — the addon defers disk writes, so
      // a freshly-primed cache may not yet exist on disk. If the
      // in-memory flag isn't set, fall back to a filesystem probe so
      // caches surviving across process restarts still hit the reuse path.
      let exists = initializedCaches.has(cachePath)
      if (!exists) {
        try {
          await fsPromises.access(cachePath)
          exists = true
          initializedCaches.add(cachePath)
        } catch {
          exists = false
        }
      }
      logCacheStatus(input.customKey, exists)

      if (!exists) {
        // Recreate the parent dir if a same-key peer's rollback pruned it after our lock wait.
        await fsPromises.mkdir(path.dirname(cachePath), { recursive: true })
        // The access probe / mkdir above yielded, so a cancel may have landed
        // since the acquire-time check — re-check right before native priming.
        // The catch below prunes the directory just created.
        if (input.signal?.aborted) throw new CacheLockAbortError(input.signal.reason)
        await input.primeIfMissing(cachePath)
        await verifyPrimedFile(cachePath, logger)
        initializedCaches.add(cachePath)
      }

      return handle
    } catch (error) {
      releaseCachePath(cachePath)
      await pruneEmptyCacheDirectories(cachePath, snapshotActivePaths())
      releaseWriteLock()
      throw error
    }
  }

  async function beginAuto(input: BeginAutoTurnInput): Promise<TurnHandle> {
    // The path comes from a history lookup, so: discover it, lock it (outside
    // the state lock, or commitTurn's rename could deadlock a waiter), then
    // re-check existence under the lock in case a same-file peer just renamed it.
    const discovered = await withCacheStateLock(async () => {
      const existingCache = await findMatchingCache(modelId, input.configHash, input.history)
      const cacheInfo =
        existingCache ?? (await getCurrentCacheInfo(modelId, input.configHash, input.history))
      return {
        cachePath: cacheInfo.cachePath,
        cacheKey: cacheInfo.cacheKey
      }
    })

    const { cachePath, cacheKey } = discovered
    let releaseWriteLock: () => void
    try {
      releaseWriteLock = await acquireCachePathWriteLock(cachePath, input.signal)
    } catch (error) {
      // Aborted while queued: no lock is held to release. Discovery already
      // mkdir'd the parent and wrote the auto marker; clean both before the
      // cancellation propagates.
      if (error instanceof CacheLockAbortError) {
        await pruneEmptyCacheDirectories(cachePath, snapshotActivePaths())
        await removeAutoCacheMarkerIfMissing(cacheKey)
      }
      throw error
    }
    // A turn cancelled by the time it holds the lock must not prime (native work).
    // Discovery already mkdir'd the parent and wrote the auto marker; clean both
    // before surfacing the cancellation.
    if (input.signal?.aborted) {
      await pruneEmptyCacheDirectories(cachePath, snapshotActivePaths())
      await removeAutoCacheMarkerIfMissing(cacheKey)
      releaseWriteLock()
      throw new CacheLockAbortError(input.signal.reason)
    }

    let handle: TurnHandle
    let cacheExists: boolean
    try {
      const resolved = await withCacheStateLock(async () => {
        // Mark the path active under the state lock so retention can't evict it.
        const h = makeHandle(cachePath, cacheKey, releaseWriteLock, input.signal)
        let exists = initializedCaches.has(cachePath)
        if (!exists) {
          try {
            await fsPromises.access(cachePath)
            exists = true
            initializedCaches.add(cachePath)
          } catch {
            exists = false
          }
        }
        return { h, exists }
      })
      handle = resolved.h
      cacheExists = resolved.exists
    } catch (error) {
      releaseWriteLock()
      throw error
    }

    logCacheStatus('auto', cacheExists)

    try {
      if (!cacheExists) {
        // Recreate the parent dir if a same-file peer's rename pruned it.
        await fsPromises.mkdir(path.dirname(cachePath), { recursive: true })
        // The discovery / mkdir above yielded, so a cancel may have landed since
        // the acquire-time check — re-check right before native priming. The
        // catch below prunes the directory and auto marker.
        if (input.signal?.aborted) throw new CacheLockAbortError(input.signal.reason)
        await input.primeIfMissing(cachePath)
        await verifyPrimedFile(cachePath, logger)
        initializedCaches.add(cachePath)
      }

      return handle
    } catch (error) {
      releaseCachePath(cachePath)
      await pruneEmptyCacheDirectories(cachePath, snapshotActivePaths())
      await removeAutoCacheMarkerIfMissing(cacheKey)
      releaseWriteLock()
      throw error
    }
  }

  async function beginTurn(input: BeginTurnInput): Promise<TurnHandle> {
    if (input.kind === 'custom') return beginCustom(input)
    return beginAuto(input)
  }

  async function commitTurn(turn: TurnHandle, result: CommitResult): Promise<void> {
    const state = turnState.get(turn)
    if (!state) {
      // Handle from a different session or already torn down. Treat as
      // no-op — caller shouldn't be reaching into another session's
      // state, but failing loudly here punishes the rollback-after-end
      // path more than it helps.
      return
    }
    if (state.committed || state.rolledBack) return

    if (result.kind === 'static') {
      // Custom-key path: the addon wrote the new cache state inline
      // at the same path. Verify the file persisted (the addon
      // currently swallows save errors — see TODO in
      // `verifySaveAndRecord`) and record the new boundary.
      const ok = await verifySaveAndRecord(
        state.cachePath,
        result.messageCount,
        result.toolBlockCached
      )
      if (!ok) {
        // The expected save didn't land — treat the turn as a rollback
        // so the next turn re-primes cleanly.
        await runRollback(state)
        return
      }
      state.committed = true
      releaseCachePath(state.cachePath)
      state.releaseWriteLock()
      return
    }

    const sourceCachePath = state.cachePath
    const sourceCacheKey = state.autoCacheKey
    const targetCacheKey = path.basename(path.dirname(path.dirname(result.targetCachePath)))
    // Hold the target's lock across the rename AND commit verification, so a peer
    // resolving to the same file can't observe it before its saved count is
    // published. Abortable: a cancel while waiting for the lock rejects here.
    const releaseTargetLock = await acquireCachePathWriteLock(result.targetCachePath, state.signal)
    try {
      // A cancel that landed while we waited for the target lock must not commit.
      if (state.signal?.aborted) {
        await runRollback(state)
        return
      }

      const renamed = await withCacheStateLock(async () => {
        markCachePathActive(result.targetCachePath)
        try {
          await fsPromises.mkdir(path.dirname(result.targetCachePath), { recursive: true })
          await markAutoCacheKey(targetCacheKey)

          if (!(await renameCacheFile(sourceCachePath, result.targetCachePath))) {
            releaseCachePath(result.targetCachePath)
            await pruneEmptyCacheDirectories(result.targetCachePath, snapshotActivePaths())
            await removeAutoCacheMarkerIfMissing(targetCacheKey)
            return false
          }
        } catch (setupError) {
          // mkdir/markAutoCacheKey/rename threw after the target active-ref was
          // taken: release it (first, so it can't leak) and prune any directory
          // or marker created above, then propagate.
          releaseCachePath(result.targetCachePath)
          await pruneEmptyCacheDirectories(result.targetCachePath, snapshotActivePaths())
          await removeAutoCacheMarkerIfMissing(targetCacheKey)
          throw setupError
        }

        releaseCachePath(sourceCachePath)
        state.cachePath = result.targetCachePath
        state.autoCacheKey = targetCacheKey
        await pruneEmptyCacheDirectories(sourceCachePath, snapshotActivePaths())
        if (sourceCacheKey !== undefined) {
          await removeAutoCacheMarkerIfMissing(sourceCacheKey)
        }
        cachedPrefixes.delete(sourceCachePath)
        // state.cachePath was just reassigned to the target; clear the SOURCE
        // entry, not the freshly-valid target.
        initializedCaches.delete(sourceCachePath)
        return true
      })

      if (!renamed) {
        logger.warn(
          `[kv-cache] Auto cache rename failed; rolling back. from=${sourceCachePath} to=${result.targetCachePath}`
        )
        await runRollback(state)
        return
      }
      const ok = await verifySaveAndRecord(
        result.targetCachePath,
        result.messageCount,
        result.toolBlockCached
      )
      if (!ok) {
        // Rename succeeded but the file isn't where we expected. Roll back via
        // the target path instead of the (now-empty) source.
        await runRollback(state)
        return
      }

      // Successful auto-rename. The handle's `cachePath` field still points at
      // the (now-gone) source path — fine, the handle is committed and won't
      // roll back. Future turns compute fresh paths.
      state.committed = true
      releaseCachePath(state.cachePath)
      state.releaseWriteLock()
      scheduleAutoCacheSweep(logger)
    } finally {
      releaseTargetLock()
    }
  }

  async function rollback(turn: TurnHandle): Promise<void> {
    const state = turnState.get(turn)
    if (!state) return
    if (state.committed || state.rolledBack) return
    await runRollback(state)
  }

  async function releaseTurn(turn: TurnHandle): Promise<void> {
    const state = turnState.get(turn)
    if (!state) return
    if (state.committed || state.rolledBack) return
    releaseCachePath(state.cachePath)
    state.rolledBack = true
    state.releaseWriteLock()
    if (state.autoCacheKey !== undefined) scheduleAutoCacheSweep(logger)
  }

  async function runRollback(state: InternalTurnState): Promise<void> {
    // Order matters only weakly: unlink first so a partial disk-state
    // can't be re-loaded by a sibling turn between the file delete and
    // the in-memory clear. In practice handlers serialise per model;
    // the order is belt-and-suspenders.
    try {
      await fsPromises.unlink(state.cachePath)
    } catch (unlinkError) {
      logger.warn(
        `[kv-cache] Failed to remove cache file during rollback; next turn may load stale KV state. path=${state.cachePath} error=${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`
      )
    }
    // Release before pruning so an empty parent can go; a sibling still holding
    // the path keeps it in the active snapshot and protects the directory.
    releaseCachePath(state.cachePath)
    await pruneEmptyCacheDirectories(state.cachePath, snapshotActivePaths())
    if (state.autoCacheKey !== undefined) {
      await removeAutoCacheMarkerIfMissing(state.autoCacheKey)
    }
    initializedCaches.delete(state.cachePath)
    cachedPrefixes.delete(state.cachePath)
    state.rolledBack = true
    state.releaseWriteLock()
    if (state.autoCacheKey !== undefined) scheduleAutoCacheSweep(logger)
  }

  function dropStaleSavedCount(turn: TurnHandle): void {
    const state = turnState.get(turn)
    if (!state) return
    cachedPrefixes.delete(state.cachePath)
  }

  return {
    beginTurn,
    commitTurn,
    rollback,
    releaseTurn,
    dropStaleSavedCount
  }
}

// ----- module-level administrative API -----

/**
 * Atomically delete every layer of KV-cache state for a
 * `(kvCacheKey, modelId)` pair, or wipe everything. Single entry point
 * — the only mutation point for cross-model state outside of
 * turn-scoped `commitTurn`/`rollback`.
 *
 * Why this isn't a method on `KvCacheSession`: deletes are
 * cross-model (`all: true` has no model; the keyed form has
 * `modelId` optional in the request). A session, by contrast, is
 * created with a *fixed* `modelId` for the duration of a turn. Making
 * delete a method would force callers to materialise an irrelevant
 * session for cross-model administrative cleanups.
 *
 * Layers cleared, in order:
 *   1. On-disk: `deleteCache(...)` removes the matching directory
 *      tree (or wipes and recreates the root for `all: true`).
 *   2. `cachedPrefixes`: prefix-cleanup by the removed directory
 *      so any per-cache count under the deleted tree is forgotten.
 *   3. `initializedCaches`: prefix-cleanup by the same removed
 *      directory, since it is keyed by the resolved cache path.
 *
 * Concurrency with in-flight turns: this delete does not take the
 * per-cache-path write locks, so it races any turn holding a `TurnHandle`
 * for the same key. Deleting a key that is in active use is unsupported.
 * Each individual mutation is idempotent (`unlink` no-ops if missing,
 * `Map.delete` / `Set.delete` no-op on absent keys), but the layers are
 * cleared without a lock, so an interleaving that lands the delete's
 * in-memory cleanup after a concurrent turn has already renamed/committed
 * its file splits state: the file stays on disk while its saved-count and
 * init flag are cleared, so the next turn sees the file, skips priming, and
 * reports `savedCount=0`. Callers must not delete a key that is in active use.
 */
export async function deleteKvCacheState(
  target: { kvCacheKey: string; modelId?: string } | { all: true }
): Promise<void> {
  if ('all' in target) {
    const removed = await deleteCacheUtil({ all: true })
    cachedPrefixes.clear()
    initializedCaches.clear()
    // `removed` is the kv-cache root dir; surfaces it for ops
    // visibility but isn't part of the contract.
    moduleLogger.debug(`[kv-cache] Cleared all caches under ${removed}`)
    return
  }

  const removedPath = await deleteCacheUtil({
    kvCacheKey: target.kvCacheKey,
    ...(target.modelId !== undefined && { modelId: target.modelId })
  })
  if (target.modelId === undefined) {
    // Remove the marker by the root-relative key: an alias like "./<16hex>"
    // still resolves to the canonical auto key, while a nested key such as
    // "tenant/<16hex>" stays distinct — path.basename would wrongly collapse it
    // onto the unrelated top-level auto marker.
    await removeAutoCacheMarker(path.relative(getKVCacheDir(), removedPath))
  }

  // Prefix-cleanup the in-memory counts. The on-disk directory tree
  // is `{kvCacheRoot}/{kvCacheKey}[/{modelId}]/`, so every entry in
  // `cachedPrefixes` whose key is the removed directory itself
  // or sits beneath it must go.
  clearCachedMessageCountsByPrefix(removedPath, path.sep)

  // initializedCaches is keyed by the resolved cachePath too, so clear it by
  // the same removed-directory prefix as cachedPrefixes above.
  clearInitializedCachesByPrefix(removedPath, path.sep)
}

// ----- private helpers -----

/**
 * Verify that the addon actually persisted a usable cache file after a
 * prime. Mirrors the `verifySaveAndRecord` access-probe used at commit
 * time, applied at prime time so the session doesn't mark a cache
 * `initializedCaches.add(...)` against a path that's missing or empty
 * on disk.
 *
 * Failure modes this catches:
 *
 *   - The addon's `model.run({ saveSessionPath })` was interrupted
 *     before the save call ran (e.g. signal abort during prefill); the
 *     prime closure resolves cleanly because addon save errors are not
 *     propagated, but no file is on disk.
 *   - The addon's `llama_state_save_file` was called but produced an
 *     empty file (out-of-space / fs error swallowed by the addon).
 *
 * Failure modes this does **NOT** catch:
 *
 *   - A partial-but-nonzero file written by the addon (e.g. header +
 *     truncated KV state). Catching this requires either an
 *     addon-side change (have `CacheManager::writeCacheFile` check the
 *     return value of `llama_state_save_file` and throw on failure) or
 *     a structural hash check we can't currently compute
 *     engine-side. Filed as a follow-up — see `cache-api.md` in the addon
 *     repo / tracking ticket.
 *
 * On failure we best-effort `unlink` an empty leftover file (so the
 * next existence probe doesn't trust it) and throw — the handler in
 * `completion-stream.ts` lets the error propagate up and no
 * `initializedCaches` entry is recorded.
 */
async function verifyPrimedFile(cachePath: string, logger: Logger): Promise<void> {
  let stats: { size: number }
  try {
    stats = await fsPromises.stat(cachePath)
  } catch (statError) {
    // ENOENT is the common case here — addon prime returned without
    // calling save (most often: signal abort during prefill).
    await pruneEmptyCacheDirectories(cachePath, snapshotActivePaths())
    throw new Error(
      `[kv-cache] prime closure resolved but no cache file was written. path=${cachePath} cause=${statError instanceof Error ? statError.message : String(statError)}`
    )
  }
  if (stats.size === 0) {
    // Best-effort cleanup so a future probe doesn't trust the empty
    // file. Unlink failure is non-fatal — we still throw on the
    // primary "prime didn't persist" condition.
    try {
      await fsPromises.unlink(cachePath)
      await pruneEmptyCacheDirectories(cachePath, snapshotActivePaths())
    } catch (unlinkError) {
      logger.warn(
        `[kv-cache] Failed to remove empty primed cache file. path=${cachePath} error=${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`
      )
    }
    throw new Error(`[kv-cache] prime closure resolved but cache file is empty. path=${cachePath}`)
  }
}

/**
 * Verify the addon actually persisted the cache file before recording
 * its message count. The addon currently swallows write errors
 * silently, so a missing file means the next turn must resend the full
 * history rather than slicing against a stale `savedCount`.
 *
 * TODO: once the addon surfaces save failures (e.g. throws
 * `UnableToSaveSessionFile` when `llama_state_save_file` returns
 * false), drop the `access()` probe and wrap the `model.run()` call in
 * a real try/catch that forwards the error.
 */
async function verifySaveAndRecord(
  cachePath: string,
  messageCount: number,
  toolBlockCached: boolean
): Promise<boolean> {
  try {
    await fsPromises.access(cachePath)
    cachedPrefixes.set(cachePath, { messages: messageCount, toolBlock: toolBlockCached })
    return true
  } catch (err) {
    cachedPrefixes.delete(cachePath)
    logCacheSaveError(cachePath, err)
    return false
  }
}

function clearCachedMessageCountsByPrefix(prefix: string, sep: string): void {
  if (!prefix) {
    cachedPrefixes.clear()
    return
  }
  for (const key of cachedPrefixes.keys()) {
    if (key === prefix) {
      cachedPrefixes.delete(key)
      continue
    }
    if (!key.startsWith(prefix + sep)) continue
    cachedPrefixes.delete(key)
  }
}

function clearInitializedCachesByPrefix(prefix: string, sep: string): void {
  if (!prefix) {
    initializedCaches.clear()
    return
  }
  for (const key of initializedCaches) {
    if (key === prefix || key.startsWith(prefix + sep)) initializedCaches.delete(key)
  }
}

// ----- test-only escape hatches -----

/**
 * Test-only access to the module-scoped state. Production code reaches
 * for cache state exclusively through the session API; the unit suite
 * for `kv-cache-session.test.ts` needs to seed and inspect raw state
 * to assert the rollback / commit invariants. Not part of the public
 * surface.
 *
 * @internal
 */
export const __kvCacheSessionTestHooks = {
  getSavedCount(cachePath: string): number | undefined {
    return cachedPrefixes.get(cachePath)?.messages
  },
  setSavedCountForTest(cachePath: string, count: number): void {
    cachedPrefixes.set(cachePath, { messages: count, toolBlock: false })
  },
  getToolBlockCachedForTest(cachePath: string): boolean {
    return cachedPrefixes.get(cachePath)?.toolBlock ?? false
  },
  hasInitializedPath(cachePath: string): boolean {
    return initializedCaches.has(cachePath)
  },
  getActivePathCountForTest(cachePath: string): number {
    return activeCachePaths.get(cachePath) ?? 0
  },
  getLastAutoCacheSweepMsForTest(): number {
    return lastAutoCacheSweepMs
  },
  setLastAutoCacheSweepMsForTest(value: number): void {
    lastAutoCacheSweepMs = value
  },
  resetForTest(): void {
    cachedPrefixes.clear()
    initializedCaches.clear()
    activeCachePaths.clear()
    lastAutoCacheSweepMs = 0
    autoCacheSweepInFlight = null
    cacheStateLockTail = Promise.resolve()
    cachePathLocks.clear()
  },
  waitForAutoCacheSweepForTest(): Promise<void> {
    return autoCacheSweepInFlight ?? Promise.resolve()
  },
  sweepAutoCachesForTest(options: {
    maxBytes: number
    maxIdleMs: number
    nowMs: number
  }): Promise<void> {
    return maybeSweepAutoCaches(moduleLogger, { ...options, force: true })
  }
}

// Re-export `generateConfigHash` from the path utilities so callers of
// the session can compute the hash without separately importing
// `kv-cache-utils`. The function itself stays in `kv-cache-utils.ts`
// (pure, no state) — only the re-export lives here.
export { generateConfigHash }
