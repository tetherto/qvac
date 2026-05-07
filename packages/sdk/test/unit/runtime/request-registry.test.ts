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
