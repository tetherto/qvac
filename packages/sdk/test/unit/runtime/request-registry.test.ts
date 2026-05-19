// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  createRequestRegistry,
  __requestRegistryTestHooks,
} from "@/server/bare/runtime/request-registry";
import {
  RequestIdConflictError,
  RequestRejectedByPolicyError,
} from "@/utils/errors-server";

// -----------------------------------------------------------------------------
// RequestRegistry unit tests.
//
// Covers the contract the registry hands to handler authors:
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
  // The controller is aborted at begin time, so observers must see
  // `cancelling` rather than the momentarily-`running` state the
  // pre-cancel branch was already guarding against.
  t.is(ctx.state, "cancelling");
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

test("registry: same-tick cancel-before-begin retroactively aborts the later begin() (Stop-button race close)", async (t: T) => {
  // Stop-button race: the client generates a `requestId`
  // and the user clicks Stop before the server-side `begin(...)` for
  // that id has landed. The registry has nothing to abort, so the
  // immediate `cancel(...)` still returns 0 ("no in-flight match" is
  // still the truth on the wire). The id is recorded in a bounded
  // "cancelled-before-begin" set, and the subsequent `begin(...)`
  // checks the set: if its id is present, the new controller is
  // aborted before the context is returned and the entry is consumed.
  // The surface contract is documented in
  // `request-lifecycle-system.mdc`.
  const r = createRequestRegistry();
  const cancelled = r.cancel({ requestId: "r-1", reason: "stop-button" });
  t.is(
    cancelled,
    0,
    "no entry yet — cancel still returns 0 (race remembered, not retroactively counted)",
  );

  await using ctx = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
  });
  t.is(
    ctx.signal.aborted,
    true,
    "subsequent begin() is retroactively aborted by the pre-begin cancel",
  );
  t.is(
    ctx.state,
    "cancelling",
    "context starts in 'cancelling' so observers see a coherent state",
  );
  t.is(
    String((ctx.signal as { reason?: unknown }).reason),
    "stop-button",
    "the recorded cancel reason is forwarded to the aborted controller",
  );
});

test("registry: a second begin() with the same id (UUID retry) after the race is consumed runs cleanly", async (t: T) => {
  // The Stop-button race close consumes its entry on the matching
  // `begin(...)`. In practice ids are UUIDv4 and never reused, but a
  // buggy client could retry an id whose first attempt was already
  // aborted (and its scope torn down). The second begin must NOT see
  // a phantom pre-cancel — entries are single-use.
  const r = createRequestRegistry();
  r.cancel({ requestId: "r-1" });

  async function firstAttempt() {
    await using ctx = r.begin({
      requestId: "r-1",
      kind: "completion",
      modelId: "m1",
    });
    t.is(
      ctx.signal.aborted,
      true,
      "first attempt is aborted by the race close",
    );
  }
  await firstAttempt();

  await using second = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
  });
  t.is(
    second.signal.aborted,
    false,
    "second attempt with the same id is unaffected — pre-cancel entry was consumed",
  );
});

test("registry: bounded cancel-before-begin set does not grow past its cap (TTL + size eviction)", async (t: T) => {
  // The race-close map must be bounded so a malicious / buggy client
  // can't fire 100k `cancel({ requestId: <unique> })` calls and grow
  // the registry's memory unboundedly. The cap is documented at the
  // module top (`CANCEL_BEFORE_BEGIN_MAX_ENTRIES`) and exported via
  // `__requestRegistryTestHooks` for assertion stability.
  const r = createRequestRegistry();
  const cap = __requestRegistryTestHooks.cancelBeforeBeginMaxEntries;
  const overshoot = cap + 64; // fire well past the cap

  const sizeProbe = r as unknown as { __cancelBeforeBeginSize: () => number };

  for (let i = 0; i < overshoot; i++) {
    r.cancel({ requestId: `r-${i}` });
  }
  t.is(
    sizeProbe.__cancelBeforeBeginSize() <= cap,
    true,
    `internal map stays within the documented cap of ${cap} entries`,
  );

  // The oldest entries should have been evicted; the most recently
  // inserted id should still be honoured on the matching begin(...).
  const newestId = `r-${overshoot - 1}`;
  await using newest = r.begin({
    requestId: newestId,
    kind: "completion",
    modelId: "m1",
  });
  t.is(
    newest.signal.aborted,
    true,
    "the freshest pre-cancel still wins the race (oldest entries evicted, newest preserved)",
  );

  // And one of the early (presumed-evicted) ids should NOT trigger a
  // retroactive abort, because its entry was bumped out by the cap.
  await using ancient = r.begin({
    requestId: "r-0",
    kind: "completion",
    modelId: "m1",
  });
  t.is(
    ancient.signal.aborted,
    false,
    "an evicted pre-cancel no longer affects later begin() — bound holds",
  );
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

// -----------------------------------------------------------------------------
// Concurrency policy (Deliverable 2)
//
// Pins the `oneAtATimePerModel` admission rule registered via
// `registry.policy(...)`. The shared singleton wires this for the
// `completion` kind so two concurrent `completionStream` requests on
// the same model can't interleave on the llama.cpp KV-cache; these
// tests use an isolated registry instance so each policy variant can
// be exercised without contaminating the worker-wide one.
// -----------------------------------------------------------------------------

test("policy: oneAtATimePerModel rejects a second begin on the same (kind, modelId)", async (t: T) => {
  const r = createRequestRegistry();
  r.policy({ kind: "completion", oneAtATimePerModel: true });

  await using first = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
  });
  t.is(first.requestId, "r-1");

  // Throws the dedicated policy class so handler / RPC code can
  // `instanceof` narrow without parsing the error message.
  await t.exception(() => {
    r.begin({
      requestId: "r-2",
      kind: "completion",
      modelId: "m1",
    });
  }, RequestRejectedByPolicyError);

  // The rejected begin must not leave a slot behind — the registry's
  // in-flight set still only carries the first request.
  t.is(r.list().length, 1);
  t.is(r.get("r-2"), null);
});

test("policy: oneAtATimePerModel scopes admission per (kind, modelId), not globally", async (t: T) => {
  const r = createRequestRegistry();
  r.policy({ kind: "completion", oneAtATimePerModel: true });

  // Same kind, different model — allowed.
  await using a = r.begin({
    requestId: "r-a",
    kind: "completion",
    modelId: "m1",
  });
  await using b = r.begin({
    requestId: "r-b",
    kind: "completion",
    modelId: "m2",
  });
  t.is(a.modelId, "m1");
  t.is(b.modelId, "m2");

  // Different kind, same model — allowed because the policy is keyed
  // by `kind`. (Today only `completion` carries a policy; an
  // embeddings request piggy-backing on the same model is fine.)
  await using c = r.begin({
    requestId: "r-c",
    kind: "embeddings",
    modelId: "m1",
  });
  t.is(c.kind, "embeddings");

  t.is(r.list().length, 3);
});

test("policy: oneAtATimePerModel ignores requests without modelId", async (t: T) => {
  const r = createRequestRegistry();
  r.policy({ kind: "completion", oneAtATimePerModel: true });

  // Both have no modelId — policy has no key to match against, so
  // both are admitted. This is the documented behaviour for
  // model-less requests (e.g. handlers that don't yet attach a
  // modelId to their `begin(...)` call).
  await using a = r.begin({ requestId: "r-a", kind: "completion" });
  await using b = r.begin({ requestId: "r-b", kind: "completion" });
  t.is(a.modelId, undefined);
  t.is(b.modelId, undefined);
  t.is(r.list().length, 2);
});

test("policy: disposing the holder releases admission for the next request", async (t: T) => {
  const r = createRequestRegistry();
  r.policy({ kind: "completion", oneAtATimePerModel: true });

  async function runFirstThenSecond() {
    {
      await using first = r.begin({
        requestId: "r-1",
        kind: "completion",
        modelId: "m1",
      });
      t.is(first.requestId, "r-1");
    }
    // Once the await-using block above unwinds, the slot is released.
    await using second = r.begin({
      requestId: "r-2",
      kind: "completion",
      modelId: "m1",
    });
    t.is(second.requestId, "r-2");
  }
  await runFirstThenSecond();
});

test("policy: cancel without dispose does NOT release admission", async (t: T) => {
  // The slot is held until the handler scope unwinds, not when the
  // request is cancelled — the addon's KV-cache / decode loop is
  // still owned by the cancelled request as it drains. A future
  // contributor reading the brief criterion alone might assume
  // `cancel()` clears admission; this test pins the actual contract.
  const r = createRequestRegistry();
  r.policy({ kind: "completion", oneAtATimePerModel: true });

  await using first = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
  });
  r.cancel({ requestId: "r-1" });
  t.is(first.signal.aborted, true);
  t.is(first.state, "cancelling");

  await t.exception(
    () =>
      r.begin({
        requestId: "r-2",
        kind: "completion",
        modelId: "m1",
      }),
    RequestRejectedByPolicyError,
  );
  t.is(r.list().length, 1);
});

test("policy: registering a second time replaces the previous policy", async (t: T) => {
  const r = createRequestRegistry();
  r.policy({ kind: "completion", oneAtATimePerModel: true });
  r.policy({ kind: "completion", oneAtATimePerModel: false });

  // Disabling the rule re-opens admission — concurrent begins on the
  // same `(kind, modelId)` are accepted again.
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
  t.is(r.list().length, 2);
  t.is(a.modelId, "m1");
  t.is(b.modelId, "m1");
});

test("policy: kinds without a registered policy are unconstrained", async (t: T) => {
  const r = createRequestRegistry();
  // No `r.policy(...)` call for `embeddings` — admission must stay
  // open even though `completion` carries a strict rule.
  r.policy({ kind: "completion", oneAtATimePerModel: true });

  await using a = r.begin({
    requestId: "r-a",
    kind: "embeddings",
    modelId: "m1",
  });
  await using b = r.begin({
    requestId: "r-b",
    kind: "embeddings",
    modelId: "m1",
  });
  t.is(r.list().length, 2);
  t.is(a.kind, "embeddings");
  t.is(b.kind, "embeddings");
});
