import test from 'brittle'
import { PathTraversalError } from '@/errors'

// -----------------------------------------------------------------------------
// `KvCacheSession` — Bare runtime tests.
//
// The session is the single owner of the KV-cache bookkeeping layers
// (on-disk `.bin`, `initializedCaches` set, `cachedPrefixes` map, path
// refs, auto-cache markers). Without a single owner the completion
// handler would have to touch every layer on every cancel / error branch
// and quickly drift out of sync.
// The functional-equivalence assertions below pin the contract:
//
//   1. `beginTurn` primes the cache (calls the injected closure) the
//      first time and reuses the in-memory init flag on subsequent
//      turns — no spurious re-prime.
//   2. `commitTurn({ kind: "static" })` records the new saved count and
//      flips the turn's `committed` flag so the deferred `rollback`
//      becomes a no-op on the happy path.
//   3. `rollback` clears every layer, even when the on-disk file
//      doesn't exist (the `unlink` error is logged but not propagated;
//      in-memory state is still cleared).
//   4. `rollback` after `commitTurn` is a no-op (handle-internal flag
//      protects the committed state from later disposal).
//   5. Double-`rollback` is idempotent.
//   6. `dropStaleSavedCount` clears the saved count without unlinking
//      the file or touching the init flag (used by the slice fallback
//      in `decideCachedHistorySlice`).
//   7. `deleteKvCacheState({ kvCacheKey })` clears every layer for the
//      targeted key, across models. Used by `handleDeleteCache`.
//   8. `deleteKvCacheState({ all: true })` wipes everything.
//
// ---- Runtime gating ----
//
// `kv-cache-session.ts` imports `bare-fs` and `bare-path` at module
// scope (production code path — the session resolves real on-disk
// cache files). `bare-path/lib/posix.js` references `Bare.platform` at
// import time, and `bare-os` carries N-API bindings — neither resolves
// in Bun. These tests live in `test/bare/` and run exclusively under
// the Bare runtime via `npm run test:bare`.
// -----------------------------------------------------------------------------

async function loadSession() {
  const fs = await import('bare-fs')
  const os = await import('bare-os')
  const path = await import('bare-path')
  const { default: env } = await import('bare-env')

  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-kvcache-'))
  env['HOME'] = testHome

  const mod = await import('@/plugins/builtin/llamacpp-completion/ops/kv-cache-session')
  const utils = await import('@/plugins/ops/kv-cache-utils')
  const retention = await import('@/plugins/ops/kv-cache-retention')
  const isolationPath = await utils.getCacheFilePath('_test', '_test', '_test')
  const cacheRoot = path.dirname(path.dirname(path.dirname(isolationPath)))
  fs.rmSync(cacheRoot, { recursive: true, force: true })
  fs.mkdirSync(cacheRoot, { recursive: true })

  // Reset state between tests — module state is per-process, the
  // tests share it.
  mod.__kvCacheSessionTestHooks.resetForTest()

  function cleanup() {
    try {
      fs.rmSync(cacheRoot, { recursive: true, force: true })
      fs.rmSync(testHome, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }

  function writeFakeCache(cachePath: string) {
    const dir = path.dirname(cachePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(cachePath, 'fake-kv-cache-bytes')
  }

  return { fs, path, mod, utils, retention, cleanup, writeFakeCache, cacheRoot }
}

test('generateConfigHash: includes complete canonical tool definitions', async (t) => {
  const { mod, cleanup } = await loadSession()
  try {
    const calculator = {
      type: 'function',
      name: 'calculator',
      description: 'Performs arithmetic',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'subtract'] },
          value: { type: 'number' }
        },
        required: ['operation', 'value']
      }
    }
    const changedSchema = {
      ...calculator,
      parameters: {
        ...calculator.parameters,
        properties: {
          ...calculator.parameters.properties,
          operation: { type: 'string', enum: ['multiply', 'divide'] }
        }
      }
    }
    const reorderedKeys = {
      parameters: {
        required: ['operation', 'value'],
        properties: {
          value: { type: 'number' },
          operation: { enum: ['add', 'subtract'], type: 'string' }
        },
        type: 'object'
      },
      description: 'Performs arithmetic',
      name: 'calculator',
      type: 'function'
    }

    const originalHash = mod.generateConfigHash('system prompt', [calculator])
    const changedHash = mod.generateConfigHash('system prompt', [changedSchema])
    const reorderedHash = mod.generateConfigHash('system prompt', [reorderedKeys])

    t.not(originalHash, changedHash, 'same-named tools with different schemas use different caches')
    t.is(originalHash, reorderedHash, 'object-key insertion order does not affect cache identity')

    const other = { ...calculator, name: 'search' }
    t.not(
      mod.generateConfigHash('system prompt', [calculator, other]),
      mod.generateConfigHash('system prompt', [other, calculator]),
      'tool-array order participates in cache identity'
    )
  } finally {
    cleanup()
  }
})

// `configHash` is the on-disk `.bin` filename, so the digest of a tool-free
// session is a compatibility surface: any change to the hash payload or its
// serialization renames every plain-chat cache file and re-primes it cold.
// Pinning the shipped digests keeps that a deliberate decision.
test('generateConfigHash: no-tools digests stay pinned', async (t) => {
  const { mod, cleanup } = await loadSession()
  try {
    t.is(
      mod.generateConfigHash('you are a helpful assistant.', undefined),
      '3f5906d163f40776',
      'omitted tools keep the shipped digest'
    )
    t.is(
      mod.generateConfigHash('you are a helpful assistant.', []),
      '3f5906d163f40776',
      'an empty tool array hashes like omitted tools'
    )
    t.is(
      mod.generateConfigHash(null, undefined),
      '99ba47708d700919',
      'a missing system prompt keeps the shipped digest'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: beginTurn primes the cache on first use, reuses on second', async (t) => {
  const { mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('you are a helpful assistant.', [])
    let primeCallCount = 0
    const primeIfMissing = async (cachePath: string) => {
      primeCallCount++
      writeFakeCache(cachePath)
    }

    const firstTurn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-a',
      configHash,
      primeIfMissing
    })
    t.is(primeCallCount, 1, 'first turn primes the cache')
    t.is(firstTurn.savedCount, 0, 'no saved count on a freshly-primed cache')
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(
        await utils.getCacheFilePath('test-model', configHash, 'session-a')
      ),
      'initializedCaches entry registered after prime'
    )

    await session.commitTurn(firstTurn, {
      kind: 'static',
      messageCount: 3,
      toolBlockCached: false
    })

    const secondTurn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-a',
      configHash,
      primeIfMissing
    })
    t.is(primeCallCount, 1, 'second turn reuses the primed cache — no spurious re-prime')
    t.is(
      secondTurn.savedCount,
      3,
      "saved count from the first turn's commit is reflected on the second turn's handle"
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: a second same-key turn waits for the first to release its write lock', async (t) => {
  const { mod, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (cachePath: string) => {
      writeFakeCache(cachePath)
    }

    // First turn primes the cache and holds the write lock until it commits.
    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'lock-a',
      configHash,
      primeIfMissing
    })

    // A second turn on the SAME key must block on the write lock — it cannot
    // observe or rewrite the same cache file while the first turn owns it.
    let secondResolved = false
    const secondPromise = session
      .beginTurn({ kind: 'custom', customKey: 'lock-a', configHash, primeIfMissing })
      .then((handle) => {
        secondResolved = true
        return handle
      })

    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    t.is(
      secondResolved,
      false,
      'the second same-key turn is blocked while the first holds the lock'
    )

    await session.commitTurn(first, { kind: 'static', messageCount: 2, toolBlockCached: false })
    const second = await secondPromise
    t.is(secondResolved, true, 'committing the first turn releases the lock and admits the second')

    // A third same-key turn still acquires cleanly — the lock map didn't leak a
    // stuck tail behind the drained turns.
    await session.commitTurn(second, { kind: 'static', messageCount: 2, toolBlockCached: false })
    const third = await session.beginTurn({
      kind: 'custom',
      customKey: 'lock-a',
      configHash,
      primeIfMissing
    })
    t.ok(third, 'a later same-key turn acquires the lock after the queue drains')
    await session.commitTurn(third, { kind: 'static', messageCount: 2, toolBlockCached: false })
  } finally {
    cleanup()
  }
})

test('kv-cache-session: a queued same-key waiter recreates a parent a holder rollback pruned', async (t) => {
  // Race: the holder rolls back (unlink + prune the empty parent dir) while a
  // same-key waiter is queued for the lock and not yet in activeCachePaths, so
  // the prune removes the waiter's parent. The waiter must recreate it after
  // acquiring the lock. The prime writer does NOT mkdir — like the real addon —
  // so a missing parent surfaces as ENOENT rather than being silently masked.
  const { mod, cleanup } = await loadSession()
  const fs = await import('bare-fs')
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeNoMkdir = async (cachePath: string) => {
      fs.writeFileSync(cachePath, 'fake-kv-cache-bytes')
    }

    const holder = await session.beginTurn({
      kind: 'custom',
      customKey: 'race-a',
      configHash,
      primeIfMissing: primeNoMkdir
    })

    // Waiter queues on the same key: its getCacheFilePath made the parent, then
    // it blocks on the write lock the holder owns.
    let waiterErr: unknown = null
    const waiterPromise = session
      .beginTurn({ kind: 'custom', customKey: 'race-a', configHash, primeIfMissing: primeNoMkdir })
      .catch((err) => {
        waiterErr = err
        return null
      })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    // Holder rolls back: unlinks the file and prunes the parent the waiter needs.
    await session.rollback(holder)

    const waiter = await waiterPromise
    t.is(waiterErr, null, 'waiter recreated the pruned parent and primed without ENOENT')
    t.ok(waiter, 'waiter turn admitted after the holder rolled back')
    // Release the admitted waiter so it doesn't leak its write lock / active-path ref.
    if (waiter) await session.rollback(waiter)
  } finally {
    cleanup()
  }
})

test('kv-cache-session: an already-aborted turn does not prime (custom and auto)', async (t) => {
  const { fs, mod, cleanup, cacheRoot } = await loadSession()
  const { AbortController } = await import('bare-abort-controller')
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    let primeCalls = 0
    const primeIfMissing = async () => {
      primeCalls++
    }

    const c1 = new AbortController()
    c1.abort(new Error('aborted'))
    let customErr: unknown = null
    try {
      await session.beginTurn({
        kind: 'custom',
        customKey: 'aborted-a',
        configHash,
        signal: c1.signal,
        primeIfMissing
      })
    } catch (e) {
      customErr = e
    }
    t.ok(
      customErr instanceof Error && customErr.name === 'CacheLockAbortError',
      'custom: rejects with CacheLockAbortError, no prime'
    )

    const c2 = new AbortController()
    c2.abort(new Error('aborted'))
    let autoErr: unknown = null
    try {
      await session.beginTurn({
        kind: 'auto',
        configHash,
        history: [{ role: 'user', content: 'hi' }],
        signal: c2.signal,
        primeIfMissing
      })
    } catch (e) {
      autoErr = e
    }
    t.ok(
      autoErr instanceof Error && autoErr.name === 'CacheLockAbortError',
      'auto: rejects with CacheLockAbortError, no prime'
    )

    t.is(primeCalls, 0, 'neither an already-aborted custom nor auto turn primes')

    // No artifacts: the aborted turns pruned the parent dirs getCacheFilePath
    // created, and the auto turn removed the retention marker its discovery wrote.
    const rootEntries = fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).map(String) : []
    t.is(
      rootEntries.includes('aborted-a'),
      false,
      'aborted custom turn left no cache directory for its key'
    )
    const markers = rootEntries.filter((f) => f.startsWith('.auto-cache-'))
    t.is(markers.length, 0, 'aborted auto turn left no retention marker')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: turns on different cache keys do not block each other', async (t) => {
  const { mod, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (cachePath: string) => {
      writeFakeCache(cachePath)
    }

    // First turn holds the write lock for key `lock-x`.
    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'lock-x',
      configHash,
      primeIfMissing
    })

    // A turn on a DIFFERENT key locks a different path, so it must proceed
    // without waiting for the first — this is the concurrency the fix preserves.
    let otherResolved = false
    const otherPromise = session
      .beginTurn({ kind: 'custom', customKey: 'lock-y', configHash, primeIfMissing })
      .then((handle) => {
        otherResolved = true
        return handle
      })

    const other = await otherPromise
    t.is(otherResolved, true, 'a different-key turn runs concurrently, not blocked by lock-x')

    await session.commitTurn(first, { kind: 'static', messageCount: 1, toolBlockCached: false })
    await session.commitTurn(other, { kind: 'static', messageCount: 1, toolBlockCached: false })
  } finally {
    cleanup()
  }
})

test('kv-cache-session: an auto turn and a custom key that resolve to the same file share one lock', async (t) => {
  const { mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const history = [{ role: 'user', content: 'alias me' }]
    // The custom key equal to the auto-derived key resolves to the same .bin.
    const autoKey = utils.generateCacheKey(history)
    const primeIfMissing = async (cachePath: string) => {
      writeFakeCache(cachePath)
    }

    const autoTurn = await session.beginTurn({ kind: 'auto', configHash, history, primeIfMissing })

    let customResolved = false
    const customPromise = session
      .beginTurn({ kind: 'custom', customKey: autoKey, configHash, primeIfMissing })
      .then((handle) => {
        customResolved = true
        return handle
      })

    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    t.is(customResolved, false, 'a custom key aliasing the auto file is blocked by the auto turn')

    await session.rollback(autoTurn)
    const custom = await customPromise
    t.is(customResolved, true, 'releasing the auto turn admits the aliasing custom turn')
    await session.commitTurn(custom, { kind: 'static', messageCount: 1, toolBlockCached: false })
  } finally {
    cleanup()
  }
})

test('kv-cache-session: a cancelled waiter drops out without waiting for the holder', async (t) => {
  const { mod, cleanup, writeFakeCache } = await loadSession()
  const { AbortController } = await import('bare-abort-controller')
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (cachePath: string) => {
      writeFakeCache(cachePath)
    }

    // First turn holds the lock and is never committed during the wait.
    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'k',
      configHash,
      primeIfMissing
    })

    const controller = new AbortController()
    let rejected = false
    const secondPromise = session
      .beginTurn({
        kind: 'custom',
        customKey: 'k',
        configHash,
        primeIfMissing,
        signal: controller.signal
      })
      .then(
        () => 'resolved',
        () => {
          rejected = true
          return 'rejected'
        }
      )

    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    // Abort while the holder is still decoding — the waiter must bow out at once
    // rather than block until `first` commits.
    controller.abort(new Error('request cancelled'))
    const outcome = await Promise.race([
      secondPromise,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 300))
    ])
    t.is(outcome, 'rejected', 'the aborted waiter rejected promptly, not after the holder finished')
    t.is(rejected, true, 'wait rejected')

    // Lock is uncorrupted: a later turn still acquires after the holder releases.
    await session.commitTurn(first, { kind: 'static', messageCount: 1, toolBlockCached: false })
    const third = await session.beginTurn({
      kind: 'custom',
      customKey: 'k',
      configHash,
      primeIfMissing
    })
    t.ok(third, 'a later turn acquires the lock after the cancelled waiter dropped')
    await session.commitTurn(third, { kind: 'static', messageCount: 1, toolBlockCached: false })
  } finally {
    cleanup()
  }
})

test('kv-cache-session: commitTurn records the new saved count and suppresses rollback', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (p: string) => {
      writeFakeCache(p)
    }

    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-commit',
      configHash,
      primeIfMissing
    })

    // The addon silently swallows save errors, so the session
    // `fs.access`-checks the cache file before recording the count.
    // Simulate that the addon wrote the file.
    fs.writeFileSync(turn.cachePath, 'fake-cache-bytes')

    await session.commitTurn(turn, { kind: 'static', messageCount: 7, toolBlockCached: false })

    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
      7,
      'commit records the new saved message count'
    )

    // Rollback after commit must be a no-op — the committed state
    // has to survive a wholesale scope teardown.
    await session.rollback(turn)
    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
      7,
      'rollback after commit does NOT clear the saved count'
    )
    t.ok(fs.existsSync(turn.cachePath), 'rollback after commit does NOT delete the cache file')
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(
        await utils.getCacheFilePath('test-model', configHash, 'session-commit')
      ),
      'rollback after commit does NOT clear the in-memory init flag'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: rollback wipes every bookkeeping layer atomically', async (t) => {
  const { fs, path, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (p: string) => {
      writeFakeCache(p)
    }

    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-rollback',
      configHash,
      primeIfMissing
    })
    fs.writeFileSync(turn.cachePath, 'stale-bytes')
    mod.__kvCacheSessionTestHooks.setSavedCountForTest(turn.cachePath, 4)

    await session.rollback(turn)

    t.is(fs.existsSync(turn.cachePath), false, 'rollback unlinked the on-disk cache file')
    t.is(
      fs.existsSync(path.dirname(path.dirname(turn.cachePath))),
      false,
      'rollback removed the empty cache-key directory'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
      undefined,
      'rollback forgot the cachedPrefixes entry'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(
        await utils.getCacheFilePath('test-model', configHash, 'session-rollback')
      ),
      false,
      'rollback cleared the initializedCaches entry'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: auto rename prunes the source cache-key directory', async (t) => {
  const { fs, path, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const history = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hello' }
    ]
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash,
      history,
      primeIfMissing: async (cachePath: string) => {
        writeFakeCache(cachePath)
      }
    })
    const target = await utils.getCurrentCacheInfo('test-model', configHash, [
      ...history,
      { role: 'assistant', content: 'hi' }
    ])
    const sourceDirectory = path.dirname(path.dirname(turn.cachePath))
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(turn.cachePath),
      'source path is marked initialized before the rename'
    )

    await session.commitTurn(turn, {
      kind: 'autoRename',
      targetCachePath: target.cachePath,
      messageCount: 3,
      toolBlockCached: false
    })

    t.is(fs.existsSync(turn.cachePath), false, 'source file moved')
    t.is(fs.existsSync(sourceDirectory), false, 'empty source directory removed')
    t.ok(fs.existsSync(target.cachePath), 'renamed cache remains at the target')
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(turn.cachePath),
      'stale source init state cleared after rename (not left marked initialized)'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: an auto turn cancelled before commit does not persist to the target', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const history = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hello' }
    ]
    const { AbortController } = await import('bare-abort-controller')
    const ac = new AbortController()
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash,
      history,
      signal: ac.signal as never,
      primeIfMissing: async (cachePath: string) => {
        writeFakeCache(cachePath)
      }
    })
    const target = await utils.getCurrentCacheInfo('test-model', configHash, [
      ...history,
      { role: 'assistant', content: 'hi' }
    ])

    // Cancelled after decoding, before the commit reaches the target lock.
    ac.abort(new Error('aborted'))

    await session.commitTurn(turn, {
      kind: 'autoRename',
      targetCachePath: target.cachePath,
      messageCount: 3,
      toolBlockCached: false
    })

    t.is(fs.existsSync(target.cachePath), false, 'cancelled turn did not persist to the target')
    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(target.cachePath),
      undefined,
      'no saved count published for a cancelled target'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: marker write failure does not abort auto-cache path resolution', async (t) => {
  const { fs, path, utils, cleanup } = await loadSession()
  try {
    const history = [{ role: 'user' as const, content: 'marker failure' }]
    const cacheKey = utils.generateCacheKey(history)
    const cachePath = await utils.getCacheFilePath('model', 'config', cacheKey)
    const cacheRoot = path.dirname(path.dirname(path.dirname(cachePath)))
    fs.mkdirSync(path.join(cacheRoot, `.auto-cache-${cacheKey}`))

    const cacheInfo = await utils.getCurrentCacheInfo('model', 'config', history)

    t.is(cacheInfo.cacheKey, cacheKey, 'auto-cache key still resolves')
    t.is(cacheInfo.cachePath, cachePath, 'cache path remains usable without retention metadata')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: retention removes markers whose cache directory is missing', async (t) => {
  const { fs, path, utils, retention, cleanup } = await loadSession()
  try {
    const cacheKey = '7777777777777777'
    const cachePath = await utils.getCacheFilePath('model', 'config', cacheKey)
    const cacheRoot = path.dirname(path.dirname(path.dirname(cachePath)))
    const markerPath = path.join(cacheRoot, `.auto-cache-${cacheKey}`)
    await retention.markAutoCacheKey(cacheKey)
    fs.rmSync(path.dirname(path.dirname(cachePath)), { recursive: true, force: true })

    await retention.planAutoCacheEvictions({
      activeCachePaths: [],
      maxBytes: 0,
      maxIdleMs: 1,
      nowMs: Date.now()
    })

    t.is(fs.existsSync(markerPath), false, 'orphaned auto-cache marker removed')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: beginTurn defers retention until turn cleanup', async (t) => {
  const { fs, mod, utils, retention, cleanup, writeFakeCache } = await loadSession()
  try {
    const staleKey = '8888888888888888'
    const stalePath = await utils.getCacheFilePath('stale-model', 'config', staleKey)
    writeFakeCache(stalePath)
    await retention.markAutoCacheKey(staleKey)
    await fs.promises.utimes(stalePath, new Date(1000), new Date(1000))
    mod.__kvCacheSessionTestHooks.setLastAutoCacheSweepMsForTest(0)

    const session = mod.createKvCacheSession('test-model')
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash: mod.generateConfigHash('sys', []),
      history: [{ role: 'user', content: 'active' }],
      primeIfMissing: async (cachePath: string) => {
        writeFakeCache(cachePath)
      }
    })

    t.is(
      mod.__kvCacheSessionTestHooks.getLastAutoCacheSweepMsForTest(),
      0,
      'beginTurn did not start a retention sweep'
    )
    t.ok(fs.existsSync(stalePath), 'stale cache remains available before inference starts')

    await session.rollback(turn)
    await mod.__kvCacheSessionTestHooks.waitForAutoCacheSweepForTest()

    t.ok(
      mod.__kvCacheSessionTestHooks.getLastAutoCacheSweepMsForTest() > 0,
      'turn cleanup scheduled the first retention sweep'
    )
    t.is(fs.existsSync(stalePath), false, 'cleanup sweep removed the stale cache')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: retention evicts oldest auto caches and preserves named caches', async (t) => {
  const { fs, mod, utils, retention, cleanup, writeFakeCache } = await loadSession()
  try {
    const oldKey = '1111111111111111'
    const newKey = '2222222222222222'
    const namedHexKey = '3333333333333333'
    const oldPath = await utils.getCacheFilePath('model', 'config', oldKey)
    const newPath = await utils.getCacheFilePath('model', 'config', newKey)
    const namedHexPath = await utils.getCacheFilePath('model', 'config', namedHexKey)
    const namedPrefixPath = await utils.getCacheFilePath('model', 'config', 'auto-session')

    for (const cachePath of [oldPath, newPath, namedHexPath, namedPrefixPath]) {
      writeFakeCache(cachePath)
    }
    await retention.markAutoCacheKey(oldKey)
    await retention.markAutoCacheKey(newKey)
    await fs.promises.utimes(oldPath, new Date(2000), new Date(2000))
    await fs.promises.utimes(newPath, new Date(3000), new Date(3000))
    await fs.promises.utimes(namedHexPath, new Date(1000), new Date(1000))
    await fs.promises.utimes(namedPrefixPath, new Date(1000), new Date(1000))

    const retentionOptions = {
      activeCachePaths: [],
      maxBytes: fs.statSync(newPath).size,
      maxIdleMs: 0,
      nowMs: 4000
    }
    const plannedEvictions = await retention.planAutoCacheEvictions(retentionOptions)
    t.alike(plannedEvictions, [oldKey], 'planner selects the oldest marked auto cache')

    await mod.__kvCacheSessionTestHooks.sweepAutoCachesForTest(retentionOptions)

    t.is(fs.existsSync(oldPath), false, 'old auto cache evicted')
    t.ok(fs.existsSync(newPath), 'newest auto cache retained under the quota')
    t.ok(fs.existsSync(namedHexPath), 'hex-shaped named cache excluded from auto retention')
    t.ok(fs.existsSync(namedPrefixPath), 'auto-prefixed named cache excluded from auto retention')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: retention never evicts an active auto cache', async (t) => {
  const { fs, mod, utils, retention, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash,
      history: [{ role: 'user', content: 'active' }],
      primeIfMissing: async (cachePath: string) => {
        writeFakeCache(cachePath)
      }
    })
    const inactiveKey = '4444444444444444'
    const inactivePath = await utils.getCacheFilePath('other-model', 'config', inactiveKey)
    writeFakeCache(inactivePath)
    await retention.markAutoCacheKey(inactiveKey)

    await mod.__kvCacheSessionTestHooks.sweepAutoCachesForTest({
      maxBytes: 0,
      maxIdleMs: 0,
      nowMs: Date.now()
    })

    t.ok(fs.existsSync(turn.cachePath), 'active cache retained')
    t.is(fs.existsSync(inactivePath), false, 'inactive cache evicted')
    await session.rollback(turn)
  } finally {
    cleanup()
  }
})

test('kv-cache-session: retention expires idle auto caches', async (t) => {
  const { fs, mod, utils, retention, cleanup, writeFakeCache } = await loadSession()
  try {
    const staleKey = '5555555555555555'
    const freshKey = '6666666666666666'
    const stalePath = await utils.getCacheFilePath('model', 'config', staleKey)
    const freshPath = await utils.getCacheFilePath('model', 'config', freshKey)
    writeFakeCache(stalePath)
    writeFakeCache(freshPath)
    await retention.markAutoCacheKey(staleKey)
    await retention.markAutoCacheKey(freshKey)
    await fs.promises.utimes(stalePath, new Date(1000), new Date(1000))
    await fs.promises.utimes(freshPath, new Date(4500), new Date(4500))

    await mod.__kvCacheSessionTestHooks.sweepAutoCachesForTest({
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxIdleMs: 1000,
      nowMs: 5000
    })

    t.is(fs.existsSync(stalePath), false, 'idle cache evicted after TTL')
    t.ok(fs.existsSync(freshPath), 'recent cache retained')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: rollback tolerates a missing on-disk file', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (p: string) => {
      writeFakeCache(p)
    }

    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-missing-file',
      configHash,
      primeIfMissing
    })
    mod.__kvCacheSessionTestHooks.setSavedCountForTest(turn.cachePath, 2)
    // Delete the file after beginTurn succeeds — simulates a cancelled
    // mid-write turn where the file was removed externally.
    fs.unlinkSync(turn.cachePath)

    await session.rollback(turn)

    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
      undefined,
      'in-memory state cleared even when the unlink fails'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(
        await utils.getCacheFilePath('test-model', configHash, 'session-missing-file')
      ),
      false,
      'init flag cleared even when the unlink fails'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: double-rollback is idempotent', async (t) => {
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (p: string) => {
      writeFakeCache(p)
    }

    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-double',
      configHash,
      primeIfMissing
    })
    fs.writeFileSync(turn.cachePath, 'bytes')

    await session.rollback(turn)
    await session.rollback(turn)
    t.pass('second rollback completed without throwing')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: dropStaleSavedCount forgets the count without touching the file or init flag', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (p: string) => {
      writeFakeCache(p)
    }

    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-stale',
      configHash,
      primeIfMissing
    })
    fs.writeFileSync(turn.cachePath, 'good-bytes')
    mod.__kvCacheSessionTestHooks.setSavedCountForTest(turn.cachePath, 99)

    session.dropStaleSavedCount(turn)

    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
      undefined,
      'stale saved count was forgotten'
    )
    t.ok(
      fs.existsSync(turn.cachePath),
      'the on-disk cache file is preserved (still usable next turn)'
    )
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(
        await utils.getCacheFilePath('test-model', configHash, 'session-stale')
      ),
      'init flag is preserved (cache is still primed)'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: deleteKvCacheState({ kvCacheKey }) wipes every layer for the targeted key', async (t) => {
  const { fs, path, mod, utils, retention, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (p: string) => {
      writeFakeCache(p)
    }

    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'delete-me',
      configHash,
      primeIfMissing
    })
    fs.writeFileSync(turn.cachePath, 'bytes')
    mod.__kvCacheSessionTestHooks.setSavedCountForTest(turn.cachePath, 11)

    await mod.deleteKvCacheState({ kvCacheKey: 'delete-me' })

    t.is(fs.existsSync(turn.cachePath), false, 'on-disk file removed by the keyed delete')
    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
      undefined,
      'in-memory saved count cleared by the keyed delete'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(
        await utils.getCacheFilePath('test-model', configHash, 'delete-me')
      ),
      false,
      'init flag cleared by the keyed delete'
    )

    // Aliased auto-key delete: markers are named `.auto-cache-<16hex>`. Deleting
    // via an alias such as `./<16hex>` must still remove the canonical marker.
    const cacheRoot = path.dirname(path.dirname(path.dirname(turn.cachePath)))
    const autoKey = 'a1b2c3d4e5f60718'
    await retention.markAutoCacheKey(autoKey)
    const markerPath = path.join(cacheRoot, `.auto-cache-${autoKey}`)
    t.is(fs.existsSync(markerPath), true, 'auto-cache marker written')
    await mod.deleteKvCacheState({ kvCacheKey: `./${autoKey}` })
    t.is(fs.existsSync(markerPath), false, 'aliased auto-key delete removed the canonical marker')

    // A nested key ending in a 16-hex segment must NOT touch the unrelated
    // top-level auto marker of the same name — marker keys are root-relative,
    // not basenames.
    const nestedHex = 'deadbeefdeadbeef'
    await retention.markAutoCacheKey(nestedHex)
    const topLevelMarker = path.join(cacheRoot, `.auto-cache-${nestedHex}`)
    t.is(fs.existsSync(topLevelMarker), true, 'top-level auto-cache marker written')
    await mod.deleteKvCacheState({ kvCacheKey: `tenant/${nestedHex}` })
    t.is(
      fs.existsSync(topLevelMarker),
      true,
      'nested-key delete leaves the unrelated top-level marker intact'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: a keyed delete blocks only a root-resolving target, not sanitized keys', async (t) => {
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'keep-me',
      configHash,
      primeIfMissing: async (p: string) => {
        writeFakeCache(p)
      }
    })
    fs.writeFileSync(turn.cachePath, 'bytes')

    // A kvCacheKey that resolves to the cache root ('' / '.' / '..') is rejected —
    // deleting the root would wipe every cache.
    for (const rootKey of ['', '.', '..']) {
      let caught: unknown = null
      try {
        await mod.deleteKvCacheState({ kvCacheKey: rootKey })
      } catch (err) {
        caught = err
      }
      t.ok(
        caught instanceof PathTraversalError,
        `kvCacheKey ${JSON.stringify(rootKey)} rejected as a root delete`
      )
    }
    t.is(fs.existsSync(turn.cachePath), true, 'the real cache survives the rejected root deletes')

    // An empty kvCacheKey with a modelId must not bypass the root guard and
    // delete a real key dir named like the modelId. Create such a cache and
    // confirm it survives + the delete is rejected.
    const other = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-a',
      configHash,
      primeIfMissing: async (p: string) => {
        writeFakeCache(p)
      }
    })
    fs.writeFileSync(other.cachePath, 'bytes')
    await session.commitTurn(other, { kind: 'static', messageCount: 1, toolBlockCached: false })
    let caughtEmptyKey: unknown = null
    try {
      await mod.deleteKvCacheState({ kvCacheKey: '', modelId: 'session-a' })
    } catch (err) {
      caughtEmptyKey = err
    }
    t.ok(caughtEmptyKey instanceof PathTraversalError, 'empty kvCacheKey + modelId rejected')
    t.is(
      fs.existsSync(other.cachePath),
      true,
      "the 'session-a' cache survives the empty-key delete"
    )

    // A PROVIDED but empty modelId collapses to the whole key dir — rejected, so
    // it can't silently broaden the delete (omitting modelId is the explicit way).
    let caughtEmptyModel: unknown = null
    try {
      await mod.deleteKvCacheState({ kvCacheKey: 'keep-me', modelId: '' })
    } catch (err) {
      caughtEmptyModel = err
    }
    t.ok(
      caughtEmptyModel instanceof PathTraversalError,
      'empty modelId rejected — no silent broadening'
    )
    t.is(
      fs.existsSync(turn.cachePath),
      true,
      'keep-me cache survives the rejected empty-modelId delete'
    )

    // A sanitized/nested modelId resolves inside the key dir and deletes only that
    // (here nonexistent) sub-target — it never escapes or touches the real cache.
    for (const modelId of ['../evil', 'a/b']) {
      await mod.deleteKvCacheState({ kvCacheKey: 'keep-me', modelId })
    }
    t.is(
      fs.existsSync(turn.cachePath),
      true,
      'sanitized/nested modelIds leave the real cache intact'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: custom keys — nested / uppercase / unicode / absolute all resolve; aliases share', async (t) => {
  const { mod, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    let primeCount = 0
    const primeIfMissing = async (p: string) => {
      primeCount++
      writeFakeCache(p)
    }
    const commit = { kind: 'static' as const, messageCount: 1, toolBlockCached: false }

    // Nested, uppercase, unicode, and absolute (sanitized to a contained key) all
    // prime once and reuse — these are shapes that resolve and contain.
    for (const key of ['tenant/session', 'MyCache', 'café', '/leading-slash']) {
      const before = primeCount
      const t1 = await session.beginTurn({
        kind: 'custom',
        customKey: key,
        configHash,
        primeIfMissing
      })
      t.is(primeCount, before + 1, `key ${JSON.stringify(key)} primes`)
      await session.commitTurn(t1, commit)
      const t2 = await session.beginTurn({
        kind: 'custom',
        customKey: key,
        configHash,
        primeIfMissing
      })
      t.is(primeCount, before + 1, `key ${JSON.stringify(key)} reuses (no re-prime)`)
      await session.commitTurn(t2, commit)
    }

    // Two spellings that resolve to the same file share initializedCaches: the
    // second spelling reuses rather than re-priming (keyed by resolved path).
    const before = primeCount
    const a = await session.beginTurn({
      kind: 'custom',
      customKey: 'alias-x',
      configHash,
      primeIfMissing
    })
    t.is(primeCount, before + 1, 'first spelling primes')
    await session.commitTurn(a, commit)
    const b = await session.beginTurn({
      kind: 'custom',
      customKey: './alias-x',
      configHash,
      primeIfMissing
    })
    t.is(primeCount, before + 1, 'alias "./alias-x" reuses the same cache — no re-prime')
    await session.commitTurn(b, commit)
  } finally {
    cleanup()
  }
})

test('kv-cache-session: deleteKvCacheState({ all: true }) wipes everything', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (p: string) => {
      writeFakeCache(p)
    }

    const t1 = await session.beginTurn({
      kind: 'custom',
      customKey: 'wipe-a',
      configHash,
      primeIfMissing
    })
    const t2 = await session.beginTurn({
      kind: 'custom',
      customKey: 'wipe-b',
      configHash,
      primeIfMissing
    })
    fs.writeFileSync(t1.cachePath, 'a')
    fs.writeFileSync(t2.cachePath, 'b')
    mod.__kvCacheSessionTestHooks.setSavedCountForTest(t1.cachePath, 1)
    mod.__kvCacheSessionTestHooks.setSavedCountForTest(t2.cachePath, 2)

    await mod.deleteKvCacheState({ all: true })

    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(t1.cachePath),
      undefined,
      'all-delete clears the first saved count'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(t2.cachePath),
      undefined,
      'all-delete clears the second saved count'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(
        await utils.getCacheFilePath('test-model', configHash, 'wipe-a')
      ),
      false,
      'all-delete clears the first init flag'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(
        await utils.getCacheFilePath('test-model', configHash, 'wipe-b')
      ),
      false,
      'all-delete clears the second init flag'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: beginTurn throws if prime closure resolves but no cache file is on disk', async (t) => {
  // Mirrors the existing `verifySaveAndRecord` access-probe at
  // commit time, applied at prime time. The addon's
  // `model.run({ saveSessionPath })` swallows save errors silently
  // and can also be interrupted before save runs — both cases
  // resolve the prime closure cleanly while leaving no file on
  // disk. The session must NOT mark such a prime as initialised
  // because the next existence probe would see no file and
  // re-prime, but the in-memory init flag would already say
  // "primed". `verifyPrimedFile` turns this into a propagated error.
  const { fs, path, mod, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])

    let observedPath: string | null = null
    const primeIfMissing = async (cachePath: string) => {
      observedPath = cachePath
      // Resolve cleanly without touching disk — simulates the
      // addon being interrupted before its save call.
    }

    let caught: unknown = null
    try {
      await session.beginTurn({
        kind: 'custom',
        customKey: 'prime-no-file',
        configHash,
        primeIfMissing
      })
    } catch (err) {
      caught = err
    }

    t.ok(observedPath, 'primeIfMissing observed a cache path')
    t.ok(caught instanceof Error, 'beginTurn rejected because verifyPrimedFile threw')
    t.ok(
      caught instanceof Error && caught.message.includes('no cache file was written'),
      'error message identifies the missing-file failure mode'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(observedPath!),
      false,
      'init flag NOT set when verifyPrimedFile rejects'
    )
    t.ok(observedPath, 'observedPath must be set before directory check')
    t.is(
      fs.existsSync(path.dirname(path.dirname(observedPath!))),
      false,
      'failed prime leaves no empty cache-key directory'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: beginTurn throws and removes the empty file when prime resolves with a zero-byte cache', async (t) => {
  // The addon ignores `llama_state_save_file`'s return value, so an
  // out-of-space / fs flap mid-save can leave an empty file on
  // disk while the prime closure still resolves cleanly. Trusting
  // that file as a primed cache would later cause the addon's
  // `loadCache` to skip it (its own `isFileInitialized` checks
  // size > 0) and silently fall back to re-priming inline — but the
  // session's `initializedCaches` flag would mistakenly say
  // "primed". `verifyPrimedFile` removes the empty file and
  // surfaces the failure to the handler.
  const { fs, path, mod, utils, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])

    let observedPath: string | null = null
    const primeIfMissing = async (cachePath: string) => {
      observedPath = cachePath
      fs.mkdirSync(path.dirname(cachePath), { recursive: true })
      fs.writeFileSync(cachePath, '')
    }

    let caught: unknown = null
    try {
      await session.beginTurn({
        kind: 'custom',
        customKey: 'prime-empty-file',
        configHash,
        primeIfMissing
      })
    } catch (err) {
      caught = err
    }

    t.ok(observedPath, 'primeIfMissing observed a cache path')
    t.ok(
      caught instanceof Error && caught.message.includes('cache file is empty'),
      'error message identifies the empty-file failure mode'
    )
    t.ok(observedPath, 'observedPath must be set before file-existence check')
    t.is(
      fs.existsSync(observedPath!),
      false,
      "empty cache file was removed so the next probe doesn't trust it"
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(
        await utils.getCacheFilePath('test-model', configHash, 'prime-empty-file')
      ),
      false,
      'init flag NOT set on the empty-prime path'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: commitTurn rolls back if the addon did not persist the file', async (t) => {
  // The addon currently swallows save errors silently — a missing
  // file after a save-disk turn means the next turn must NOT slice
  // against a stale saved count. The session's
  // `verifySaveAndRecord` probe turns this into a rollback instead
  // of a phantom commit.
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys', [])
    const primeIfMissing = async (p: string) => {
      writeFakeCache(p)
    }

    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'missing-save',
      configHash,
      primeIfMissing
    })
    // Delete the file after prime — simulate a swallowed addon save
    // error where the file was removed externally.
    fs.unlinkSync(turn.cachePath)

    await session.commitTurn(turn, { kind: 'static', messageCount: 5, toolBlockCached: false })

    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
      undefined,
      'no saved count recorded for a missing file'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(
        await utils.getCacheFilePath('test-model', configHash, 'missing-save')
      ),
      false,
      'init flag rolled back when commit failed verification'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: auto-rename commit releases the target active-ref when setup fails', async (t) => {
  const { mod, cleanup, writeFakeCache } = await loadSession()
  const bareFs = await import('bare-fs')
  const barePath = await import('bare-path')
  const os = await import('bare-os')
  const originalMkdir = bareFs.promises.mkdir
  try {
    const session = mod.createKvCacheSession('leak-model')
    const configHash = mod.generateConfigHash('sys', [])

    // Auto turn: primes and holds the source cache path.
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash,
      history: [{ role: 'user', content: 'hi' }],
      primeIfMissing: async (cachePath: string) => {
        writeFakeCache(cachePath)
      }
    })

    // Fail the target directory's mkdir so the commit's target setup throws AFTER
    // the target active-ref has been taken.
    const targetCachePath = barePath.join(
      os.tmpdir(),
      'qvac-kvcache-leak-target',
      'the-key',
      'hash',
      'session.bin'
    )
    bareFs.promises.mkdir = (async (p: string, opts?: unknown) => {
      if (String(p).includes('qvac-kvcache-leak-target')) {
        throw new Error('injected mkdir failure')
      }
      return originalMkdir(p, opts as never)
    }) as typeof bareFs.promises.mkdir

    let commitErr: unknown = null
    try {
      await session.commitTurn(turn, {
        kind: 'autoRename',
        targetCachePath,
        messageCount: 2,
        toolBlockCached: false
      })
    } catch (error) {
      commitErr = error
    }

    t.ok(
      commitErr instanceof Error && commitErr.message === 'injected mkdir failure',
      'commit propagates the target-setup failure'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.getActivePathCountForTest(targetCachePath),
      0,
      'target active-ref released on setup failure (no leak)'
    )
  } finally {
    bareFs.promises.mkdir = originalMkdir
    cleanup()
  }
})

// A failed first turn must not leave its own prime behind: releaseTurn on a
// freshly primed cache takes the destructive path instead.
test('kv-cache-session: releaseTurn rolls back a cache the same turn primed', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('you are a helpful assistant.', [])
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'release-fresh',
      configHash,
      primeIfMissing: async (cachePath: string) => {
        writeFakeCache(cachePath)
      }
    })
    await session.releaseTurn(turn)

    const cachePath = await utils.getCacheFilePath('test-model', configHash, 'release-fresh')
    t.is(fs.existsSync(cachePath), false, 'the fresh prime is unlinked')
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(cachePath),
      'the init flag is cleared with it'
    )
  } finally {
    cleanup()
  }
})

// `releaseTurn` is the non-destructive exit: committed file, saved prefix,
// and init flag must all survive, and a same-key waiter must get the lock.
test('kv-cache-session: releaseTurn preserves the committed cache and admits a waiter', async (t) => {
  const { mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('you are a helpful assistant.', [])
    let primeCallCount = 0
    const primeIfMissing = async (cachePath: string) => {
      primeCallCount++
      writeFakeCache(cachePath)
    }

    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'release-a',
      configHash,
      primeIfMissing
    })
    await session.commitTurn(first, { kind: 'static', messageCount: 3, toolBlockCached: false })

    const second = await session.beginTurn({
      kind: 'custom',
      customKey: 'release-a',
      configHash,
      primeIfMissing
    })
    t.is(second.savedCount, 3, 'the second turn starts warm')
    await session.releaseTurn(second)

    const cachePath = await utils.getCacheFilePath('test-model', configHash, 'release-a')
    const fs = await import('bare-fs')
    t.ok(
      fs.existsSync(cachePath) && fs.readFileSync(cachePath, 'utf8') === 'fake-kv-cache-bytes',
      'the committed bytes are still on disk, unmodified, after the release'
    )
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(cachePath),
      'the init flag survives the release'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(cachePath),
      3,
      'the committed saved prefix survives the release'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.getActivePathCountForTest(cachePath),
      0,
      'the active-ref is released'
    )

    const third = await session.beginTurn({
      kind: 'custom',
      customKey: 'release-a',
      configHash,
      primeIfMissing
    })
    t.is(primeCallCount, 1, 'no re-prime — the disk cache is still there')
    t.is(third.savedCount, 3, 'the waiter admits with the committed prefix intact')
    await session.rollback(third)
  } finally {
    cleanup()
  }
})
