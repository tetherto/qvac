import test from "brittle";

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
  const fs = await import("bare-fs");
  const os = await import("bare-os");
  const path = await import("bare-path");
  const bareProcess = await import("bare-process");

  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "qvac-kvcache-"));
  bareProcess.default.env["HOME"] = testHome;

  const mod =
    await import("@/server/bare/plugins/llamacpp-completion/ops/kv-cache-session");

  // Reset state between tests — module state is per-process, the
  // tests share it.
  mod.__kvCacheSessionTestHooks.resetForTest();

  function cleanup() {
    try {
      fs.rmSync(testHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  function writeFakeCache(cachePath: string) {
    const dir = path.dirname(cachePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, "fake-kv-cache-bytes");
  }

  return { fs, path, mod, cleanup, writeFakeCache };
}

test(
  "kv-cache-session: beginTurn primes the cache on first use, reuses on second",
  async (t) => {
    const { mod, cleanup, writeFakeCache } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash(
        "you are a helpful assistant.",
        [],
      );
      let primeCallCount = 0;
      const primeIfMissing = async (cachePath: string) => {
        primeCallCount++;
        writeFakeCache(cachePath);
      };

      const firstTurn = await session.beginTurn({
        kind: "custom",
        customKey: "session-a",
        configHash,
        primeIfMissing,
      });
      t.is(primeCallCount, 1, "first turn primes the cache");
      t.is(firstTurn.savedCount, 0, "no saved count on a freshly-primed cache");
      t.ok(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "session-a",
        ),
        "initializedCaches entry registered after prime",
      );

      await session.commitTurn(firstTurn, {
        kind: "static",
        messageCount: 3,
      });

      const secondTurn = await session.beginTurn({
        kind: "custom",
        customKey: "session-a",
        configHash,
        primeIfMissing,
      });
      t.is(
        primeCallCount,
        1,
        "second turn reuses the primed cache — no spurious re-prime",
      );
      t.is(
        secondTurn.savedCount,
        3,
        "saved count from the first turn's commit is reflected on the second turn's handle",
      );
    } finally {
      cleanup();
    }
  },
);

test(
  "kv-cache-session: commitTurn records the new saved count and suppresses rollback",
  async (t) => {
    const { fs, mod, cleanup, writeFakeCache } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async (p: string) => { writeFakeCache(p); };

      const turn = await session.beginTurn({
        kind: "custom",
        customKey: "session-commit",
        configHash,
        primeIfMissing,
      });

      // The addon silently swallows save errors, so the session
      // `fs.access`-checks the cache file before recording the count.
      // Simulate that the addon wrote the file.
      fs.writeFileSync(turn.cachePath, "fake-cache-bytes");

      await session.commitTurn(turn, { kind: "static", messageCount: 7 });

      t.is(
        mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
        7,
        "commit records the new saved message count",
      );

      // Rollback after commit must be a no-op — the committed state
      // has to survive a wholesale scope teardown.
      await session.rollback(turn);
      t.is(
        mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
        7,
        "rollback after commit does NOT clear the saved count",
      );
      t.ok(
        fs.existsSync(turn.cachePath),
        "rollback after commit does NOT delete the cache file",
      );
      t.ok(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "session-commit",
        ),
        "rollback after commit does NOT clear the in-memory init flag",
      );
    } finally {
      cleanup();
    }
  },
);

test(
  "kv-cache-session: rollback wipes all three layers atomically",
  async (t) => {
    const { fs, mod, cleanup, writeFakeCache } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async (p: string) => { writeFakeCache(p); };

      const turn = await session.beginTurn({
        kind: "custom",
        customKey: "session-rollback",
        configHash,
        primeIfMissing,
      });
      fs.writeFileSync(turn.cachePath, "stale-bytes");
      mod.__kvCacheSessionTestHooks.setSavedCountForTest(turn.cachePath, 4);

      await session.rollback(turn);

      t.is(
        fs.existsSync(turn.cachePath),
        false,
        "rollback unlinked the on-disk cache file",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
        undefined,
        "rollback forgot the cachedMessageCounts entry",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "session-rollback",
        ),
        false,
        "rollback cleared the initializedCaches entry",
      );
    } finally {
      cleanup();
    }
  },
);

test(
  "kv-cache-session: rollback tolerates a missing on-disk file",
  async (t) => {
    const { fs, mod, cleanup, writeFakeCache } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async (p: string) => { writeFakeCache(p); };

      const turn = await session.beginTurn({
        kind: "custom",
        customKey: "session-missing-file",
        configHash,
        primeIfMissing,
      });
      mod.__kvCacheSessionTestHooks.setSavedCountForTest(turn.cachePath, 2);
      // Delete the file after beginTurn succeeds — simulates a cancelled
      // mid-write turn where the file was removed externally.
      fs.unlinkSync(turn.cachePath);

      await session.rollback(turn);

      t.is(
        mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
        undefined,
        "in-memory state cleared even when the unlink fails",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "session-missing-file",
        ),
        false,
        "init flag cleared even when the unlink fails",
      );
    } finally {
      cleanup();
    }
  },
);

test("kv-cache-session: double-rollback is idempotent", async (t) => {
  const { fs, mod, cleanup, writeFakeCache } = await loadSession();
  try {
    const session = mod.createKvCacheSession("test-model");
    const configHash = mod.generateConfigHash("sys", []);
    const primeIfMissing = async (p: string) => { writeFakeCache(p); };

    const turn = await session.beginTurn({
      kind: "custom",
      customKey: "session-double",
      configHash,
      primeIfMissing,
    });
    fs.writeFileSync(turn.cachePath, "bytes");

    await session.rollback(turn);
    await session.rollback(turn);
    t.pass("second rollback completed without throwing");
  } finally {
    cleanup();
  }
});

test(
  "kv-cache-session: dropStaleSavedCount forgets the count without touching the file or init flag",
  async (t) => {
    const { fs, mod, cleanup, writeFakeCache } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async (p: string) => { writeFakeCache(p); };

      const turn = await session.beginTurn({
        kind: "custom",
        customKey: "session-stale",
        configHash,
        primeIfMissing,
      });
      fs.writeFileSync(turn.cachePath, "good-bytes");
      mod.__kvCacheSessionTestHooks.setSavedCountForTest(turn.cachePath, 99);

      session.dropStaleSavedCount(turn);

      t.is(
        mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
        undefined,
        "stale saved count was forgotten",
      );
      t.ok(
        fs.existsSync(turn.cachePath),
        "the on-disk cache file is preserved (still usable next turn)",
      );
      t.ok(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "session-stale",
        ),
        "init flag is preserved (cache is still primed)",
      );
    } finally {
      cleanup();
    }
  },
);

test(
  "kv-cache-session: deleteKvCacheState({ kvCacheKey }) wipes every layer for the targeted key",
  async (t) => {
    const { fs, mod, cleanup, writeFakeCache } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async (p: string) => { writeFakeCache(p); };

      const turn = await session.beginTurn({
        kind: "custom",
        customKey: "delete-me",
        configHash,
        primeIfMissing,
      });
      fs.writeFileSync(turn.cachePath, "bytes");
      mod.__kvCacheSessionTestHooks.setSavedCountForTest(turn.cachePath, 11);

      await mod.deleteKvCacheState({ kvCacheKey: "delete-me" });

      t.is(
        fs.existsSync(turn.cachePath),
        false,
        "on-disk file removed by the keyed delete",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
        undefined,
        "in-memory saved count cleared by the keyed delete",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "delete-me",
        ),
        false,
        "init flag cleared by the keyed delete",
      );
    } finally {
      cleanup();
    }
  },
);

test(
  "kv-cache-session: deleteKvCacheState({ all: true }) wipes everything",
  async (t) => {
    const { fs, mod, cleanup, writeFakeCache } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async (p: string) => { writeFakeCache(p); };

      const t1 = await session.beginTurn({
        kind: "custom",
        customKey: "wipe-a",
        configHash,
        primeIfMissing,
      });
      const t2 = await session.beginTurn({
        kind: "custom",
        customKey: "wipe-b",
        configHash,
        primeIfMissing,
      });
      fs.writeFileSync(t1.cachePath, "a");
      fs.writeFileSync(t2.cachePath, "b");
      mod.__kvCacheSessionTestHooks.setSavedCountForTest(t1.cachePath, 1);
      mod.__kvCacheSessionTestHooks.setSavedCountForTest(t2.cachePath, 2);

      await mod.deleteKvCacheState({ all: true });

      t.is(
        mod.__kvCacheSessionTestHooks.getSavedCount(t1.cachePath),
        undefined,
        "all-delete clears the first saved count",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.getSavedCount(t2.cachePath),
        undefined,
        "all-delete clears the second saved count",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "wipe-a",
        ),
        false,
        "all-delete clears the first init flag",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "wipe-b",
        ),
        false,
        "all-delete clears the second init flag",
      );
    } finally {
      cleanup();
    }
  },
);

test(
  "kv-cache-session: beginTurn throws if prime closure resolves but no cache file is on disk",
  async (t) => {
    // Mirrors the existing `verifySaveAndRecord` access-probe at
    // commit time, applied at prime time. The addon's
    // `model.run({ saveSessionPath })` swallows save errors silently
    // and can also be interrupted before save runs — both cases
    // resolve the prime closure cleanly while leaving no file on
    // disk. The session must NOT mark such a prime as initialised
    // because the next existence probe would see no file and
    // re-prime, but the in-memory init flag would already say
    // "primed". `verifyPrimedFile` turns this into a propagated error.
    const { mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);

      let observedPath: string | null = null;
      const primeIfMissing = async (cachePath: string) => {
        observedPath = cachePath;
        // Resolve cleanly without touching disk — simulates the
        // addon being interrupted before its save call.
      };

      let caught: unknown = null;
      try {
        await session.beginTurn({
          kind: "custom",
          customKey: "prime-no-file",
          configHash,
          primeIfMissing,
        });
      } catch (err) {
        caught = err;
      }

      t.ok(observedPath, "primeIfMissing observed a cache path");
      t.ok(
        caught instanceof Error,
        "beginTurn rejected because verifyPrimedFile threw",
      );
      t.ok(
        caught instanceof Error &&
          caught.message.includes("no cache file was written"),
        "error message identifies the missing-file failure mode",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "prime-no-file",
        ),
        false,
        "init flag NOT set when verifyPrimedFile rejects",
      );
    } finally {
      cleanup();
    }
  },
);

test(
  "kv-cache-session: beginTurn throws and removes the empty file when prime resolves with a zero-byte cache",
  async (t) => {
    // The addon ignores `llama_state_save_file`'s return value, so an
    // out-of-space / fs flap mid-save can leave an empty file on
    // disk while the prime closure still resolves cleanly. Trusting
    // that file as a primed cache would later cause the addon's
    // `loadCache` to skip it (its own `isFileInitialized` checks
    // size > 0) and silently fall back to re-priming inline — but the
    // session's `initializedCaches` flag would mistakenly say
    // "primed". `verifyPrimedFile` removes the empty file and
    // surfaces the failure to the handler.
    const { fs, path, mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);

      let observedPath: string | null = null;
      const primeIfMissing = async (cachePath: string) => {
        observedPath = cachePath;
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, "");
      };

      let caught: unknown = null;
      try {
        await session.beginTurn({
          kind: "custom",
          customKey: "prime-empty-file",
          configHash,
          primeIfMissing,
        });
      } catch (err) {
        caught = err;
      }

      t.ok(observedPath, "primeIfMissing observed a cache path");
      t.ok(
        caught instanceof Error &&
          caught.message.includes("cache file is empty"),
        "error message identifies the empty-file failure mode",
      );
      t.ok(observedPath, "observedPath must be set before file-existence check");
      t.is(
        fs.existsSync(observedPath!),
        false,
        "empty cache file was removed so the next probe doesn't trust it",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "prime-empty-file",
        ),
        false,
        "init flag NOT set on the empty-prime path",
      );
    } finally {
      cleanup();
    }
  },
);

test(
  "kv-cache-session: commitTurn rolls back if the addon did not persist the file",
  async (t) => {
    // The addon currently swallows save errors silently — a missing
    // file after a save-disk turn means the next turn must NOT slice
    // against a stale saved count. The session's
    // `verifySaveAndRecord` probe turns this into a rollback instead
    // of a phantom commit.
    const { fs, mod, cleanup, writeFakeCache } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async (p: string) => { writeFakeCache(p); };

      const turn = await session.beginTurn({
        kind: "custom",
        customKey: "missing-save",
        configHash,
        primeIfMissing,
      });
      // Delete the file after prime — simulate a swallowed addon save
      // error where the file was removed externally.
      fs.unlinkSync(turn.cachePath);

      await session.commitTurn(turn, { kind: "static", messageCount: 5 });

      t.is(
        mod.__kvCacheSessionTestHooks.getSavedCount(turn.cachePath),
        undefined,
        "no saved count recorded for a missing file",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "missing-save",
        ),
        false,
        "init flag rolled back when commit failed verification",
      );
    } finally {
      cleanup();
    }
  },
);
