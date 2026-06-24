import test from "brittle";
import { AbortController } from "bare-abort-controller";
import {
  startOrJoinDownload,
  type DownloadContext,
} from "@/server/rpc/handlers/load-model/download-manager";
import { createDisposableScope } from "@/server/bare/runtime/disposable-scope";
import { InferenceCancelledError } from "@/utils/errors-server";

// -----------------------------------------------------------------------------
// download-manager: per-`requestId` cancel + content-addressed dedup.
//
// These tests pin the contract for `startOrJoinDownload`:
//
//   1. Two callers with the same `downloadKey` share one underlying
//      transfer (dedup preserved).
//   2. Cancelling one subscriber's `request.signal` rejects only that
//      subscriber's promise — the joined subscriber keeps running.
//   3. When the last subscriber leaves (cancel or scope unwind), the
//      transfer's `AbortController` fires so the network call tears
//      down. Until then the transfer keeps running.
//   4. `scope.defer(...)` is the safety net: if a handler exits without
//      cancelling, the deferred cleanup runs the same subscriber
//      removal path. Idempotent w.r.t. the abort listener.
//
// The download function is a manually-controlled promise so each test
// can choreograph "subscriber attaches → first cancel → second cancel
// → underlying transfer aborts" without timing dependencies.
// -----------------------------------------------------------------------------


interface ControllableDownload {
  start: (ctx: DownloadContext) => Promise<string>;
  ctx: DownloadContext | null;
  settle: (path: string) => void;
  reject: (err: unknown) => void;
  attached: Promise<DownloadContext>;
}

function makeControllableDownload(): ControllableDownload {
  let resolveAttached!: (ctx: DownloadContext) => void;
  const attached = new Promise<DownloadContext>((res) => {
    resolveAttached = res;
  });

  let resolveDownload!: (path: string) => void;
  let rejectDownload!: (err: unknown) => void;
  const downloadPromise = new Promise<string>((res, rej) => {
    resolveDownload = res;
    rejectDownload = rej;
  });

  const obj: ControllableDownload = {
    ctx: null,
    attached,
    settle: (path) => resolveDownload(path),
    reject: (err) => rejectDownload(err),
    start: (ctx: DownloadContext) => {
      obj.ctx = ctx;
      resolveAttached(ctx);
      return downloadPromise;
    },
  };
  return obj;
}

function bindingFromAbortController(
  ac: AbortController,
  requestId: string,
): {
  signal: AbortController["signal"];
  scope: ReturnType<typeof createDisposableScope>;
  requestId: string;
} {
  return {
    signal: ac.signal,
    scope: createDisposableScope(),
    requestId,
  };
}

test("download-manager: two callers with same key share one transfer", async (t) => {
  const dl = makeControllableDownload();
  const downloadKey = `dedup:${Math.random()}`;

  const acA = new AbortController();
  const acB = new AbortController();

  const first = startOrJoinDownload(
    downloadKey,
    dl.start,
    undefined,
    bindingFromAbortController(acA, "req-A"),
  );
  const second = startOrJoinDownload(
    downloadKey,
    () => {
      throw new Error(
        "second caller must reuse the existing transfer, not start a new one",
      );
    },
    undefined,
    bindingFromAbortController(acB, "req-B"),
  );

  t.is(first.joined, false, "first call starts the transfer");
  t.is(second.joined, true, "second call joins the existing transfer");

  await dl.attached;
  dl.settle("/cached/model.gguf");

  const [a, b] = await Promise.all([first.promise, second.promise]);
  t.is(a, "/cached/model.gguf");
  t.is(b, "/cached/model.gguf");
});

test("download-manager: cancelling one subscriber does not affect the other", async (t) => {
  const dl = makeControllableDownload();
  const downloadKey = `cancel-one:${Math.random()}`;

  const acA = new AbortController();
  const acB = new AbortController();

  const first = startOrJoinDownload(
    downloadKey,
    dl.start,
    undefined,
    bindingFromAbortController(acA, "req-A"),
  );
  const second = startOrJoinDownload(
    downloadKey,
    dl.start,
    undefined,
    bindingFromAbortController(acB, "req-B"),
  );

  await dl.attached;
  t.is(
    dl.ctx?.signal.aborted,
    false,
    "underlying transfer is not aborted while subscribers remain",
  );

  // Cancel only A. B is still attached so the underlying transfer
  // must keep running.
  acA.abort();

  await t.exception(
    async () => {
      await first.promise;
    },
    /cancel/i,
    "subscriber A's promise rejects with a cancel error",
  );

  // The underlying transfer must still be live for B.
  t.is(
    dl.ctx?.signal.aborted,
    false,
    "transfer keeps running while B is still subscribed",
  );

  dl.settle("/path/b.gguf");
  t.is(await second.promise, "/path/b.gguf");
});

test("download-manager: last subscriber leaving aborts the transfer", async (t) => {
  const dl = makeControllableDownload();
  const downloadKey = `last-sub:${Math.random()}`;

  const acA = new AbortController();
  const acB = new AbortController();

  const first = startOrJoinDownload(
    downloadKey,
    dl.start,
    undefined,
    bindingFromAbortController(acA, "req-A"),
  );
  const second = startOrJoinDownload(
    downloadKey,
    dl.start,
    undefined,
    bindingFromAbortController(acB, "req-B"),
  );

  await dl.attached;

  acA.abort();
  await t.exception(async () => {
    await first.promise;
  });
  t.is(
    dl.ctx?.signal.aborted,
    false,
    "transfer still alive after first cancel",
  );

  acB.abort();
  await t.exception(async () => {
    await second.promise;
  });
  t.is(
    dl.ctx?.signal.aborted,
    true,
    "transfer aborts when the last subscriber leaves",
  );

  // Reject the underlying download to flush the promise — required so
  // the test process exits cleanly. The settlement happens after both
  // subscribers have already settled with InferenceCancelledError, so
  // it has no observable effect.
  dl.reject(new Error("download aborted"));
});

test("download-manager: scope.defer is the safety net for handler-exit paths", async (t) => {
  const dl = makeControllableDownload();
  const downloadKey = `defer-unwind:${Math.random()}`;

  const ac = new AbortController();
  const binding = bindingFromAbortController(ac, "req-defer");

  const result = startOrJoinDownload(
    downloadKey,
    dl.start,
    undefined,
    binding,
  );

  await dl.attached;

  // Simulate a handler that returned without explicitly cancelling
  // (e.g. the request scope unwinds because the awaiting code path
  // threw for a non-cancel reason). The scope.defer-registered cleanup
  // must still remove the subscriber from the transfer.
  await binding.scope[Symbol.asyncDispose]();

  await t.exception(
    async () => {
      await result.promise;
    },
    /cancel/i,
    "scope unwind settles the subscriber via the deferred cleanup",
  );

  t.is(
    dl.ctx?.signal.aborted,
    true,
    "scope unwind on the sole subscriber aborts the underlying transfer",
  );

  dl.reject(new Error("download aborted"));
});

test("download-manager: cancel error carries the requestId", async (t) => {
  const dl = makeControllableDownload();
  const downloadKey = `cancel-id:${Math.random()}`;

  const ac = new AbortController();
  const result = startOrJoinDownload(
    downloadKey,
    dl.start,
    undefined,
    bindingFromAbortController(ac, "req-with-id"),
  );

  await dl.attached;
  ac.abort();

  try {
    await result.promise;
    t.ok(false, "promise should have rejected");
  } catch (err) {
    t.ok(
      err instanceof InferenceCancelledError,
      "rejection is an InferenceCancelledError",
    );
    if (err instanceof InferenceCancelledError) {
      t.is(
        err.requestId,
        "req-with-id",
        "the error preserves the requestId for downstream observability",
      );
    }
  }

  dl.reject(new Error("download aborted"));
});
