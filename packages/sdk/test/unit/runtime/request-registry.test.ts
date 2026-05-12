// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { createRequestRegistry } from "@/server/bare/runtime/request-registry";
import { RequestIdConflictError } from "@/utils/errors-server";

// -----------------------------------------------------------------------------
// RequestRegistry unit tests.
//
// Covers the contract M1 hands to handler authors:
//   - begin / get / list reflect a coherent in-flight set.
//   - cancel-by-requestId targets exactly one entry.
//   - cancel-by-modelId predicate fans out across entries with optional
//     kind narrowing.
//   - cancelAll fires every active request's signal exactly once.
//   - Disposing the managed context (via `await using`) flips the state
//     and removes the registry slot.
//   - parentSignal compositions abort the request when the parent does.
//   - RequestIdConflictError is thrown on duplicate ids.
// -----------------------------------------------------------------------------

type T = {
  is: (actual: unknown, expected: unknown, msg?: string) => void;
  alike: (actual: unknown, expected: unknown, msg?: string) => void;
  ok: (value: unknown, msg?: string) => void;
  exception: (
    fn: () => Promise<unknown> | unknown,
    matcher?: unknown,
    msg?: string,
  ) => Promise<void>;
};

test("registry: begin/get/list track in-flight requests", async (t: T) => {
  const r = createRequestRegistry();
  await using a = r.begin({
    requestId: "r-a",
    kind: "completion",
    modelId: "m1",
  });
  await using b = r.begin({
    requestId: "r-b",
    kind: "embeddings",
    modelId: "m2",
  });

  t.is(r.get("r-a")?.requestId, "r-a");
  t.is(r.get("r-b")?.requestId, "r-b");
  t.is(r.get("missing"), null);
  t.is(r.list().length, 2);

  // touch the variables so noUnusedLocals stays quiet.
  t.is(a.kind, "completion");
  t.is(b.kind, "embeddings");
});

test("registry: dispose removes the slot and flips state", async (t: T) => {
  const r = createRequestRegistry();

  async function run() {
    await using ctx = r.begin({
      requestId: "r-1",
      kind: "completion",
      modelId: "m1",
    });
    t.is(ctx.state, "running");
    t.is(r.list().length, 1);
  }

  await run();
  t.is(r.list().length, 0, "scope unwind removed the registry slot");
  t.is(r.get("r-1"), null);
});

test("registry: cancel by requestId aborts only that signal", async (t: T) => {
  const r = createRequestRegistry();
  await using a = r.begin({
    requestId: "r-a",
    kind: "completion",
    modelId: "m1",
  });
  await using b = r.begin({
    requestId: "r-b",
    kind: "completion",
    modelId: "m1",
  });

  const cancelled = r.cancel({ requestId: "r-a" });
  t.is(cancelled, 1, "exactly one entry cancelled");
  t.is(a.signal.aborted, true);
  t.is(a.state, "cancelling");
  t.is(b.signal.aborted, false, "sibling on the same model is untouched");
  t.is(b.state, "running");
});

test("registry: cancel-by-requestId is idempotent and counts only first abort", async (t: T) => {
  const r = createRequestRegistry();
  await using ctx = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
  });
  t.is(r.cancel({ requestId: "r-1" }), 1);
  t.is(r.cancel({ requestId: "r-1" }), 0, "second cancel returns 0");
  t.is(ctx.signal.aborted, true);
});

test("registry: cancel by modelId fans out across that model only", async (t: T) => {
  const r = createRequestRegistry();
  await using a = r.begin({
    requestId: "r-a",
    kind: "completion",
    modelId: "m1",
  });
  await using b = r.begin({
    requestId: "r-b",
    kind: "embeddings",
    modelId: "m1",
  });
  await using c = r.begin({
    requestId: "r-c",
    kind: "completion",
    modelId: "m2",
  });

  const cancelled = r.cancel({ modelId: "m1" });
  t.is(cancelled, 2, "both m1 entries cancelled");
  t.is(a.signal.aborted, true);
  t.is(b.signal.aborted, true);
  t.is(c.signal.aborted, false);
});

test("registry: cancel by modelId + kind narrows the target", async (t: T) => {
  const r = createRequestRegistry();
  await using a = r.begin({
    requestId: "r-a",
    kind: "completion",
    modelId: "m1",
  });
  await using b = r.begin({
    requestId: "r-b",
    kind: "embeddings",
    modelId: "m1",
  });

  const cancelled = r.cancel({ modelId: "m1", kind: "completion" });
  t.is(cancelled, 1, "only the completion-kind entry cancelled");
  t.is(a.signal.aborted, true);
  t.is(b.signal.aborted, false);
});

test("registry: cancelAll fires every signal", async (t: T) => {
  const r = createRequestRegistry();
  await using a = r.begin({
    requestId: "r-a",
    kind: "completion",
    modelId: "m1",
  });
  await using b = r.begin({
    requestId: "r-b",
    kind: "loadModel",
    modelId: "m2",
  });
  await using c = r.begin({
    requestId: "r-c",
    kind: "rag",
  });

  await r.cancelAll("shutdown");
  t.is(a.signal.aborted, true);
  t.is(b.signal.aborted, true);
  t.is(c.signal.aborted, true);
});

test("registry: parentSignal already aborted aborts the new context", async (t: T) => {
  const r = createRequestRegistry();
  const parent = new AbortController();
  parent.abort("shutdown");
  await using ctx = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
    parentSignal: parent.signal,
  });
  t.is(ctx.signal.aborted, true);
});

test("registry: parentSignal aborts propagate to children", async (t: T) => {
  const r = createRequestRegistry();
  const parent = new AbortController();
  await using ctx = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
    parentSignal: parent.signal,
  });
  t.is(ctx.signal.aborted, false);
  parent.abort("shutdown");
  t.is(ctx.signal.aborted, true);
});

test("registry: duplicate requestId throws RequestIdConflictError", async (t: T) => {
  const r = createRequestRegistry();
  await using first = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
  });
  t.is(first.kind, "completion");
  await t.exception(() => {
    r.begin({ requestId: "r-1", kind: "completion", modelId: "m1" });
  }, RequestIdConflictError);
});

test("registry: end(requestId) sets state, disposes scope, and removes slot", async (t: T) => {
  const r = createRequestRegistry();
  let cleanupRan = 0;
  const ctx = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
  });
  ctx.scope.defer(() => {
    cleanupRan++;
  });

  await r.end("r-1", "completed");
  t.is(cleanupRan, 1, "scope unwound");
  t.is(ctx.state, "completed");
  t.is(r.get("r-1"), null);
});

test("registry: end without prior begin is a no-op", async (t: T) => {
  const r = createRequestRegistry();
  await r.end("does-not-exist", "completed");
  // no throw, no entries
  t.is(r.list().length, 0);
});

test("registry: end() detaches parent listener so long-lived parents don't accumulate listeners", async (t: T) => {
  // The `parentSignal` composition exists so a worker-level shutdown
  // signal can compose into per-request signals. Without an explicit
  // `detachParent` discipline, every `begin(...)` would leave a listener
  // on the long-lived parent for the lifetime of the worker — a slow
  // O(n requests) leak that's invisible until production-scale traffic.
  // Verify the listener is removed on the request's `end()` path.
  const parent = new AbortController();
  let adds = 0;
  let removes = 0;
  const origAdd = parent.signal.addEventListener.bind(parent.signal);
  const origRemove = parent.signal.removeEventListener.bind(parent.signal);
  parent.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
    adds++;
    return origAdd(...args);
  }) as typeof parent.signal.addEventListener;
  parent.signal.removeEventListener = ((
    ...args: Parameters<typeof origRemove>
  ) => {
    removes++;
    return origRemove(...args);
  }) as typeof parent.signal.removeEventListener;

  const r = createRequestRegistry();
  for (let i = 0; i < 5; i++) {
    const id = `r-${i}`;
    const ctx = r.begin({
      requestId: id,
      kind: "completion",
      modelId: "m1",
      parentSignal: parent.signal,
    });
    t.is(ctx.state, "running");
    await r.end(id, "completed");
  }
  t.is(adds, 5, "each begin() with parentSignal registered one listener");
  t.is(
    removes,
    5,
    "each end() removed it — long-lived parent doesn't accumulate listeners",
  );
});

test("registry: same-tick cancel-before-begin returns 0 and does not retroactively abort the later begin()", async (t: T) => {
  // Documents the current M1 behavior of the Stop-button race the
  // synchronous-`requestId` design property allows: client generates a
  // `requestId` and immediately fires `cancel({ requestId })` before the
  // server-side `begin(...)` lands. The registry has nothing to match,
  // so the cancel is a no-op — the subsequent `begin(...)` runs to
  // completion. M2's typed-cancel outcomes will close this gap (likely
  // via a small bounded "cancelled-before-begin" set checked by
  // `begin(...)`); this test pins the current contract so the M2 change
  // surfaces here.
  const r = createRequestRegistry();
  const cancelled = r.cancel({ requestId: "r-1" });
  t.is(cancelled, 0, "no entry yet — cancel returns 0");

  await using ctx = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
  });
  t.is(
    ctx.signal.aborted,
    false,
    "subsequent begin() is not retroactively aborted by the pre-begin cancel",
  );
  t.is(ctx.state, "running");
});

test("registry: derived terminal state is 'cancelled' if signal aborted, 'completed' otherwise", async (t: T) => {
  const r = createRequestRegistry();

  async function cancelledRun() {
    await using ctx = r.begin({
      requestId: "r-cancelled",
      kind: "completion",
      modelId: "m1",
    });
    r.cancel({ requestId: "r-cancelled" });
    return ctx;
  }
  const cancelled = await cancelledRun();
  t.is(cancelled.state, "cancelled");

  async function happyRun() {
    await using ctx = r.begin({
      requestId: "r-happy",
      kind: "completion",
      modelId: "m1",
    });
    return ctx;
  }
  const happy = await happyRun();
  t.is(happy.state, "completed");
});
