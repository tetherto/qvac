import test from "brittle";
import { decoratePromise } from "@/utils/decorate-promise";

// -----------------------------------------------------------------------------
// decoratePromise unit tests.
//
// Locks in the contract the long-running client-API helpers depend on:
//   - awaiting a decorated promise still unwraps to T (backward-compat
//     pin — if this goes red the `loadModel(...)`/`downloadAsset(...)`
//     consumers will silently start getting the wrapper object instead
//     of the model id / asset id).
//   - the metadata is reachable synchronously before the inner promise
//     settles — that's the "grab `op.requestId` then cancel before the
//     network call resolves" use case.
//   - rejection still propagates through `await` so callers see the
//     original error (no swallowing).
//   - the helper returns the same object identity — `decorate` mutates
//     in place via `Object.assign`. We rely on this so the inner
//     promise's `.then` chain keeps working without re-wrapping.
// -----------------------------------------------------------------------------


test("decoratePromise: await still unwraps to T (backward-compat)", async (t) => {
  const inner = Promise.resolve("model-id-123");
  const op = decoratePromise(inner, { requestId: "abc" });

  const result = await op;
  t.is(
    result,
    "model-id-123",
    "await on decorated promise must return the inner T, not the wrapper",
  );
  t.is(typeof result, "string", "result type is preserved");
});

test("decoratePromise: metadata reachable synchronously before settle", async (t) => {
  // Promise that won't settle for a tick — we want to read `requestId`
  // synchronously before it does.
  let resolveInner!: (value: string) => void;
  const inner = new Promise<string>((resolve) => {
    resolveInner = resolve;
  });
  const op = decoratePromise(inner, { requestId: "sync-id" });

  t.is(
    op.requestId,
    "sync-id",
    "requestId must be readable synchronously after decorate",
  );

  resolveInner("done");
  const result = await op;
  t.is(result, "done");
  t.is(op.requestId, "sync-id", "metadata still present after settle");
});

test("decoratePromise: rejection propagates through await", async (t) => {
  const inner = Promise.reject(new Error("inner failure"));
  const op = decoratePromise(inner, { requestId: "rej-id" });

  // Read the metadata first to confirm it's there even on a rejecting
  // promise; this is the path consumers use in a `try { await op } catch`.
  t.is(op.requestId, "rej-id");

  await t.exception(async () => {
    await op;
  }, /inner failure/);
});

test("decoratePromise: returns the same object identity (in-place assign)", (t) => {
  const inner = Promise.resolve(42);
  const op = decoratePromise(inner, { requestId: "id-1" });

  t.is(
    op,
    inner,
    "decoratePromise must mutate in place; the returned promise is the input promise",
  );
});

test("decoratePromise: .then / .catch / .finally chain intact", async (t) => {
  const inner = Promise.resolve("piped");
  const op = decoratePromise(inner, { requestId: "chain-id" });

  let finallyRan = false;
  const piped = await op
    .then((v) => `${v}-then`)
    .finally(() => {
      finallyRan = true;
    });

  t.is(piped, "piped-then", ".then must keep flowing through the decoration");
  t.ok(finallyRan, ".finally must fire");
  t.is(
    op.requestId,
    "chain-id",
    "metadata stays on the original op even after chaining",
  );
});

test("decoratePromise: multiple metadata fields are all attached", async (t) => {
  const inner = Promise.resolve("v");
  const op = decoratePromise(inner, {
    requestId: "multi-id",
    kind: "loadModel",
    seq: 7,
  });

  t.is(op.requestId, "multi-id");
  t.is(op.kind, "loadModel");
  t.is(op.seq, 7);
  t.is(await op, "v");
});
