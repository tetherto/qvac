import { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import {
  findMatchingCache,
  generateConfigHash,
  getCacheFilePath,
  getCurrentCacheInfo,
  renameCacheFile,
  deleteCache as deleteCacheUtil,
} from "@/server/bare/ops/kv-cache-utils";
import type { CacheMessage } from "@/server/utils";
import {
  logCacheSaveError,
  logCacheStatus,
} from "@/server/bare/plugins/llamacpp-completion/ops/cache-logger";
import { getServerLogger } from "@/logging";
import type { Logger } from "@/logging/types";

// Used by cross-model paths that have no `RequestContext` (e.g.
// `deleteKvCacheState`). Per-session call sites receive a logger from
// the caller — typically `withRequestContext(...)`.
const moduleLogger = getServerLogger();

/**
 * Single owner of the three KV-cache bookkeeping layers.
 *
 * The llama.cpp completion handler has three independent layers it must
 * keep consistent across every cancel/error branch:
 *
 *   1. `cachedMessageCounts: Map<path, count>` — the "n messages
 *      currently on disk" tracker.
 *   2. `initializedCaches: Set<key>` — the "addon defers disk writes;
 *      we know this cache is primed" tracker.
 *   3. On-disk `.bin` files written by the addon.
 *
 * Without a single owner, every cancel / zero-token / rename-failed /
 * tool-call exit would need to touch all three; any branch that forgets
 * a layer produces three-layer drift bugs.
 *
 * `KvCacheSession` collapses the three layers behind one object with
 * three operations:
 *
 *   - `beginTurn` — resolves the cache file path, primes the system
 *     prompt cache if missing (delegated to a caller-supplied closure
 *     so the session doesn't depend on the model addon), marks the
 *     cache initialized, and returns a `TurnHandle` carrying the
 *     resolved path + the snapshot of the on-disk saved count.
 *   - `commitTurn` — records the new saved count (for custom-key
 *     turns) or renames the addon's pre-response file to the
 *     post-response path and records the count there (for auto-cache
 *     turns). Flips the turn's internal `committed` flag so the
 *     deferred `rollback` becomes a no-op on the happy path.
 *   - `rollback` — atomically deletes the on-disk file, clears the
 *     in-memory init entry, and forgets the saved count. **All three
 *     layers, always, in one place.** Handlers call it once via
 *     `ctx.scope.defer(() => session.rollback(turn))`; `commitTurn`
 *     short-circuits it on success.
 *
 * The module-level `deleteKvCacheState(...)` function (below) provides
 * an administrative cross-model delete API for the
 * `handleDeleteCache` RPC handler.
 *
 * The module-scoped `cachedMessageCounts` and `initializedCaches` maps
 * are *private* to this file — no other module reaches into them.
 * Callers that need cache-status info do so through the session API.
 */

// ----- module-scoped state. The session is the single mutation point
// for the in-memory KV-cache bookkeeping. -----

/**
 * Number of chat messages the kv-cache file on disk is known to cover,
 * keyed by cache path. Written by `commitTurn`, read by `getSavedCount`,
 * deleted by `rollback` / `delete` / `dropStaleSavedCount`. The same
 * INVARIANT that existed in `kv-cache-state.ts` still holds: an entry is
 * present only when the corresponding `.bin` file is considered
 * trustworthy. Cancelled or zero-token turns must remove the entry so
 * the next-turn slice doesn't read a stale boundary.
 */
const cachedMessageCounts = new Map<string, number>();

/**
 * In-memory registry of caches initialized this session. The addon
 * defers disk writes, so the absence of a `.bin` file on disk isn't
 * proof that the cache hasn't been primed in this worker process. Keyed
 * by `${modelId}:${configHash}:${cacheKey}`, so on-disk caches from
 * older worker runs still hit the lazy-load path in `beginTurn`.
 */
const initializedCaches = new Set<string>();

function initRegistryKey(
  modelId: string,
  configHash: string,
  cacheKey: string,
): string {
  return `${modelId}:${configHash}:${cacheKey}`;
}

// ----- public types -----

export interface TurnHandle {
  /** Resolved on-disk cache file path the addon will read from / write to. */
  readonly cachePath: string;
  /**
   * Snapshot of the on-disk saved-message count at `beginTurn` time
   * (0 if the cache was just primed). Consumed by `decideCachedHistorySlice`
   * to pick the message tail for the next addon call.
   */
  readonly savedCount: number;
}

export interface BeginCustomTurnInput {
  kind: "custom";
  /** User-provided session key (`completion({ kvCache: "session-a" })`). */
  customKey: string;
  /** Hash of system prompt + (static) tool names. */
  configHash: string;
  /**
   * Prime the cache by sending system prompt + (static) tools to the
   * addon. Called when the cache doesn't exist in-memory OR on disk.
   * Kept as an injected closure so this module has no dependency on the
   * model registry / addon — the handler closes over `model` and tools.
   */
  primeIfMissing: (cachePath: string) => Promise<void>;
}

export interface BeginAutoTurnInput {
  kind: "auto";
  /** Hash of system prompt + (static) tool names. */
  configHash: string;
  /** Conversation history used to compute the pre-response cache key. */
  history: CacheMessage[];
  /** See `BeginCustomTurnInput.primeIfMissing`. */
  primeIfMissing: (cachePath: string) => Promise<void>;
}

export type BeginTurnInput = BeginCustomTurnInput | BeginAutoTurnInput;

export interface StaticCommitResult {
  kind: "static";
  /** `history.length + 1` — recorded at the turn's current `cachePath`. */
  messageCount: number;
}

export interface AutoRenameCommitResult {
  kind: "autoRename";
  /**
   * Destination path the addon's pre-response cache file should be
   * renamed to (computed from `cacheMessages + responseText`). The
   * stale entry at the source path is dropped from `cachedMessageCounts`
   * and the new count is recorded at this target path.
   */
  targetCachePath: string;
  /** Number of messages the renamed cache represents (`savedHistory.length`). */
  messageCount: number;
}

export type CommitResult = StaticCommitResult | AutoRenameCommitResult;

export interface KvCacheSession {
  /**
   * Open a new turn against the cache. Resolves the cache file path,
   * primes the system-prompt cache if needed (delegated to
   * `input.primeIfMissing`), marks the cache initialized, and returns a
   * `TurnHandle` the handler attaches to `ctx.scope.defer(...)` for the
   * rollback hook.
   */
  beginTurn(input: BeginTurnInput): Promise<TurnHandle>;

  /**
   * Commit a successful turn — records the new saved-message count,
   * preserves the cache file, and (for auto-cache turns) renames the
   * addon's pre-response file to the post-response path. Flips the
   * turn's internal `committed` flag so the deferred `rollback` becomes
   * a no-op on the happy path.
   */
  commitTurn(turn: TurnHandle, result: CommitResult): Promise<void>;

  /**
   * Roll back an in-flight turn — atomically deletes the on-disk cache
   * file, clears the in-memory `initializedCaches` entry, and forgets
   * the `cachedMessageCounts` entry. **All three layers, always, in
   * one place.** Idempotent: a turn that has already been committed
   * or rolled back is a no-op on subsequent calls. Handlers register
   * this via `ctx.scope.defer(...)` so it runs regardless of how the
   * handler exits (success branch removes itself via `commitTurn`).
   */
  rollback(turn: TurnHandle): Promise<void>;

  /**
   * Forget the in-memory saved-message count for the turn's path
   * without unlinking the file or clearing the init flag. Used when
   * `decideCachedHistorySlice` detects a stale boundary
   * (`clearStaleCount: true`) — the next turn re-sends the full history
   * but the cache itself is still usable.
   */
  dropStaleSavedCount(turn: TurnHandle): void;
}

interface InternalTurnState {
  cachePath: string;
  registryKey: string;
  /** Flipped by `commitTurn`; consulted at the top of `rollback`. */
  committed: boolean;
  /** Flipped at the end of `rollback`; protects against double-rollback. */
  rolledBack: boolean;
}

// ----- factory -----

/**
 * Construct a session bound to one `(modelId, turn-owning request)`
 * scope. `options.logger` is the per-instance logger the session emits
 * through (typically `withRequestContext(getServerLogger(), ctx)`);
 * falls back to the module-scoped logger when omitted.
 */
export function createKvCacheSession(
  modelId: string,
  options?: { logger?: Logger },
): KvCacheSession {
  const logger = options?.logger ?? moduleLogger;
  // Per-session map: each `TurnHandle` carries an opaque entry here. A
  // WeakMap so handles drop their state once the handler scope releases
  // the reference; the module-scoped maps above survive.
  const turnState = new WeakMap<TurnHandle, InternalTurnState>();

  function makeHandle(cachePath: string, registryKey: string): TurnHandle {
    const handle: TurnHandle = {
      cachePath,
      savedCount: cachedMessageCounts.get(cachePath) ?? 0,
    };
    turnState.set(handle, {
      cachePath,
      registryKey,
      committed: false,
      rolledBack: false,
    });
    return handle;
  }

  async function beginCustom(input: BeginCustomTurnInput): Promise<TurnHandle> {
    const cachePath = await getCacheFilePath(
      modelId,
      input.configHash,
      input.customKey,
    );
    const registryKey = initRegistryKey(
      modelId,
      input.configHash,
      input.customKey,
    );

    // In-memory registry check first — the addon defers disk writes, so
    // a freshly-primed cache may not yet exist on disk. If the
    // in-memory flag isn't set, fall back to a filesystem probe so
    // caches surviving across worker restarts still hit the reuse path.
    let exists = initializedCaches.has(registryKey);
    if (!exists) {
      try {
        await fsPromises.access(cachePath);
        exists = true;
        initializedCaches.add(registryKey);
      } catch {
        exists = false;
      }
    }
    logCacheStatus(input.customKey, exists);

    if (!exists) {
      await input.primeIfMissing(cachePath);
      await verifyPrimedFile(cachePath, logger);
      initializedCaches.add(registryKey);
    }

    return makeHandle(cachePath, registryKey);
  }

  async function beginAuto(input: BeginAutoTurnInput): Promise<TurnHandle> {
    // The pre-response cache key is derived from
    // `history.slice(0, -1)` — `findMatchingCache` does that
    // internally. The post-response key (used after a successful turn)
    // is computed by the caller and passed to `commitTurn` as
    // `targetCachePath`.
    const existingCache = await findMatchingCache(
      modelId,
      input.configHash,
      input.history,
    );
    const preResponseCacheInfo = await getCurrentCacheInfo(
      modelId,
      input.configHash,
      input.history,
    );

    const cachePath =
      existingCache !== null
        ? existingCache.cachePath
        : preResponseCacheInfo.cachePath;
    const cacheKeyForRegistry =
      existingCache !== null
        ? existingCache.cacheKey
        : preResponseCacheInfo.cacheKey;
    const registryKey = initRegistryKey(
      modelId,
      input.configHash,
      cacheKeyForRegistry,
    );

    const cacheExists = existingCache !== null;
    logCacheStatus("auto", cacheExists);

    if (!cacheExists) {
      await input.primeIfMissing(cachePath);
      await verifyPrimedFile(cachePath, logger);
      initializedCaches.add(registryKey);
    }

    return makeHandle(cachePath, registryKey);
  }

  async function beginTurn(input: BeginTurnInput): Promise<TurnHandle> {
    if (input.kind === "custom") return beginCustom(input);
    return beginAuto(input);
  }

  async function commitTurn(
    turn: TurnHandle,
    result: CommitResult,
  ): Promise<void> {
    const state = turnState.get(turn);
    if (!state) {
      // Handle from a different session or already torn down. Treat as
      // no-op — caller shouldn't be reaching into another session's
      // state, but failing loudly here punishes the rollback-after-end
      // path more than it helps.
      return;
    }
    if (state.committed || state.rolledBack) return;

    if (result.kind === "static") {
      // Custom-key path: the addon wrote the new cache state inline
      // at the same path. Verify the file persisted (the addon
      // currently swallows save errors — see TODO in
      // `verifySaveAndRecord`) and record the new boundary.
      const ok = await verifySaveAndRecord(
        state.cachePath,
        result.messageCount,
      );
      if (!ok) {
        // The expected save didn't land — treat the turn as a rollback
        // so the next turn re-primes cleanly.
        await runRollback(state);
        return;
      }
      state.committed = true;
      return;
    }

    // Auto-rename path: the pre-response file is now stale (its key
    // refers to history minus the last user turn). Rename it to the
    // post-response key and record the new count there.
    if (!(await renameCacheFile(state.cachePath, result.targetCachePath))) {
      logger.warn(
        `[kv-cache] Auto cache rename failed; rolling back. from=${state.cachePath} to=${result.targetCachePath}`,
      );
      await runRollback(state);
      return;
    }

    // The source path's entry is gone (the file moved). Drop it and
    // record the new count at the rename target.
    cachedMessageCounts.delete(state.cachePath);

    const ok = await verifySaveAndRecord(
      result.targetCachePath,
      result.messageCount,
    );
    if (!ok) {
      // Rename succeeded but the file isn't where we expected. Roll
      // back via the target path instead of the (now-empty) source.
      state.cachePath = result.targetCachePath;
      await runRollback(state);
      return;
    }

    // Successful auto-rename. The handle's `cachePath` field still
    // points at the (now-gone) source path — that's fine, the handle
    // is committed and won't roll back. Future turns compute fresh
    // paths.
    state.committed = true;
  }

  async function rollback(turn: TurnHandle): Promise<void> {
    const state = turnState.get(turn);
    if (!state) return;
    if (state.committed || state.rolledBack) return;
    await runRollback(state);
  }

  async function runRollback(state: InternalTurnState): Promise<void> {
    // Order matters only weakly: unlink first so a partial disk-state
    // can't be re-loaded by a sibling turn between the file delete and
    // the in-memory clear. In practice handlers serialise per model;
    // the order is belt-and-suspenders.
    try {
      await fsPromises.unlink(state.cachePath);
    } catch (unlinkError) {
      logger.warn(
        `[kv-cache] Failed to remove cache file during rollback; next turn may load stale KV state. path=${state.cachePath} error=${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
      );
    }
    initializedCaches.delete(state.registryKey);
    cachedMessageCounts.delete(state.cachePath);
    state.rolledBack = true;
  }

  function dropStaleSavedCount(turn: TurnHandle): void {
    const state = turnState.get(turn);
    if (!state) return;
    cachedMessageCounts.delete(state.cachePath);
  }

  return {
    beginTurn,
    commitTurn,
    rollback,
    dropStaleSavedCount,
  };
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
 * `modelId` optional on the wire). A session, by contrast, is
 * created with a *fixed* `modelId` for the duration of a turn. Making
 * delete a method would force callers to materialise an irrelevant
 * session for cross-model administrative cleanups.
 *
 * Layers cleared, in order:
 *   1. On-disk: `deleteCache(...)` removes the matching directory
 *      tree (or wipes and recreates the root for `all: true`).
 *   2. `cachedMessageCounts`: prefix-cleanup by the removed directory
 *      so any per-cache count under the deleted tree is forgotten.
 *   3. `initializedCaches`: scope clear by `(kvCacheKey[, modelId])`,
 *      matching the on-disk scope.
 *
 * Concurrency with in-flight turns: this delete is wire-async with
 * respect to any turn currently holding a `TurnHandle` for the same
 * cache key. Worst case the on-disk `.bin` is removed while a turn is
 * mid-write; the turn's eventual `commitTurn(...)` then fails the
 * `verifySaveAndRecord` probe (file gone) and rolls back idempotently.
 * No coordination primitive is needed because every layer's mutation
 * is idempotent (`unlink` no-ops if missing, `Map.delete` / `Set.delete`
 * no-op on absent keys).
 */
export async function deleteKvCacheState(
  target: { kvCacheKey: string; modelId?: string } | { all: true },
): Promise<void> {
  if ("all" in target) {
    const removed = await deleteCacheUtil({ all: true });
    cachedMessageCounts.clear();
    initializedCaches.clear();
    // `removed` is the kv-cache root dir; surfaces it for ops
    // visibility but isn't part of the contract.
    moduleLogger.debug(`[kv-cache] Cleared all caches under ${removed}`);
    return;
  }

  const removedPath = await deleteCacheUtil({
    kvCacheKey: target.kvCacheKey,
    ...(target.modelId !== undefined && { modelId: target.modelId }),
  });

  // Prefix-cleanup the in-memory counts. The on-disk directory tree
  // is `{kvCacheRoot}/{kvCacheKey}[/{modelId}]/`, so every entry in
  // `cachedMessageCounts` whose key is the removed directory itself
  // or sits beneath it must go.
  clearCachedMessageCountsByPrefix(removedPath, path.sep);

  // The in-memory init-set keys are
  // `${modelId}:${configHash}:${kvCacheKey}` — clear by the user-
  // facing kvCacheKey (and optionally narrow by modelId).
  clearInitializedCachesByScope({
    cacheKey: target.kvCacheKey,
    ...(target.modelId !== undefined && { modelId: target.modelId }),
  });
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
 *     a structural hash check we can't currently compute from the
 *     SDK. Filed as a follow-up — see `cache-api.md` in the addon
 *     repo / tracking ticket.
 *
 * On failure we best-effort `unlink` an empty leftover file (so the
 * next existence probe doesn't trust it) and throw — the handler in
 * `completion-stream.ts` lets the error propagate up and no
 * `initializedCaches` entry is recorded.
 */
async function verifyPrimedFile(
  cachePath: string,
  logger: Logger,
): Promise<void> {
  let stats: { size: number };
  try {
    stats = await fsPromises.stat(cachePath);
  } catch (statError) {
    // ENOENT is the common case here — addon prime returned without
    // calling save (most often: signal abort during prefill).
    throw new Error(
      `[kv-cache] prime closure resolved but no cache file was written. path=${cachePath} cause=${statError instanceof Error ? statError.message : String(statError)}`,
    );
  }
  if (stats.size === 0) {
    // Best-effort cleanup so a future probe doesn't trust the empty
    // file. Unlink failure is non-fatal — we still throw on the
    // primary "prime didn't persist" condition.
    try {
      await fsPromises.unlink(cachePath);
    } catch (unlinkError) {
      logger.warn(
        `[kv-cache] Failed to remove empty primed cache file. path=${cachePath} error=${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
      );
    }
    throw new Error(
      `[kv-cache] prime closure resolved but cache file is empty. path=${cachePath}`,
    );
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
): Promise<boolean> {
  try {
    await fsPromises.access(cachePath);
    cachedMessageCounts.set(cachePath, messageCount);
    return true;
  } catch (err) {
    cachedMessageCounts.delete(cachePath);
    logCacheSaveError(cachePath, err);
    return false;
  }
}

function clearCachedMessageCountsByPrefix(prefix: string, sep: string): void {
  if (!prefix) {
    cachedMessageCounts.clear();
    return;
  }
  for (const key of cachedMessageCounts.keys()) {
    if (key === prefix) {
      cachedMessageCounts.delete(key);
      continue;
    }
    if (!key.startsWith(prefix + sep)) continue;
    cachedMessageCounts.delete(key);
  }
}

function clearInitializedCachesByScope(scope: {
  cacheKey?: string | undefined;
  modelId?: string | undefined;
}): void {
  if (scope.cacheKey === undefined && scope.modelId === undefined) {
    initializedCaches.clear();
    return;
  }
  for (const key of initializedCaches) {
    const firstSep = key.indexOf(":");
    const secondSep = key.indexOf(":", firstSep + 1);
    if (firstSep === -1 || secondSep === -1) continue;
    const entryModelId = key.slice(0, firstSep);
    const entryCacheKey = key.slice(secondSep + 1);
    if (scope.cacheKey !== undefined && entryCacheKey !== scope.cacheKey) {
      continue;
    }
    if (scope.modelId !== undefined && entryModelId !== scope.modelId) {
      continue;
    }
    initializedCaches.delete(key);
  }
}

// ----- test-only escape hatches -----

/**
 * Test-only access to the module-scoped state. Production code reaches
 * for cache state exclusively through the session API; the unit suite
 * for `kv-cache-session.test.ts` needs to seed and inspect raw state
 * to assert the rollback / commit invariants. Not part of the public
 * SDK surface.
 *
 * @internal
 */
export const __kvCacheSessionTestHooks = {
  getSavedCount(cachePath: string): number | undefined {
    return cachedMessageCounts.get(cachePath);
  },
  setSavedCountForTest(cachePath: string, count: number): void {
    cachedMessageCounts.set(cachePath, count);
  },
  hasInitializedKey(
    modelId: string,
    configHash: string,
    cacheKey: string,
  ): boolean {
    return initializedCaches.has(
      initRegistryKey(modelId, configHash, cacheKey),
    );
  },
  markInitializedForTest(
    modelId: string,
    configHash: string,
    cacheKey: string,
  ): void {
    initializedCaches.add(initRegistryKey(modelId, configHash, cacheKey));
  },
  resetForTest(): void {
    cachedMessageCounts.clear();
    initializedCaches.clear();
  },
};

// Re-export `generateConfigHash` from the path utilities so callers of
// the session can compute the hash without separately importing
// `kv-cache-utils`. The function itself stays in `kv-cache-utils.ts`
// (pure, no state) — only the re-export lives here.
export { generateConfigHash };
