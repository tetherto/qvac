// @ts-expect-error brittle has no type declarations
import test from "brittle";

// -----------------------------------------------------------------------------
// `KvCacheSession` unit tests.
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
// in Bun. To keep the file importable by `bun run test:unit` without
// crashing the suite, the tests below load the session module via
// dynamic `import()` from inside a `bareTest(...)` wrapper that
// `test.skip`s when running under Bun. The full suite runs under the
// Bare runtime (when a Bare unit-test entry exists for this directory)
// and serves as documentation + readable contract under Bun.
//
// This mirrors the pattern established in `test/unit/path-security.test.ts`
// for similar bare-only coverage.
// -----------------------------------------------------------------------------

const isBunUnitTestRunner =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
// @ts-ignore Bare global only exists in Bare runtime
const isBareRuntime =
  !isBunUnitTestRunner && typeof globalThis.Bare !== "undefined";

type T = {
  is: (actual: unknown, expected: unknown, msg?: string) => void;
  alike: (actual: unknown, expected: unknown, msg?: string) => void;
  ok: (value: unknown, msg?: string) => void;
  pass: (msg?: string) => void;
  fail: (msg?: string) => void;
  exception: (
    fn: () => Promise<unknown> | unknown,
    matcher?: unknown,
    msg?: string,
  ) => Promise<void>;
};

function bareTest(name: string, fn: (t: T) => Promise<void> | void) {
  if (isBareRuntime) {
    test(name, fn);
  } else {
    test.skip(`[bare-only] ${name}`, () => {});
  }
}

// Lazy loader for the session module. Only invoked inside test
// bodies; never runs under Bun because the `bareTest` wrapper above
// short-circuits to `test.skip`.
async function loadSession() {
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");

  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "qvac-kvcache-"));
  process.env["HOME"] = testHome;

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

  return { fs, mod, cleanup };
}

bareTest(
  "kv-cache-session: beginTurn primes the cache on first use, reuses on second",
  async (t: T) => {
    const { mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash(
        "you are a helpful assistant.",
        [],
      );
      let primeCallCount = 0;
      const primeIfMissing = async () => {
        primeCallCount++;
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

bareTest(
  "kv-cache-session: commitTurn records the new saved count and suppresses rollback",
  async (t: T) => {
    const { fs, mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async () => {};

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

bareTest(
  "kv-cache-session: rollback wipes all three layers atomically",
  async (t: T) => {
    const { fs, mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async () => {};

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

bareTest(
  "kv-cache-session: rollback tolerates a missing on-disk file",
  async (t: T) => {
    const { mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async () => {};

      const turn = await session.beginTurn({
        kind: "custom",
        customKey: "session-missing-file",
        configHash,
        primeIfMissing,
      });
      mod.__kvCacheSessionTestHooks.setSavedCountForTest(turn.cachePath, 2);
      // Intentionally do NOT create the file. Cancelled mid-write
      // turns hit this branch — the session must still clear the
      // in-memory state cleanly when there's nothing to unlink.

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

bareTest("kv-cache-session: double-rollback is idempotent", async (t: T) => {
  const { fs, mod, cleanup } = await loadSession();
  try {
    const session = mod.createKvCacheSession("test-model");
    const configHash = mod.generateConfigHash("sys", []);
    const primeIfMissing = async () => {};

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

bareTest(
  "kv-cache-session: dropStaleSavedCount forgets the count without touching the file or init flag",
  async (t: T) => {
    const { fs, mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async () => {};

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

bareTest(
  "kv-cache-session: deleteKvCacheState({ kvCacheKey }) wipes every layer for the targeted key",
  async (t: T) => {
    const { fs, mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async () => {};

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

bareTest(
  "kv-cache-session: deleteKvCacheState({ all: true }) wipes everything",
  async (t: T) => {
    const { fs, mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async () => {};

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

bareTest(
  "kv-cache-session: prime is atomic — canonical path is never observable in a partial state when primeIfMissing throws",
  async (t: T) => {
    // The addon's `model.run({ saveSessionPath })` is not transactional
    // — a thrown prime can leave a partial `.bin` at whatever path it
    // was writing to. The session steers the addon's writes to a
    // `.prime.tmp` sibling and only `rename`s into the canonical path
    // after the prime closure resolves successfully. So a thrown prime
    // must leave the canonical path *untouched* (the only test that
    // matters here — a failed unlink on the temp path is by
    // construction unable to corrupt the canonical name).
    const { fs, mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);

      // The session computes the canonical cache path internally; we
      // capture the path the closure receives (which is the temp path
      // ending in `.prime.tmp`) and derive the canonical path by
      // stripping the suffix.
      let receivedPath: string | null = null;
      const primeError = new Error("addon prime failed mid-write");
      const primeIfMissing = async (cachePath: string) => {
        receivedPath = cachePath;
        // Simulate the addon writing a partial file before failing.
        // This goes to the temp path the session handed us — NOT the
        // canonical path.
        fs.writeFileSync(cachePath, "half-primed-bytes");
        throw primeError;
      };

      let caught: unknown = null;
      try {
        await session.beginTurn({
          kind: "custom",
          customKey: "prime-throws",
          configHash,
          primeIfMissing,
        });
      } catch (err) {
        caught = err;
      }

      t.is(caught, primeError, "the original prime error propagates verbatim");
      t.ok(receivedPath, "primeIfMissing observed a path");

      const tempPath = receivedPath as unknown as string;
      t.ok(
        tempPath.endsWith(".prime.tmp"),
        "session handed the closure the temp path, not the canonical one",
      );
      const canonicalPath = tempPath.slice(0, -".prime.tmp".length);

      t.is(
        fs.existsSync(canonicalPath),
        false,
        "canonical cache path was NEVER written — atomic-by-construction",
      );
      t.is(
        fs.existsSync(tempPath),
        false,
        "temp path was unlinked on failure (best-effort, but expected here)",
      );
      t.is(
        mod.__kvCacheSessionTestHooks.hasInitializedKey(
          "test-model",
          configHash,
          "prime-throws",
        ),
        false,
        "init flag was NOT set on the failed-prime path",
      );
    } finally {
      cleanup();
    }
  },
);

bareTest(
  "kv-cache-session: prime is atomic — successful prime promotes temp to canonical via rename",
  async (t: T) => {
    // Companion to the throw test above: on a successful prime the
    // session must `rename` the closure-written temp file to the
    // canonical path so the next turn's existence probe sees a
    // complete cache. The temp path must not survive.
    const { fs, mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);

      let receivedPath: string | null = null;
      const primedBytes = "complete-primed-cache-bytes";
      const primeIfMissing = async (cachePath: string) => {
        receivedPath = cachePath;
        fs.writeFileSync(cachePath, primedBytes);
      };

      const turn = await session.beginTurn({
        kind: "custom",
        customKey: "prime-succeeds",
        configHash,
        primeIfMissing,
      });

      const tempPath = receivedPath as unknown as string;
      t.ok(
        tempPath.endsWith(".prime.tmp"),
        "session handed the closure the temp path, not the canonical one",
      );
      const canonicalPath = tempPath.slice(0, -".prime.tmp".length);

      t.is(
        turn.cachePath,
        canonicalPath,
        "TurnHandle.cachePath is the canonical path, not the temp path",
      );
      t.ok(
        fs.existsSync(canonicalPath),
        "canonical cache path exists after the successful prime",
      );
      t.is(
        fs.readFileSync(canonicalPath, "utf8"),
        primedBytes,
        "canonical cache holds the bytes the addon wrote to the temp path",
      );
      t.is(
        fs.existsSync(tempPath),
        false,
        "temp path was renamed away — no leftover .prime.tmp",
      );
    } finally {
      cleanup();
    }
  },
);

bareTest(
  "kv-cache-session: prime is atomic — leftover .prime.tmp from a prior crashed prime is swept before the next prime",
  async (t: T) => {
    // If a worker crashed mid-prime previously, a stale `.prime.tmp`
    // could survive on disk. A deferred-write addon (one that returns
    // from prime without actually touching disk) would otherwise let
    // the session promote the stale-from-crash bytes to the canonical
    // name on the *next* successful prime. Defensive cleanup at the
    // start of `primeAtomically` prevents that.
    const { fs, mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);

      let receivedPath: string | null = null;
      const primeIfMissing = async (cachePath: string) => {
        receivedPath = cachePath;
        // Simulate the deferred-write addon path: prime returns
        // without actually touching disk.
      };

      // First prime to discover the temp path the session computes.
      // We don't actually need its result; we just need the path so
      // we can plant a "stale temp from a prior crash" before the
      // real prime runs.
      const probeKey = "leak-probe";
      const probeTurn = await session.beginTurn({
        kind: "custom",
        customKey: probeKey,
        configHash,
        primeIfMissing,
      });
      // Drop the probe state so the "real" prime below isn't a
      // reuse-the-init-flag fast path.
      await session.rollback(probeTurn);
      mod.__kvCacheSessionTestHooks.resetForTest();

      // Plant the stale temp file the prior crash would have left.
      const tempPathFromProbe =
        (receivedPath as unknown as string) ?? "<unused>";
      fs.writeFileSync(tempPathFromProbe, "stale-bytes-from-prior-crash");
      t.ok(
        fs.existsSync(tempPathFromProbe),
        "stale .prime.tmp planted before the real prime runs",
      );

      // Real prime — the deferred-write closure returns successfully
      // without touching disk.
      receivedPath = null;
      await session.beginTurn({
        kind: "custom",
        customKey: probeKey,
        configHash,
        primeIfMissing,
      });

      const tempPath = receivedPath as unknown as string;
      const canonicalPath = tempPath.slice(0, -".prime.tmp".length);

      t.is(
        fs.existsSync(canonicalPath),
        false,
        "canonical path was NOT synthesised from stale-from-crash bytes",
      );
      t.is(
        fs.existsSync(tempPath),
        false,
        "stale .prime.tmp was swept by the defensive unlink at prime start",
      );
    } finally {
      cleanup();
    }
  },
);

bareTest(
  "kv-cache-session: commitTurn rolls back if the addon did not persist the file",
  async (t: T) => {
    // The addon currently swallows save errors silently — a missing
    // file after a save-disk turn means the next turn must NOT slice
    // against a stale saved count. The session's
    // `verifySaveAndRecord` probe turns this into a rollback instead
    // of a phantom commit.
    const { mod, cleanup } = await loadSession();
    try {
      const session = mod.createKvCacheSession("test-model");
      const configHash = mod.generateConfigHash("sys", []);
      const primeIfMissing = async () => {};

      const turn = await session.beginTurn({
        kind: "custom",
        customKey: "missing-save",
        configHash,
        primeIfMissing,
      });
      // Intentionally do NOT create the file — simulate a swallowed
      // addon save error.

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
