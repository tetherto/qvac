// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  cachedMessageCounts,
  clearCachedMessageCounts,
  decideCachedHistorySlice,
  type HistoryMessage,
} from "@/server/bare/plugins/llamacpp-completion/ops/kv-cache-state";

// -----------------------------------------------------------------------------
// Unit-level regression coverage for `decideCachedHistorySlice` — the pure
// piece of the kv-cache cancel/zero-token fix (QVAC-17780).
//
// In SDK 0.11.0 the cancel-counter side channel that used to live in this
// module (`modelCancelCounters`, `noteCancelRequested`, `snapshotCancelCount`,
// `shouldRecordSavedCount`) was retired. Cancel detection now flows through
// the per-request `AbortSignal` from `RequestRegistry` (see
// `test/unit/runtime/request-registry.test.ts`) and `completion-stream.ts`
// reads `signal.aborted` directly. The slice-decision regression coverage
// below is still relevant — it guards the "stale savedCount → empty payload"
// failure mode that's independent of how cancel is plumbed.
// -----------------------------------------------------------------------------

type T = {
  alike: (actual: unknown, expected: unknown, msg?: string) => void;
  is: (actual: unknown, expected: unknown, msg?: string) => void;
};

function resetState() {
  clearCachedMessageCounts();
}

test("decideCachedHistorySlice: baseline slice when savedCount is valid", (t: T) => {
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

test("decideCachedHistorySlice: stale count (slice would be empty) falls back and flags clear", (t: T) => {
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

test("decideCachedHistorySlice: savedCount > history.length falls back and flags clear", (t: T) => {
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

test("decideCachedHistorySlice: savedCount = 0, cache exists → strip system, no clear", (t: T) => {
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

test("decideCachedHistorySlice: cache does not exist → strip system regardless of savedCount", (t: T) => {
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

test("decideCachedHistorySlice: empty history returns empty, no clear", (t: T) => {
  resetState();
  const { messages, clearStaleCount } = decideCachedHistorySlice(2, true, []);
  t.alike(messages, []);
  t.is(clearStaleCount, false);
});

test("decideCachedHistorySlice: savedCount = history.length slices to [] and flags clear", (t: T) => {
  // Exact shape of the reported QVAC-17780 bug: a cancelled turn records
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

test("regression: an externally-seeded stale savedCount still triggers the fallback", (t: T) => {
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
