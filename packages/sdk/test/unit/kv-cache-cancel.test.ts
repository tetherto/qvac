// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  _resetCancelCountersForTest,
  cachedMessageCounts,
  clearCachedMessageCounts,
  decideCachedHistorySlice,
  noteCancelRequested,
  shouldRecordSavedCount,
  snapshotCancelCount,
  type HistoryMessage,
} from "@/server/bare/plugins/llamacpp-completion/ops/kv-cache-state";

// -----------------------------------------------------------------------------
// Unit-level regression coverage for the kv-cache cancel/zero-token fix.
//
// These tests cover the two pure pieces of the fix:
//   1. `decideCachedHistorySlice` never returns an empty message list when
//      there is history to send (was the root cause of the "SDK returns
//      nothing" symptom after a fast cancel).
//   2. `shouldRecordSavedCount` + `snapshotCancelCount` correctly refuse to
//      record a `savedCount` for cancelled or zero-token turns (prevents
//      the `cachedMessageCounts` map from being poisoned in the first place).
//
// Integration-level coverage (running the full `completion()` generator
// against a real model) requires a loaded model and therefore lives outside
// this unit suite.
// -----------------------------------------------------------------------------

const CACHE_PATH = "/tmp/kv-cache-cancel-test.bin";

function resetState() {
  clearCachedMessageCounts();
  _resetCancelCountersForTest();
}

// -----------------------------------------------------------------------------
// decideCachedHistorySlice
// -----------------------------------------------------------------------------

test("decideCachedHistorySlice: baseline slice when savedCount is valid", (t: {
  alike: (actual: unknown, expected: unknown) => void;
  is: (actual: unknown, expected: unknown) => void;
}) => {
  resetState();
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

test("decideCachedHistorySlice: stale count (slice would be empty) falls back and flags clear", (t: {
  alike: (actual: unknown, expected: unknown) => void;
  is: (actual: unknown, expected: unknown) => void;
}) => {
  resetState();
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

test("decideCachedHistorySlice: savedCount > history.length falls back and flags clear", (t: {
  alike: (actual: unknown, expected: unknown) => void;
  is: (actual: unknown, expected: unknown) => void;
}) => {
  resetState();
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

test("decideCachedHistorySlice: savedCount = 0, cache exists → strip system, no clear", (t: {
  alike: (actual: unknown, expected: unknown) => void;
  is: (actual: unknown, expected: unknown) => void;
}) => {
  resetState();
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

test("decideCachedHistorySlice: cache does not exist → strip system regardless of savedCount", (t: {
  alike: (actual: unknown, expected: unknown) => void;
  is: (actual: unknown, expected: unknown) => void;
}) => {
  resetState();
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

test("decideCachedHistorySlice: empty history returns empty, no clear", (t: {
  alike: (actual: unknown, expected: unknown) => void;
  is: (actual: unknown, expected: unknown) => void;
}) => {
  resetState();
  const { messages, clearStaleCount } = decideCachedHistorySlice(2, true, []);
  t.alike(messages, []);
  t.is(clearStaleCount, false);
});

test("decideCachedHistorySlice: savedCount = history.length slices to [] and flags clear", (t: {
  alike: (actual: unknown, expected: unknown) => void;
  is: (actual: unknown, expected: unknown) => void;
}) => {
  // Exact shape of the reported bug: a cancelled turn records
  // `history.length + 1` for a 2-message history; the user's next turn
  // has 3 messages and a savedCount of 3 — slicing yields []. The
  // fallback must fire.
  resetState();
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

// -----------------------------------------------------------------------------
// shouldRecordSavedCount
// -----------------------------------------------------------------------------

test("shouldRecordSavedCount: true only for normal non-cancelled turns with tokens", (t: {
  is: (actual: unknown, expected: unknown, msg?: string) => void;
}) => {
  t.is(
    shouldRecordSavedCount(false, true),
    true,
    "record on a normal, token-emitting turn",
  );
  t.is(
    shouldRecordSavedCount(true, true),
    false,
    "never record when cancelled, even if tokens flowed",
  );
  t.is(
    shouldRecordSavedCount(false, false),
    false,
    "never record a zero-token turn — cache state is unknown",
  );
  t.is(
    shouldRecordSavedCount(true, false),
    false,
    "cancelled + zero tokens → definitely do not record",
  );
});

// -----------------------------------------------------------------------------
// cancel counter semantics
// -----------------------------------------------------------------------------

test("noteCancelRequested: per-model counters are isolated and monotonic", (t: {
  is: (actual: unknown, expected: unknown) => void;
}) => {
  resetState();
  const a = "model-A";
  const b = "model-B";

  t.is(snapshotCancelCount(a), 0);
  t.is(snapshotCancelCount(b), 0);

  noteCancelRequested(a);
  t.is(snapshotCancelCount(a), 1);
  t.is(snapshotCancelCount(b), 0, "cancels on A don't leak into B");

  noteCancelRequested(a);
  noteCancelRequested(b);
  t.is(snapshotCancelCount(a), 2);
  t.is(snapshotCancelCount(b), 1);
});

test("snapshot-before-snapshot-after detects a cancel recorded in between", (t: {
  is: (actual: unknown, expected: unknown) => void;
}) => {
  // This is the exact pattern used in `completion()` to detect cancellation:
  //   const before = snapshotCancelCount(modelId);
  //   ... run model ...
  //   const wasCancelled = snapshotCancelCount(modelId) > before;
  resetState();
  const id = "model-X";
  const before = snapshotCancelCount(id);
  noteCancelRequested(id);
  const wasCancelled = snapshotCancelCount(id) > before;
  t.is(wasCancelled, true);
});

test("snapshot-before-snapshot-after sees no cancel when none was recorded", (t: {
  is: (actual: unknown, expected: unknown) => void;
}) => {
  resetState();
  const id = "model-Y";
  // Simulate a prior cancel from earlier in the session.
  noteCancelRequested(id);
  const before = snapshotCancelCount(id);
  // No cancel during this turn.
  const wasCancelled = snapshotCancelCount(id) > before;
  t.is(
    wasCancelled,
    false,
    "old cancels do not re-fire on subsequent turns because we compare snapshots",
  );
});

// -----------------------------------------------------------------------------
// End-to-end sequence simulated at the state layer: verifies what
// `completion()` would see across a cancelled turn followed by a fresh
// prompt.
// -----------------------------------------------------------------------------

test("cancelled turn → next turn still has a non-empty payload", (t: {
  alike: (actual: unknown, expected: unknown) => void;
  is: (actual: unknown, expected: unknown) => void;
}) => {
  resetState();
  const id = "model-repro";
  const cachePath = "/tmp/qvac-17780.bin";

  // Turn 1: user sends one message, cancels mid-decode.
  const turn1History: HistoryMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
  ];
  const t1Before = snapshotCancelCount(id);
  noteCancelRequested(id); // cancel fires while generating
  const t1Cancelled = snapshotCancelCount(id) > t1Before;
  // completion() would refuse to record savedCount here.
  t.is(shouldRecordSavedCount(t1Cancelled, /* producedTokens */ true), false);
  // Make sure the map stays clean.
  t.is(cachedMessageCounts.has(cachePath), false);

  // Turn 2: user types a second message immediately. History grows to 3.
  // Because turn 1 did not record a savedCount, the slice decision is the
  // "strip system, send rest" branch — NOT an empty payload.
  const turn2History: HistoryMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
  ];
  const savedCount = cachedMessageCounts.get(cachePath) ?? 0;
  const { messages } = decideCachedHistorySlice(savedCount, true, turn2History);
  t.alike(
    messages,
    [
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
    ],
    "turn 2 must carry real content, not an empty payload",
  );
});

test("regression: an externally-seeded stale savedCount still triggers the fallback", (t: {
  alike: (actual: unknown, expected: unknown) => void;
  is: (actual: unknown, expected: unknown) => void;
}) => {
  // Belt-and-suspenders test: simulate an externally-poisoned savedCount
  // (e.g. from a pre-upgrade SDK instance still running in memory) and
  // confirm that `decideCachedHistorySlice` refuses to emit an empty
  // payload and also flags the stale count for cleanup.
  resetState();
  const cachePath = "/tmp/qvac-17780-poisoned.bin";
  cachedMessageCounts.set(cachePath, 3);

  const history: HistoryMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
  ];
  const savedCount = cachedMessageCounts.get(cachePath) ?? 0;
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
