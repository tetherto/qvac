import test from 'brittle'

// -----------------------------------------------------------------------------
// `KvCacheSession` — Bare runtime tests.
//
// The session is the single owner of the three KV-cache bookkeeping layers
// (on-disk `.bin`, `initializedCaches` set, `cachedMessageCounts` map).
// Without a single owner the completion handler would have to touch all
// three on every cancel / error branch and quickly drift out of sync.
// The functional-equivalence assertions below pin the contract:
//
//   1. `beginTurn` primes the cache (calls the injected closure) the
//      first time and reuses the in-memory init flag on subsequent
//      turns — no spurious re-prime.
//   2. `commitTurn({ kind: "static" })` records the new saved count and
//      flips the turn's `committed` flag so the deferred `rollback`
//      becomes a no-op on the happy path.
//   3. `rollback` clears all three layers, even when the on-disk file
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

  const mod = await import('@/server/bare/plugins/llamacpp-completion/ops/kv-cache-session')
  const utils = await import('@/server/bare/ops/kv-cache-utils')
  const retention = await import('@/server/bare/ops/kv-cache-retention')
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

  return { fs, path, mod, utils, retention, cleanup, writeFakeCache }
}

test('kv-cache-session: beginTurn primes the cache on first use, reuses on second', async (t) => {
  const { mod, cleanup, writeFakeCache } = await loadSession()
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
      mod.__kvCacheSessionTestHooks.hasInitializedKey('test-model', configHash, 'session-a'),
      'initializedCaches entry registered after prime'
    )

    await session.commitTurn(firstTurn, {
      kind: 'static',
      messageCount: 3
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

test('kv-cache-session: commitTurn records the new saved count and suppresses rollback', async (t) => {
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
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

    await session.commitTurn(turn, { kind: 'static', messageCount: 7 })

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
      mod.__kvCacheSessionTestHooks.hasInitializedKey('test-model', configHash, 'session-commit'),
      'rollback after commit does NOT clear the in-memory init flag'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: rollback wipes all three layers atomically', async (t) => {
  const { fs, path, mod, cleanup, writeFakeCache } = await loadSession()
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
      'rollback forgot the cachedMessageCounts entry'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedKey('test-model', configHash, 'session-rollback'),
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

    await session.commitTurn(turn, {
      kind: 'autoRename',
      targetCachePath: target.cachePath,
      messageCount: 3
    })

    t.is(fs.existsSync(turn.cachePath), false, 'source file moved')
    t.is(fs.existsSync(sourceDirectory), false, 'empty source directory removed')
    t.ok(fs.existsSync(target.cachePath), 'renamed cache remains at the target')
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
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
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
      mod.__kvCacheSessionTestHooks.hasInitializedKey(
        'test-model',
        configHash,
        'session-missing-file'
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
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
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
      mod.__kvCacheSessionTestHooks.hasInitializedKey('test-model', configHash, 'session-stale'),
      'init flag is preserved (cache is still primed)'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: deleteKvCacheState({ kvCacheKey }) wipes every layer for the targeted key', async (t) => {
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
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
      mod.__kvCacheSessionTestHooks.hasInitializedKey('test-model', configHash, 'delete-me'),
      false,
      'init flag cleared by the keyed delete'
    )
  } finally {
    cleanup()
  }
})

test('kv-cache-session: deleteKvCacheState({ all: true }) wipes everything', async (t) => {
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
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
      mod.__kvCacheSessionTestHooks.hasInitializedKey('test-model', configHash, 'wipe-a'),
      false,
      'all-delete clears the first init flag'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedKey('test-model', configHash, 'wipe-b'),
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
      mod.__kvCacheSessionTestHooks.hasInitializedKey('test-model', configHash, 'prime-no-file'),
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
  const { fs, path, mod, cleanup } = await loadSession()
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
      mod.__kvCacheSessionTestHooks.hasInitializedKey('test-model', configHash, 'prime-empty-file'),
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
  const { fs, mod, cleanup, writeFakeCache } = await loadSession()
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

    await session.commitTurn(turn, { kind: 'static', messageCount: 5 })

    t.is(
      mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
      undefined,
      'no saved count recorded for a missing file'
    )
    t.is(
      mod.__kvCacheSessionTestHooks.hasInitializedKey('test-model', configHash, 'missing-save'),
      false,
      'init flag rolled back when commit failed verification'
    )
  } finally {
    cleanup()
  }
})
