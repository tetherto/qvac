import test from 'brittle'
import { PathTraversalError } from '@/errors'

// -----------------------------------------------------------------------------
// `KvCacheSession` — Bare runtime tests.
//
// The session is the single owner of the KV-cache bookkeeping layers
// (on-disk `.bin`, `initializedCaches` set, path refs, write locks, auto-cache
// markers). The addon decides how much of a `.bin` the next prompt reuses, so
// the session only tracks whether a cache is established. Pinned below:
//
//   1. `beginTurn` does no native work: a cold turn only reserves the path and
//      the addon's own save establishes the file.
//   2. `commitTurn` verifies the save, marks the path initialized, and makes
//      the deferred `rollback` a no-op.
//   3. `rollback` deletes the file and clears the init flag, and tolerates a
//      file that was never written.
//   4. Double-`rollback` is idempotent.
//   5. A restarted process adopts a `.bin` already on disk as initialized.
//   6. `deleteKvCacheState` clears disk and init state for a key, for auto
//      caches, or for everything.
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

test('generateConfigHash: keys on the system prompt alone', async (t) => {
  const { mod, cleanup } = await loadSession()
  try {
    t.is(
      mod.generateConfigHash('system prompt'),
      mod.generateConfigHash('system prompt'),
      'the same system prompt hashes the same'
    )
    t.not(
      mod.generateConfigHash('system prompt'),
      mod.generateConfigHash('another system prompt'),
      'different system prompts use different caches'
    )
    t.not(
      mod.generateConfigHash('system prompt'),
      mod.generateConfigHash(null),
      'a missing system prompt differs from a present one'
    )
  } finally {
    cleanup()
  }
})

// `configHash` is the on-disk `.bin` filename, so its digest is a compatibility
// surface: any change to the hash payload or its serialization renames every
// cache file and restarts it cold. These are the digests earlier releases gave
// a tool-free session; pinning them keeps an upgrade on the same files.
test('generateConfigHash: shipped digests stay pinned', async (t) => {
  const { mod, cleanup } = await loadSession()
  try {
    t.is(
      mod.generateConfigHash('you are a helpful assistant.'),
      '3f5906d163f40776',
      'a system prompt keeps the shipped digest'
    )
    t.is(
      mod.generateConfigHash(null),
      '99ba47708d700919',
      'a missing system prompt keeps the shipped digest'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: a cold turn establishes the cache from its own save, and the next turn reuses it', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('you are a helpful assistant.')
    const cachePath = await utils.getCacheFilePath('test-model', configHash, 'session-a')

    const firstTurn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-a',
      configHash
    })
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(cachePath),
      'nothing is recorded before the addon has saved'
    )

    // Stands in for the addon's `saveCache` at the end of the turn.
    writeFakeCache(firstTurn.cachePath)
    await session.commitTurn(firstTurn, { kind: 'static' })
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(cachePath),
      'the verified save records the cache'
    )

    const secondTurn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-a',
      configHash
    })
    t.is(secondTurn.cachePath, cachePath, 'the second turn resolves to the same file')
    // Releasing a turn that found an established cache keeps it on disk.
    await session.releaseTurn(secondTurn)
    t.ok(fs.existsSync(cachePath), "the first turn's cache is reused, not treated as fresh")
  } finally {
    cleanup()
  }
})

test('kv-cache-session: a second same-key turn waits for the first to release its write lock', async (t) => {
  const { mod, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')

    // The first turn holds the write lock until it commits.
    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'lock-a',
      configHash
    })
    writeFakeCache(first.cachePath)

    // A second turn on the SAME key must block on the write lock — it cannot
    // observe or rewrite the same cache file while the first turn owns it.
    let secondResolved = false
    const secondPromise = session
      .beginTurn({ kind: 'custom', customKey: 'lock-a', configHash })
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

    await session.commitTurn(first, { kind: 'static' })
    const second = await secondPromise
    t.is(secondResolved, true, 'committing the first turn releases the lock and admits the second')

    // A third same-key turn still acquires cleanly — the lock map didn't leak a
    // stuck tail behind the drained turns.
    await session.commitTurn(second, { kind: 'static' })
    const third = await session.beginTurn({
      kind: 'custom',
      customKey: 'lock-a',
      configHash
    })
    t.ok(third, 'a later same-key turn acquires the lock after the queue drains')
    await session.commitTurn(third, { kind: 'static' })
  } finally {
    cleanup()
  }
})

test('kv-cache-session: a queued same-key waiter recreates a parent a holder rollback pruned', async (t) => {
  // Race: the holder rolls back (unlink + prune the empty parent dir) while a
  // same-key waiter is queued for the lock and not yet in activeCachePaths, so
  // the prune removes the waiter's parent. The waiter must recreate it after
  // acquiring the lock.
  const { mod, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    const holder = await session.beginTurn({
      kind: 'custom',
      customKey: 'race-a',
      configHash
    })

    // Waiter queues on the same key: its getCacheFilePath made the parent, then
    // it blocks on the write lock the holder owns.
    let waiterErr: unknown = null
    const waiterPromise = session
      .beginTurn({ kind: 'custom', customKey: 'race-a', configHash })
      .catch((err) => {
        waiterErr = err
        return null
      })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    // Holder rolls back: unlinks the file and prunes the parent the waiter needs.
    await session.rollback(holder)

    const waiter = await waiterPromise
    t.is(waiterErr, null, 'waiter recreated the pruned parent without ENOENT')
    t.ok(waiter, 'waiter turn admitted after the holder rolled back')
    // Release the admitted waiter so it doesn't leak its write lock / active-path ref.
    if (waiter) await session.rollback(waiter)
  } finally {
    cleanup()
  }
})

test('kv-cache-session: an already-aborted turn rejects and leaves no artifacts (custom and auto)', async (t) => {
  const { fs, mod, cleanup, cacheRoot } = await loadSession()
  const { AbortController } = await import('bare-abort-controller')
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')

    const c1 = new AbortController()
    c1.abort(new Error('aborted'))
    let customErr: unknown = null
    try {
      await session.beginTurn({
        kind: 'custom',
        customKey: 'aborted-a',
        configHash,
        signal: c1.signal
      })
    } catch (e) {
      customErr = e
    }
    t.ok(
      customErr instanceof Error && customErr.name === 'CacheLockAbortError',
      'custom: rejects with CacheLockAbortError'
    )

    const c2 = new AbortController()
    c2.abort(new Error('aborted'))
    let autoErr: unknown = null
    try {
      await session.beginTurn({
        kind: 'auto',
        configHash,
        history: [{ role: 'user', content: 'hi' }],
        signal: c2.signal
      })
    } catch (e) {
      autoErr = e
    }
    t.ok(
      autoErr instanceof Error && autoErr.name === 'CacheLockAbortError',
      'auto: rejects with CacheLockAbortError'
    )

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
  const { mod, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    // First turn holds the write lock for key `lock-x`.
    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'lock-x',
      configHash
    })

    // A turn on a DIFFERENT key locks a different path, so it must proceed
    // without waiting for the first — this is the concurrency the fix preserves.
    let otherResolved = false
    const otherPromise = session
      .beginTurn({ kind: 'custom', customKey: 'lock-y', configHash })
      .then((handle) => {
        otherResolved = true
        return handle
      })

    const other = await otherPromise
    t.is(otherResolved, true, 'a different-key turn runs concurrently, not blocked by lock-x')

    await session.commitTurn(first, { kind: 'static' })
    await session.commitTurn(other, { kind: 'static' })
  } finally {
    cleanup()
  }
})

test('kv-cache-session: an auto turn and a custom key that resolve to the same file share one lock', async (t) => {
  const { mod, utils, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    const history = [{ role: 'user', content: 'alias me' }]
    // The custom key equal to the auto-derived key resolves to the same .bin.
    const autoKey = utils.generateCacheKey(history)
    const autoTurn = await session.beginTurn({ kind: 'auto', configHash, history })

    let customResolved = false
    const customPromise = session
      .beginTurn({ kind: 'custom', customKey: autoKey, configHash })
      .then((handle) => {
        customResolved = true
        return handle
      })

    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    t.is(customResolved, false, 'a custom key aliasing the auto file is blocked by the auto turn')

    await session.rollback(autoTurn)
    const custom = await customPromise
    t.is(customResolved, true, 'releasing the auto turn admits the aliasing custom turn')
    await session.commitTurn(custom, { kind: 'static' })
  } finally {
    cleanup()
  }
})

test('kv-cache-session: a cancelled waiter drops out without waiting for the holder', async (t) => {
  const { mod, cleanup } = await loadSession()
  const { AbortController } = await import('bare-abort-controller')
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    // First turn holds the lock and is never committed during the wait.
    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'k',
      configHash
    })

    const controller = new AbortController()
    let rejected = false
    const secondPromise = session
      .beginTurn({
        kind: 'custom',
        customKey: 'k',
        configHash,
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
    await session.commitTurn(first, { kind: 'static' })
    const third = await session.beginTurn({
      kind: 'custom',
      customKey: 'k',
      configHash
    })
    t.ok(third, 'a later turn acquires the lock after the cancelled waiter dropped')
    await session.commitTurn(third, { kind: 'static' })
  } finally {
    cleanup()
  }
})

test('kv-cache-session: commitTurn marks the cache initialized and suppresses rollback', async (t) => {
  const { fs, mod, utils, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-commit',
      configHash
    })

    // The addon silently swallows save errors, so the session
    // `fs.access`-checks the cache file before recording it.
    // Simulate that the addon wrote the file.
    fs.writeFileSync(turn.cachePath, 'fake-cache-bytes')

    await session.commitTurn(turn, { kind: 'static' })

    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(turn.cachePath),
      'commit marks the cache initialized'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.getActivePathCountForTest(turn.cachePath),
      0,
      'commit releases the active-path ref'
    )

    // Rollback after commit must be a no-op — the committed state
    // has to survive a wholesale scope teardown.
    await session.rollback(turn)
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
  const { fs, path, mod, utils, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-rollback',
      configHash
    })
    fs.writeFileSync(turn.cachePath, 'stale-bytes')

    await session.rollback(turn)

    t.is(fs.existsSync(turn.cachePath), false, 'rollback unlinked the on-disk cache file')
    t.is(
      fs.existsSync(path.dirname(path.dirname(turn.cachePath))),
      false,
      'rollback removed the empty cache-key directory'
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
    const configHash = mod.generateConfigHash('sys')
    const history = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hello' }
    ]
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash,
      history
    })
    const target = await utils.getCurrentCacheInfo('test-model', configHash, [
      ...history,
      { role: 'assistant', content: 'hi' }
    ])
    const sourceDirectory = path.dirname(path.dirname(turn.cachePath))
    writeFakeCache(turn.cachePath)

    await session.commitTurn(turn, {
      kind: 'autoRename',
      targetCachePath: target.cachePath
    })

    t.is(fs.existsSync(turn.cachePath), false, 'source file moved')
    t.is(fs.existsSync(sourceDirectory), false, 'empty source directory removed')
    t.ok(fs.existsSync(target.cachePath), 'renamed cache remains at the target')
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(turn.cachePath),
      'stale source init state cleared after rename (not left marked initialized)'
    )
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(target.cachePath),
      'the renamed target is recorded as initialized'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: an auto turn cancelled before commit does not persist to the target', async (t) => {
  const { fs, mod, utils, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
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
      signal: ac.signal as never
    })
    const target = await utils.getCurrentCacheInfo('test-model', configHash, [
      ...history,
      { role: 'assistant', content: 'hi' }
    ])

    // Cancelled after decoding, before the commit reaches the target lock.
    ac.abort(new Error('aborted'))

    await session.commitTurn(turn, {
      kind: 'autoRename',
      targetCachePath: target.cachePath
    })

    t.is(fs.existsSync(target.cachePath), false, 'cancelled turn did not persist to the target')
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(target.cachePath),
      'a cancelled target is not recorded as initialized'
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
      configHash: mod.generateConfigHash('sys'),
      history: [{ role: 'user', content: 'active' }]
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
    const configHash = mod.generateConfigHash('sys')
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash,
      history: [{ role: 'user', content: 'active' }]
    })
    writeFakeCache(turn.cachePath)
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
    const configHash = mod.generateConfigHash('sys')
    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-missing-file',
      configHash
    })
    writeFakeCache(first.cachePath)
    await session.commitTurn(first, { kind: 'static' })

    // An established cache whose file was removed externally.
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-missing-file',
      configHash
    })
    fs.unlinkSync(turn.cachePath)
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(turn.cachePath),
      'the init flag is still set before the rollback'
    )

    await session.rollback(turn)

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
  const { fs, mod, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'session-double',
      configHash
    })
    fs.writeFileSync(turn.cachePath, 'bytes')

    await session.rollback(turn)
    await session.rollback(turn)
    t.pass('second rollback completed without throwing')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: deleteKvCacheState({ kvCacheKey }) wipes every layer for the targeted key', async (t) => {
  const { fs, path, mod, utils, retention, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'delete-me',
      configHash
    })
    fs.writeFileSync(turn.cachePath, 'bytes')
    await session.commitTurn(turn, { kind: 'static' })
    t.ok(mod.__kvCacheSessionTestHooks.hasInitializedPath(turn.cachePath), 'cache established')

    await mod.deleteKvCacheState({ kvCacheKey: 'delete-me' })

    t.is(fs.existsSync(turn.cachePath), false, 'on-disk file removed by the keyed delete')
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
  const { fs, mod, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'keep-me',
      configHash
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
      configHash
    })
    fs.writeFileSync(other.cachePath, 'bytes')
    await session.commitTurn(other, { kind: 'static' })
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
    const configHash = mod.generateConfigHash('sys')
    const commit = { kind: 'static' as const }

    // Nested, uppercase, unicode, and absolute (sanitized to a contained key)
    // all resolve and contain: the first turn on each key is cold, and the
    // second finds the cache the first committed.
    for (const key of ['tenant/session', 'MyCache', 'café', '/leading-slash']) {
      const t1 = await session.beginTurn({
        kind: 'custom',
        customKey: key,
        configHash
      })
      t.absent(
        mod.__kvCacheSessionTestHooks.hasInitializedPath(t1.cachePath),
        `key ${JSON.stringify(key)} starts cold`
      )
      writeFakeCache(t1.cachePath)
      await session.commitTurn(t1, commit)
      const t2 = await session.beginTurn({
        kind: 'custom',
        customKey: key,
        configHash
      })
      t.is(t2.cachePath, t1.cachePath, `key ${JSON.stringify(key)} resolves to its own file`)
      t.ok(
        mod.__kvCacheSessionTestHooks.hasInitializedPath(t2.cachePath),
        `key ${JSON.stringify(key)} reuses its own committed cache`
      )
      await session.commitTurn(t2, commit)
    }

    // Two spellings that resolve to the same file share the bookkeeping, so the
    // second spelling starts warm on the first spelling's cache.
    const a = await session.beginTurn({
      kind: 'custom',
      customKey: 'alias-x',
      configHash
    })
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(a.cachePath),
      'first spelling starts cold'
    )
    writeFakeCache(a.cachePath)
    await session.commitTurn(a, commit)
    const b = await session.beginTurn({
      kind: 'custom',
      customKey: './alias-x',
      configHash
    })
    t.is(b.cachePath, a.cachePath, 'alias "./alias-x" resolves to the same file')
    t.ok(mod.__kvCacheSessionTestHooks.hasInitializedPath(b.cachePath), 'and starts warm on it')
    await session.commitTurn(b, commit)
  } finally {
    cleanup()
  }
})

test('kv-cache-session: deleteKvCacheState({ all: true }) wipes everything', async (t) => {
  const { fs, mod, utils, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    const t1 = await session.beginTurn({
      kind: 'custom',
      customKey: 'wipe-a',
      configHash
    })
    const t2 = await session.beginTurn({
      kind: 'custom',
      customKey: 'wipe-b',
      configHash
    })
    fs.writeFileSync(t1.cachePath, 'a')
    fs.writeFileSync(t2.cachePath, 'b')
    await session.commitTurn(t1, { kind: 'static' })
    await session.commitTurn(t2, { kind: 'static' })

    await mod.deleteKvCacheState({ all: true })

    t.is(fs.existsSync(t1.cachePath), false, 'all-delete removes the first file')
    t.is(fs.existsSync(t2.cachePath), false, 'all-delete removes the second file')
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

test('kv-cache-session: deleteKvCacheState({ auto: true }) reclaims auto caches and spares named ones', async (t) => {
  const { fs, mod, utils, retention, cleanup, writeFakeCache } = await loadSession()
  try {
    const autoKey = '7777777777777777'
    const namedHexKey = '8888888888888888'
    const autoPath = await utils.getCacheFilePath('model', 'config', autoKey)
    const namedPath = await utils.getCacheFilePath('model', 'config', namedHexKey)
    // A 0-byte `.bin` is what an interrupted save leaves: it has a real mtime, so
    // the idle rule skips it, and it adds nothing to the size total.
    const emptyKey = '9999999999999999'
    const emptyPath = await utils.getCacheFilePath('model', 'config', emptyKey)

    writeFakeCache(autoPath)
    writeFakeCache(namedPath)
    fs.writeFileSync(emptyPath, '')
    await retention.markAutoCacheKey(autoKey)
    await retention.markAutoCacheKey(emptyKey)

    // Freshly written and far under the quota, so neither standing rule would
    // evict them: reclaiming anyway is what makes this on-demand.
    await mod.deleteKvCacheState({ auto: true })

    t.is(fs.existsSync(autoPath), false, 'auto cache reclaimed')
    t.is(fs.existsSync(emptyPath), false, 'zero-byte auto cache reclaimed')
    t.ok(fs.existsSync(namedPath), 'hex-shaped named cache left alone')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: deleteKvCacheState({ auto: true }) skips a cache a turn is holding', async (t) => {
  const { fs, mod, utils, retention, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash: mod.generateConfigHash('sys'),
      history: [{ role: 'user', content: 'active' }]
    })
    // The turn's own cache file, which the reclaim below must leave alone.
    writeFakeCache(turn.cachePath)
    const inactiveKey = 'aaaaaaaaaaaaaaaa'
    const inactivePath = await utils.getCacheFilePath('other-model', 'config', inactiveKey)
    writeFakeCache(inactivePath)
    await retention.markAutoCacheKey(inactiveKey)

    await mod.deleteKvCacheState({ auto: true })

    t.ok(fs.existsSync(turn.cachePath), 'in-flight auto cache retained')
    t.is(fs.existsSync(inactivePath), false, 'inactive auto cache reclaimed')
    await session.rollback(turn)
  } finally {
    cleanup()
  }
})
test('kv-cache-session: commitTurn rolls back if the addon did not persist the file', async (t) => {
  // The addon currently swallows save errors silently, so the session's
  // `verifySaveAndRecord` probe turns a missing file into a rollback instead
  // of a phantom commit.
  const { fs, mod, utils, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'missing-save',
      configHash
    })
    // No `writeFakeCache` here: the addon's save is what would have created the
    // file, and a swallowed save error leaves nothing on disk.
    t.absent(fs.existsSync(turn.cachePath), 'the addon save left no file behind')

    await session.commitTurn(turn, { kind: 'static' })

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
  const { mod, cleanup } = await loadSession()
  const bareFs = await import('bare-fs')
  const barePath = await import('bare-path')
  const os = await import('bare-os')
  const originalMkdir = bareFs.promises.mkdir
  try {
    const session = mod.createKvCacheSession('leak-model')
    const configHash = mod.generateConfigHash('sys')

    // Auto turn: holds the source cache path.
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash,
      history: [{ role: 'user', content: 'hi' }]
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
        targetCachePath
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

// The auto path tracks its origin independently of the custom path, so its
// release needs its own pin: file, init flag, and marker.
test('kv-cache-session: releaseTurn rolls back an auto cache the same turn created', async (t) => {
  const { fs, mod, cleanup, cacheRoot } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('you are a helpful assistant.')
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash,
      history: [{ role: 'user', content: 'hi' }]
    })
    await session.releaseTurn(turn)

    t.is(fs.existsSync(turn.cachePath), false, 'the fresh auto cache is unlinked')
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(turn.cachePath),
      'the init flag is cleared with it'
    )
    const rootEntries = fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).map(String) : []
    t.is(
      rootEntries.filter((f) => f.startsWith('.auto-cache-')).length,
      0,
      'the released fresh auto turn left no retention marker'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: releaseTurn rolls back a cache the same turn created', async (t) => {
  const { fs, mod, utils, cleanup } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('you are a helpful assistant.')
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'release-fresh',
      configHash
    })
    await session.releaseTurn(turn)

    const cachePath = await utils.getCacheFilePath('test-model', configHash, 'release-fresh')
    t.is(fs.existsSync(cachePath), false, 'nothing is left at the reserved path')
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(cachePath),
      'the init flag is cleared with it'
    )
  } finally {
    cleanup()
  }
})

// `releaseTurn` is the non-destructive exit: committed file and init flag
// must both survive, and a same-key waiter must get the lock.
test('kv-cache-session: releaseTurn preserves the committed cache and admits a waiter', async (t) => {
  const { mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('you are a helpful assistant.')
    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'release-a',
      configHash
    })
    writeFakeCache(first.cachePath)
    await session.commitTurn(first, { kind: 'static' })

    const second = await session.beginTurn({
      kind: 'custom',
      customKey: 'release-a',
      configHash
    })
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(second.cachePath),
      'the second turn starts warm'
    )
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
      mod.__kvCacheSessionTestHooks.getActivePathCountForTest(cachePath),
      0,
      'the active-ref is released'
    )

    const third = await session.beginTurn({
      kind: 'custom',
      customKey: 'release-a',
      configHash
    })
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(third.cachePath),
      'the next turn admits with the committed cache intact'
    )
    await session.rollback(third)
  } finally {
    cleanup()
  }
})

// `resetForTest()` clears every in-memory layer while leaving the cache
// directory untouched — the state a fresh worker process starts from.
// `hasInitializedPath` after `beginTurn` is what tells a warm turn from a cold
// one: only a turn that found a `.bin` on disk adopts it that early, a cold
// turn records nothing until its own save is verified at commit.
test('kv-cache-session: a restarted process adopts a committed .bin as initialized', async (t) => {
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')

    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'restart-a',
      configHash
    })
    t.ok(first.createdCache, 'a cold turn creates its cache')
    writeFakeCache(first.cachePath)
    await session.commitTurn(first, { kind: 'static' })
    // The boundary sidecar an earlier release wrote beside the file.
    const sidecarPath = `${first.cachePath}.meta.json`
    fs.writeFileSync(sidecarPath, '{"messages":2,"toolBlock":false,"binSize":19}')

    mod.__kvCacheSessionTestHooks.resetForTest()

    const restarted = mod.createKvCacheSession('test-model')
    const second = await restarted.beginTurn({
      kind: 'custom',
      customKey: 'restart-a',
      configHash
    })
    t.ok(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(second.cachePath),
      'the on-disk cache is adopted by the restarted session'
    )
    t.absent(second.createdCache, 'an adopted cache was not created by this turn')
    t.absent(fs.existsSync(sidecarPath), 'the sidecar an earlier release wrote is removed')
    // An adopted cache was not created by this turn, so releasing keeps it.
    await restarted.releaseTurn(second)
    t.ok(fs.existsSync(second.cachePath), 'releasing the adopted turn keeps the file')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: rollback discards the addon copy of the conversation', async (t) => {
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
  try {
    const discarded: string[] = []
    const session = mod.createKvCacheSession('test-model', {
      discardCache: async (cachePath) => {
        discarded.push(cachePath)
      }
    })
    const configHash = mod.generateConfigHash('sys')
    const turn = await session.beginTurn({ kind: 'custom', customKey: 'discard-a', configHash })
    writeFakeCache(turn.cachePath)

    await session.rollback(turn)

    t.alike(discarded, [turn.cachePath], 'the rolled-back path is discarded from the addon')
    t.absent(fs.existsSync(turn.cachePath), 'the file is removed')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: releasing an adopted cache keeps the addon copy', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const discarded: string[] = []
    const session = mod.createKvCacheSession('test-model', {
      discardCache: async (cachePath) => {
        discarded.push(cachePath)
      }
    })
    const configHash = mod.generateConfigHash('sys')
    writeFakeCache(await utils.getCacheFilePath('test-model', configHash, 'release-a'))
    const turn = await session.beginTurn({ kind: 'custom', customKey: 'release-a', configHash })
    t.absent(turn.createdCache, 'the found file was not created by this turn')

    await session.releaseTurn(turn)

    t.alike(discarded, [], 'nothing is discarded')
    t.ok(fs.existsSync(turn.cachePath), 'the file is kept')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: a failed discard is logged and the rollback completes', async (t) => {
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
  try {
    const warnings: string[] = []
    const logger = {
      error: () => {},
      warn: (...args: unknown[]) => {
        warnings.push(String(args[0]))
      },
      info: () => {},
      debug: () => {}
    }
    const session = mod.createKvCacheSession('test-model', {
      logger: logger as never,
      discardCache: () => Promise.reject(new Error('a request on the key is still running'))
    })
    const configHash = mod.generateConfigHash('sys')
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'discard-fails',
      configHash
    })
    writeFakeCache(turn.cachePath)

    await session.rollback(turn)

    t.absent(fs.existsSync(turn.cachePath), 'the file is still removed')
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(turn.cachePath),
      'the path is no longer initialized'
    )
    t.is(warnings.filter((line) => /discard/.test(line)).length, 1, 'the failure is logged once')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: an auto turn cancelled before commit keeps the file it was found by', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const configHash = mod.generateConfigHash('sys')
    const history = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hello' }
    ]
    // The file an earlier turn left under this history.
    const found = await utils.getCurrentCacheInfo('test-model', configHash, history)
    writeFakeCache(found.cachePath)

    const session = mod.createKvCacheSession('test-model')
    const { AbortController } = await import('bare-abort-controller')
    const ac = new AbortController()
    const turn = await session.beginTurn({
      kind: 'auto',
      configHash,
      history,
      signal: ac.signal as never
    })
    t.is(turn.cachePath, found.cachePath, 'the turn runs on the file it found')
    t.absent(turn.createdCache, 'the found file was not created by this turn')
    const target = await utils.getCurrentCacheInfo('test-model', configHash, [
      ...history,
      { role: 'assistant', content: 'hi' }
    ])

    // Cancelled after decoding, before the commit reaches the target lock.
    ac.abort(new Error('aborted'))
    await session.commitTurn(turn, {
      kind: 'autoRename',
      targetCachePath: target.cachePath
    })

    t.ok(fs.existsSync(found.cachePath), 'the file the turn was found by is kept')
    t.absent(fs.existsSync(target.cachePath), 'nothing is moved to the target')
  } finally {
    cleanup()
  }
})

test('kv-cache-session: rolling back an adopted cache leaves a restart nothing to adopt', async (t) => {
  const { fs, path, mod, cleanup, writeFakeCache } = await loadSession()
  try {
    const session = mod.createKvCacheSession('test-model')
    const configHash = mod.generateConfigHash('sys')

    const first = await session.beginTurn({
      kind: 'custom',
      customKey: 'restart-rollback',
      configHash
    })
    writeFakeCache(first.cachePath)
    await session.commitTurn(first, { kind: 'static' })

    mod.__kvCacheSessionTestHooks.resetForTest()
    const restarted = mod.createKvCacheSession('test-model')
    const second = await restarted.beginTurn({
      kind: 'custom',
      customKey: 'restart-rollback',
      configHash
    })
    await restarted.rollback(second)
    t.is(fs.existsSync(second.cachePath), false, 'rollback unlinked the adopted .bin')
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(second.cachePath),
      'rollback cleared the init flag'
    )
    t.is(
      fs.existsSync(path.dirname(path.dirname(second.cachePath))),
      false,
      'the cache-key directory is pruned'
    )

    mod.__kvCacheSessionTestHooks.resetForTest()
    const third = await mod.createKvCacheSession('test-model').beginTurn({
      kind: 'custom',
      customKey: 'restart-rollback',
      configHash
    })
    t.absent(
      mod.__kvCacheSessionTestHooks.hasInitializedPath(third.cachePath),
      'a restart after rollback has no .bin to adopt'
    )
  } finally {
    cleanup()
  }
})
