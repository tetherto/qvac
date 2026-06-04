import test from "brittle";
import {
  decideCachedHistorySlice,
  type HistoryMessage,
} from "@/server/bare/plugins/llamacpp-completion/ops/kv-cache-state";

// -----------------------------------------------------------------------------
// Unit-level regression coverage for `decideCachedHistorySlice` — the pure
// piece of the kv-cache cancel/zero-token fix (QVAC-17780).
//
// In SDK 0.11.0 the cancel-counter side channel that used to live in
// this module (`modelCancelCounters`, `noteCancelRequested`,
// `snapshotCancelCount`, `shouldRecordSavedCount`) was retired. Cancel
// detection now flows through the per-request `AbortSignal` from
// `RequestRegistry` (see `test/unit/runtime/request-registry.test.ts`)
// and `completion-stream.ts` reads `signal.aborted` directly.
//
// The `cachedMessageCounts` map and its `clearCachedMessageCounts`
// helper that this file used to seed via `import { cachedMessageCounts }
// from "kv-cache-state"` were moved into `kv-cache-session.ts` as the
// single owner of all three KV-cache bookkeeping layers. The pure
// slice-decision helper still lives in `kv-cache-state.ts` and takes
// `savedCount` as a plain parameter; these tests now drive it without
// seeding any module state. The session's own commit/rollback
// semantics are covered by `runtime/kv-cache-session.test.ts`.
//
// The slice-decision regression coverage below remains relevant — it
// guards the "stale savedCount → empty payload" failure mode that's
// independent of how cancel is plumbed or who owns the saved-count
// state.
// -----------------------------------------------------------------------------


test("decideCachedHistorySlice: baseline slice when savedCount is valid", (t) => {
  const history: HistoryMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ];
  const { messages, clearStaleCount } = decideCachedHistorySlice(
    2,
    true,
    history,
  );
  t.alike(messages, [
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ]);
  t.is(clearStaleCount, false);
});

test("decideCachedHistorySlice: stale count (slice would be empty) falls back and flags clear", (t) => {
  const history: HistoryMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
  ];
  const { messages, clearStaleCount } = decideCachedHistorySlice(
    3,
    true,
    history,
  );
  t.alike(messages, [
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
  ]);
  t.is(
    clearStaleCount,
    true,
    "caller must be told to clear the stale savedCount",
  );
});

test("decideCachedHistorySlice: savedCount > history.length falls back and flags clear", (t) => {
  const history: HistoryMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
  ];
  const { messages, clearStaleCount } = decideCachedHistorySlice(
    10,
    true,
    history,
  );
  t.alike(messages, [{ role: "user", content: "u1" }]);
  t.is(clearStaleCount, true);
});

test("decideCachedHistorySlice: savedCount = 0, cache exists → strip system, no clear", (t) => {
  const history: HistoryMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
  ];
  const { messages, clearStaleCount } = decideCachedHistorySlice(
    0,
    true,
    history,
  );
  t.alike(messages, [{ role: "user", content: "u1" }]);
  t.is(clearStaleCount, false);
});

test("decideCachedHistorySlice: cache does not exist → strip system regardless of savedCount", (t) => {
  const history: HistoryMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
  ];
  const { messages, clearStaleCount } = decideCachedHistorySlice(
    2,
    false,
    history,
  );
  t.alike(messages, [{ role: "user", content: "u1" }]);
  t.is(
    clearStaleCount,
    false,
    "no-cache path does not touch cachedMessageCounts",
  );
});

test("decideCachedHistorySlice: empty history returns empty, no clear", (t) => {
  const { messages, clearStaleCount } = decideCachedHistorySlice(2, true, []);
  t.alike(messages, []);
  t.is(clearStaleCount, false);
});

test("decideCachedHistorySlice: savedCount = history.length slices to [] and flags clear", (t) => {
  // Exact shape of the reported QVAC-17780 bug: a cancelled turn records
  // `history.length + 1` for a 2-message history; the user's next turn
  // has 3 messages and a savedCount of 3 — slicing yields []. The
  // fallback must fire.
  const history: HistoryMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
  ];
  const { messages, clearStaleCount } = decideCachedHistorySlice(
    history.length,
    true,
    history,
  );
  t.alike(messages, [
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
  ]);
  t.is(clearStaleCount, true);
});

test("regression: an externally-seeded stale savedCount still triggers the fallback", (t) => {
  // Belt-and-suspenders test: simulate an externally-poisoned savedCount
  // (e.g. from a pre-upgrade SDK instance still running in memory) and
  // confirm that `decideCachedHistorySlice` refuses to emit an empty
  // payload and also flags the stale count for cleanup.
  //
  // The `cachedMessageCounts` map is private to `kv-cache-session.ts`,
  // so this regression is exercised by feeding the poisoned count into
  // the pure helper directly — the same surface the session calls.
  const savedCount = 3;
  const history: HistoryMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
  ];
  const { messages, clearStaleCount } = decideCachedHistorySlice(
    savedCount,
    true,
    history,
  );

  t.alike(messages, [
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
  ]);
  t.is(clearStaleCount, true, "must prompt caller to clean up the stale count");
});
