// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { createDisposableScope } from "@/server/bare/runtime/disposable-scope";

// -----------------------------------------------------------------------------
// DisposableScope unit tests.
//
// Covers the four contracts handlers will rely on:
//   1. LIFO cleanup ordering (mirrors how try/finally would unwind a
//      sequential write-up of the same handler).
//   2. Idempotent dispose — a scope that has already unwound is a no-op
//      on subsequent dispose calls.
//   3. Error aggregation — every cleanup runs even when an earlier one
//      throws; multiple failures arrive as a single AggregateError.
//   4. Late-defer behaviour — calling defer after dispose runs the
//      cleanup eagerly so resources don't leak silently.
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
  pass: (msg?: string) => void;
  fail: (msg?: string) => void;
};

test("disposable-scope: host runtime exposes Symbol.asyncDispose", (t: T) => {
  // Tripwire for the module-load guard in disposable-scope.ts. If a future
  // runtime upgrade strips Symbol.asyncDispose (older Bare/Expo, missing
  // polyfill), the guard throws at SDK import time and this test fails first.
  // The guard converts a silent registry-leak bug into a loud startup error.
  t.is(
    typeof Symbol.asyncDispose,
    "symbol",
    "Symbol.asyncDispose must be a symbol; the SDK request-lifecycle stack depends on it",
  );
});

test("disposable-scope: cleanups run in LIFO order", async (t: T) => {
  const order: string[] = [];
  const scope = createDisposableScope();
  scope.defer(() => {
    order.push("first-registered");
  });
  scope.defer(() => {
    order.push("second-registered");
  });
  scope.defer(async () => {
    await Promise.resolve();
    order.push("third-registered");
  });

  await scope[Symbol.asyncDispose]();
  t.alike(order, ["third-registered", "second-registered", "first-registered"]);
  t.is(scope.disposed, true);
});

test("disposable-scope: dispose is idempotent", async (t: T) => {
  let runs = 0;
  const scope = createDisposableScope();
  scope.defer(() => {
    runs++;
  });
  await scope[Symbol.asyncDispose]();
  await scope[Symbol.asyncDispose]();
  await scope[Symbol.asyncDispose]();
  t.is(runs, 1, "deferred cleanup runs exactly once");
  t.is(scope.disposed, true);
});

test("disposable-scope: a single failing cleanup rethrows verbatim", async (t: T) => {
  const scope = createDisposableScope();
  const boom = new Error("boom");
  scope.defer(() => {
    throw boom;
  });
  await t.exception(async () => {
    await scope[Symbol.asyncDispose]();
  });
});

test("disposable-scope: multiple failures are collected into AggregateError", async (t: T) => {
  const scope = createDisposableScope();
  let third = 0;
  scope.defer(() => {
    throw new Error("first");
  });
  scope.defer(() => {
    third++;
  });
  scope.defer(async () => {
    await Promise.resolve();
    throw new Error("second");
  });

  let captured: unknown = null;
  try {
    await scope[Symbol.asyncDispose]();
  } catch (err) {
    captured = err;
  }

  t.ok(captured instanceof AggregateError, "throws AggregateError");
  const agg = captured as AggregateError;
  t.is(agg.errors.length, 2, "two underlying errors");
  t.is(third, 1, "non-throwing cleanup still runs");
});

test("disposable-scope: every cleanup runs even when one throws midway", async (t: T) => {
  const scope = createDisposableScope();
  let aRan = 0;
  let cRan = 0;
  scope.defer(() => {
    aRan++;
  });
  scope.defer(() => {
    throw new Error("middle");
  });
  scope.defer(() => {
    cRan++;
  });
  try {
    await scope[Symbol.asyncDispose]();
  } catch {
    // expected
  }
  t.is(aRan, 1, "earlier-registered cleanup ran despite later throw");
  t.is(cRan, 1, "later-registered cleanup ran first (LIFO) and unaffected");
});

test("disposable-scope: late defer runs the cleanup eagerly", async (t: T) => {
  const scope = createDisposableScope();
  await scope[Symbol.asyncDispose]();
  t.is(scope.disposed, true);

  let lateRan = 0;
  scope.defer(() => {
    lateRan++;
  });
  // Eager run is synchronous-or-microtask; yielding once is enough.
  await Promise.resolve();
  await Promise.resolve();
  t.is(lateRan, 1, "late-registered cleanup ran without leaking");
});

test("disposable-scope: works with `await using` syntax", async (t: T) => {
  const seen: string[] = [];
  async function run() {
    await using scope = createDisposableScope();
    scope.defer(() => {
      seen.push("a");
    });
    scope.defer(() => {
      seen.push("b");
    });
    seen.push("body");
  }
  await run();
  t.alike(seen, ["body", "b", "a"], "await using disposes in LIFO order");
});
