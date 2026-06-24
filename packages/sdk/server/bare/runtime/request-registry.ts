import { AbortController, type AbortSignal } from "bare-abort-controller";
import {
  createDisposableScope,
  type DisposableScope,
} from "@/server/bare/runtime/disposable-scope";
import type {
  RequestContext,
  RequestKind,
  RequestState,
} from "@/server/bare/runtime/request-context";
import {
  RequestIdConflictError,
  RequestRejectedByPolicyError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import type { Logger } from "@/logging/types";

/**
 * Outcome the caller declares when terminating a request through
 * `registry.end(...)`. The registry maps it to a terminal `RequestState`
 * before disposing the scope so observers see a coherent final state.
 */
export type RequestOutcome = "completed" | "failed" | "cancelled";

export interface BeginOpts {
  /** Stable identity. Caller-provided so the client and server agree. */
  requestId: string;
  kind: RequestKind;
  modelId?: string;
  /**
   * Optional parent abort signal — typically the worker-level "shutdown"
   * signal. When the parent aborts, the request's own signal aborts too.
   * Composes through a `addEventListener("abort", ...)` hook so cancelling
   * the parent does not require iterating the registry.
   */
  parentSignal?: AbortSignal;
}

export interface CancelByRequestId {
  requestId: string;
  reason?: string;
}

export interface CancelByModelId {
  modelId: string;
  kind?: RequestKind;
  reason?: string;
}

export type CancelTarget = CancelByRequestId | CancelByModelId;

/**
 * Per-kind admission rule. Kinds without a registered policy have no
 * admission control (every `begin(...)` is accepted as long as the
 * request id is unique).
 *
 * The policy turns admission into a per-`(kind, modelId)` FIFO queue with
 * a configurable concurrency limit. A second concurrent request to the
 * same `(kind, modelId)` *waits its turn* (default) rather than colliding
 * on the single native llama.cpp context. The limit is forward-compatible
 * with addon-side continuous batching: bump `maxConcurrentPerModel` to the
 * addon's slot count to flip serial execution to N-way concurrent without
 * any further SDK change.
 *
 * Requests without a `modelId` are never gated (there is no per-model
 * identity to serialize against).
 */
export interface ConcurrencyPolicy {
  kind: RequestKind;
  /**
   * Max simultaneously in-flight requests per `(kind, modelId)`.
   * Default: `Infinity` (no admission limit). Set `1` to serialize, or
   * `N` for N-way concurrency (the future continuous-batching slot
   * count). Non-finite values disable gating entirely.
   */
  maxConcurrentPerModel?: number;
  /**
   * What a `begin(...)` does when the `(kind, modelId)` is at capacity:
   *  - `"queue"` (default): wait FIFO for a slot to free.
   *  - `"reject"`: throw `RequestRejectedByPolicyError` immediately
   *    (the legacy `oneAtATimePerModel` behavior).
   */
  onOverflow?: "queue" | "reject";
  /**
   * Max waiters allowed to queue per `(kind, modelId)` before further
   * begins reject with `RequestRejectedByPolicyError`. Bounds memory so a
   * runaway client can't grow the queue without limit. Default: `64`.
   * Only consulted when `onOverflow` is `"queue"`.
   */
  maxQueueDepthPerModel?: number;
  /**
   * Reject a waiter that has waited longer than this many milliseconds
   * with `RequestRejectedByPolicyError`. Default: `undefined` (wait
   * indefinitely for a slot).
   */
  queueTimeoutMs?: number;
  /**
   * @deprecated Back-compat alias. `true` normalizes to
   * `{ maxConcurrentPerModel: 1, onOverflow: "reject" }`; `false` (or
   * omitted) leaves admission unlimited. Ignored when
   * `maxConcurrentPerModel` is set explicitly.
   */
  oneAtATimePerModel?: boolean;
}

/**
 * `ManagedRequestContext` is the value `begin(...)` resolves to. It extends
 * `RequestContext` with an async-dispose method so handlers can write:
 *
 *   await using ctx = await registry.begin({ ... });
 *
 * On dispose the scope unwinds (LIFO cleanup) and the registry slot is
 * freed. If the handler doesn't override `ctx.state` before unwinding,
 * the registry derives the terminal state from `signal.aborted` —
 * `"cancelled"` when an abort was recorded, `"completed"` otherwise.
 */
export interface ManagedRequestContext extends RequestContext {
  [Symbol.asyncDispose](): Promise<void>;
}

export interface RequestRegistry {
  /**
   * Open a new request. Returns a promise because admission may *queue*:
   * when a concurrency policy caps the `(kind, modelId)` and it's at
   * capacity with `onOverflow: "queue"`, the promise resolves once a slot
   * frees (FIFO). Callers write `await using ctx = await registry.begin(...)`.
   *
   * Rejects with:
   *  - `RequestIdConflictError` if `requestId` is already present
   *    (UUIDv4 collision is astronomically unlikely; the guard exists
   *    so a buggy client retry sending the same id can't silently
   *    overwrite an in-flight request).
   *  - `RequestRejectedByPolicyError` if a concurrency policy was
   *    registered for `opts.kind` and the new request can't be admitted:
   *    `onOverflow: "reject"` at capacity, the queue depth cap is
   *    exceeded, or the waiter's `queueTimeoutMs` elapsed.
   */
  begin(opts: BeginOpts): Promise<ManagedRequestContext>;

  /**
   * Register or replace the concurrency policy for a `RequestKind`.
   * Subsequent `begin(...)` calls for that kind run the policy before
   * allocating a controller / scope. One policy per kind — calling
   * twice replaces the previous declaration.
   *
   * @example
   *   r.policy({ kind: "completion", maxConcurrentPerModel: 1, onOverflow: "reject" });
   *   await using a = await r.begin({ requestId: "r-1", kind: "completion", modelId: "m1" });
   *   await r.begin({ requestId: "r-2", kind: "completion", modelId: "m1" });
   *   // → rejects with RequestRejectedByPolicyError (code 52420)
   */
  policy(opts: ConcurrencyPolicy): void;

  /** Look up an in-flight request by id. */
  get(requestId: string): RequestContext | null;

  /**
   * Snapshot of currently-tracked requests. Useful for diagnostics /
   * structured logs ("which requests are in flight right now?"). Returns
   * a fresh array; mutations on it are not observed by the registry.
   */
  list(): RequestContext[];

  /**
   * Cancel matching requests. Returns the number of contexts whose abort
   * was triggered by *this* call (already-cancelled contexts are skipped
   * so callers can rely on the count to log "n requests cancelled" once).
   *
   * For `{ modelId }` and an optional `kind`, cancels every active
   * request that matches the predicate. This is the broad-cancel path
   * the pre-registry `cancel({ modelId })` API maps to.
   */
  cancel(target: CancelTarget): number;

  /**
   * Cancel every active request — the worker-shutdown / model-unload
   * sweep. The reason is forwarded to each request as the abort reason
   * so handler logs can distinguish a normal cancel from a sweep.
   * Resolves once all targeted contexts have flipped to `"cancelling"`;
   * scope unwinding still happens on each handler's own dispose path.
   */
  cancelAll(reason: "shutdown" | "modelUnload"): Promise<void>;

  /**
   * Mark a request finished and dispose its scope. Equivalent to
   * `await ctx[Symbol.asyncDispose]()` with an explicit outcome.
   * Idempotent — calling `end` after a scope dispose is a no-op.
   */
  end(requestId: string, outcome: RequestOutcome): Promise<void>;
}

interface RegistryEntry {
  ctx: RequestContext;
  controller: AbortController;
  scope: DisposableScope;
  /**
   * Cleanup hook removed from `parentSignal` after the request ends, so
   * a long-lived shutdown signal doesn't accumulate per-request listeners
   * for the lifetime of the worker.
   */
  detachParent: () => void;
  /** `Date.now()` at `begin(...)` — used for `durationMs` on the end emit. */
  startedAt: number;
  /**
   * Admission-slot key (`<kind>\0<modelId>`) this request holds, or
   * `undefined` when the request was admitted without gating (no policy,
   * no `modelId`, or an unbounded `maxConcurrentPerModel`). The slot is
   * handed back in `disposeEntry` once the scope has fully unwound.
   */
  slotKey: string | undefined;
}

/**
 * Bookkeeping entry for a `cancel({ requestId })` that arrived before
 * the matching `begin({ requestId })` ran. Used to close the
 * Stop-button race.
 */
interface CancelBeforeBeginEntry {
  /** `Date.now()` snapshot for TTL eviction. */
  at: number;
  /** Forwarded to `controller.abort(reason)` once `begin(...)` arrives. */
  reason?: string;
}

/**
 * A `ConcurrencyPolicy` resolved to its effective numeric form. Computed
 * once in `policy(...)` (cheap, default-filled) so the hot `begin(...)`
 * path reads concrete numbers instead of re-deriving the legacy
 * `oneAtATimePerModel` alias on every call.
 */
interface NormalizedPolicy {
  /** Effective slots per `(kind, modelId)`. `Infinity` ⇒ no gating. */
  maxConcurrent: number;
  onOverflow: "queue" | "reject";
  maxQueueDepth: number;
  queueTimeoutMs: number | undefined;
}

/**
 * One queued `begin(...)` awaiting an admission slot. `resolve(true)` hands
 * the waiter the freed slot (it inherits the in-flight count — see
 * `releaseSlot`); `resolve(false)` releases it without a slot (graceful
 * cancel-while-queued, where the request proceeds only to observe its
 * already-aborted signal); `reject(err)` fails the awaiting `begin(...)`.
 */
interface SlotWaiter {
  requestId: string;
  kind: RequestKind;
  modelId: string;
  enqueuedAt: number;
  resolve: (granted: boolean) => void;
  reject: (err: unknown) => void;
  /** `queueTimeoutMs` timer, cleared on resolve / reject / drain. */
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Per-`(kind, modelId)` admission state: the count of requests currently
 * holding a slot plus the FIFO queue of waiters. Deleted from `keyStates`
 * as soon as it is fully idle (`active === 0 && waiters.length === 0`) so
 * the map stays proportional to live models, not all models ever seen.
 */
interface KeyState {
  active: number;
  waiters: SlotWaiter[];
}

/**
 * Tuning knobs for the "cancelled-before-begin" bookkeeping set.
 *
 * The race window is bounded by the client-to-server round-trip: a
 * `cancel({ requestId })` issued by the client at the same time as the
 * matching `completion(...)` either lands first (and we need to remember
 * it long enough for the server's `begin(...)` to follow) or lands
 * second (and we never touch this set). 30 seconds is overkill for a
 * 500ms round-trip but gives slow networks / pause-the-debugger
 * scenarios enough slack while still bounding worst-case retention.
 *
 * The size cap protects against a buggy or malicious client firing a
 * stream of cancels for ids that never get a `begin(...)` follow-up —
 * each `cancel({ requestId })` that doesn't match an in-flight context
 * inserts one entry, so without a cap the worker would grow the map
 * unbounded. At the cap, the oldest entry is evicted.
 *
 * Tweak with care: both bounds appear in the registry race test
 * (`bounded cancel-before-begin set does not grow past its cap`).
 */
const CANCEL_BEFORE_BEGIN_MAX_ENTRIES = 128;
const CANCEL_BEFORE_BEGIN_TTL_MS = 30_000;

/**
 * Default cap on waiters queued per `(kind, modelId)` when a policy uses
 * `onOverflow: "queue"` without an explicit `maxQueueDepthPerModel`.
 * Bounds memory so a misbehaving client firing a flood of same-model
 * requests can't grow the queue without limit — the (depth + 1)th begin
 * rejects with `RequestRejectedByPolicyError` instead of enqueuing.
 */
const DEFAULT_MAX_QUEUE_DEPTH_PER_MODEL = 64;

export function createRequestRegistry(options?: {
  /** Defaults to `getServerLogger()`. Tests inject a stub. */
  logger?: Logger;
}): RequestRegistry {
  const entries = new Map<string, RegistryEntry>();
  const policies = new Map<RequestKind, NormalizedPolicy>();
  const logger = options?.logger ?? getServerLogger();

  /**
   * Per-`(kind, modelId)` admission semaphores. Keyed by
   * `slotKey(kind, modelId)`. Absent until the first gated `begin(...)`
   * for that key; removed again the moment the key is idle.
   */
  const keyStates = new Map<string, KeyState>();
  /**
   * Reverse index from a queued waiter's `requestId` to its slot so
   * `cancel({ requestId })` can pull a still-queued request out of the
   * FIFO in O(1) without scanning every `KeyState`.
   */
  const waitersById = new Map<string, { key: string; waiter: SlotWaiter }>();

  function logLifecycle(
    event: "begin" | "cancel" | "end",
    ctx: RequestContext,
    durationMs?: number,
  ): void {
    const modelId = ctx.modelId !== undefined ? ctx.modelId : "-";
    const base = `[request-lifecycle] ${event} requestId=${ctx.requestId} kind=${ctx.kind} modelId=${modelId} state=${ctx.state}`;
    const line = durationMs !== undefined ? `${base} durationMs=${durationMs}` : base;
    // `failed` end emits at `warn` so log shippers can alert on
    // `level>=warn` for this prefix without parsing `state=failed`
    // out of the message body. Everything else stays at `info`.
    if (event === "end" && ctx.state === "failed") {
      logger.warn(line);
    } else {
      logger.info(line);
    }
  }

  /**
   * "Cancelled-before-begin" tripwire. A
   * `cancel({ requestId })` whose target isn't yet in `entries` records
   * the id here; the subsequent `begin({ requestId: <same id> })` then
   * aborts the new controller before returning. Map order is insertion
   * order — the iterator's first key is the oldest entry, which makes
   * the size-cap eviction free.
   *
   * Invariants:
   *   - Every read path (`begin`, `cancel`-by-id) calls
   *     `pruneCancelBeforeBeginExpired()` first so a 30s+ stale entry
   *     never decides a fresh `begin(...)`.
   *   - Insertion enforces the size cap by evicting the oldest entry
   *     when at capacity — a malicious client cannot grow this map
   *     unbounded.
   *   - On a successful `begin(...)` match, the entry is consumed
   *     (removed) so a second `begin(...)` with the same id (which
   *     would itself throw `RequestIdConflictError`) doesn't see a
   *     phantom pre-cancel.
   */
  const cancelledBeforeBegin = new Map<string, CancelBeforeBeginEntry>();

  function pruneCancelBeforeBeginExpired(now: number = Date.now()): void {
    if (cancelledBeforeBegin.size === 0) return;
    const cutoff = now - CANCEL_BEFORE_BEGIN_TTL_MS;
    for (const [id, entry] of cancelledBeforeBegin) {
      if (entry.at > cutoff) break; // Insertion order ⇒ rest are newer.
      cancelledBeforeBegin.delete(id);
    }
  }

  function recordCancelBeforeBegin(
    requestId: string,
    reason: string | undefined,
  ): void {
    const now = Date.now();
    pruneCancelBeforeBeginExpired(now);
    // Re-canceling an id that is already tracked refreshes its TTL but
    // keeps the original reason — the first cancel "won" the race.
    if (cancelledBeforeBegin.has(requestId)) {
      const existing = cancelledBeforeBegin.get(requestId)!;
      cancelledBeforeBegin.delete(requestId);
      cancelledBeforeBegin.set(requestId, { ...existing, at: now });
      return;
    }
    if (cancelledBeforeBegin.size >= CANCEL_BEFORE_BEGIN_MAX_ENTRIES) {
      const oldest = cancelledBeforeBegin.keys().next().value;
      if (oldest !== undefined) cancelledBeforeBegin.delete(oldest);
    }
    cancelledBeforeBegin.set(
      requestId,
      reason !== undefined ? { at: now, reason } : { at: now },
    );
  }

  function consumeCancelBeforeBegin(
    requestId: string,
  ): CancelBeforeBeginEntry | undefined {
    pruneCancelBeforeBeginExpired();
    const entry = cancelledBeforeBegin.get(requestId);
    if (!entry) return undefined;
    cancelledBeforeBegin.delete(requestId);
    return entry;
  }

  function slotKey(kind: RequestKind, modelId: string): string {
    // NUL separator can't appear in a kind (closed union) or a modelId
    // (sdkModelId is a generated handle), so the join is unambiguous.
    return `${kind}\u0000${modelId}`;
  }

  /**
   * Pull a waiter out of its queue and tidy up: clear its timeout, drop
   * the reverse index, and delete the `KeyState` if that left it idle.
   * Does NOT settle the waiter's promise — the caller decides whether the
   * removal resolves (granted / graceful cancel) or rejects (timeout /
   * teardown).
   */
  function removeWaiter(key: string, waiter: SlotWaiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    waitersById.delete(waiter.requestId);
    const st = keyStates.get(key);
    if (!st) return;
    const i = st.waiters.indexOf(waiter);
    if (i >= 0) st.waiters.splice(i, 1);
    if (st.active <= 0 && st.waiters.length === 0) keyStates.delete(key);
  }

  /**
   * Admission gate. Resolves to the slot key the caller must release on
   * dispose, or `undefined` when the request is ungated (no policy, no
   * `modelId`, an unbounded limit, or an already-aborted parent — which we
   * let through so the normal abort path produces a clean cancelled
   * outcome rather than queuing a doomed request).
   *
   * When the key is at capacity it either rejects (`onOverflow: "reject"`,
   * queue-depth cap, or `queueTimeoutMs`) or enqueues a FIFO waiter and
   * awaits it. The releaser hands a freed slot to the oldest waiter
   * (`resolve(true)`), so `active` is never decremented and re-incremented
   * across a hand-off — that's what guarantees FIFO fairness with no
   * acquire/release race in the single-threaded event loop.
   */
  async function acquireSlot(
    opts: BeginOpts,
  ): Promise<{ slotKey: string | undefined }> {
    if (opts.modelId === undefined) return { slotKey: undefined };
    const policy = policies.get(opts.kind);
    if (!policy || !Number.isFinite(policy.maxConcurrent)) {
      return { slotKey: undefined };
    }
    // A parent (worker-shutdown) signal that's already aborted: don't
    // queue behind live work that may never drain — let begin() proceed
    // and abort immediately via the parentSignal path.
    if (opts.parentSignal?.aborted) return { slotKey: undefined };

    const modelId = opts.modelId;
    const key = slotKey(opts.kind, modelId);
    let st = keyStates.get(key);
    if (!st) {
      st = { active: 0, waiters: [] };
      keyStates.set(key, st);
    }

    if (st.active < policy.maxConcurrent) {
      st.active++;
      return { slotKey: key };
    }

    if (policy.onOverflow === "reject") {
      throw new RequestRejectedByPolicyError(
        opts.requestId,
        opts.kind,
        modelId,
        `another ${opts.kind} request is already running on this model`,
      );
    }

    if (st.waiters.length >= policy.maxQueueDepth) {
      throw new RequestRejectedByPolicyError(
        opts.requestId,
        opts.kind,
        modelId,
        `request queue for this model is full (${st.waiters.length} waiting)`,
      );
    }

    const queue = st;
    const granted = await new Promise<boolean>((resolve, reject) => {
      const waiter: SlotWaiter = {
        requestId: opts.requestId,
        kind: opts.kind,
        modelId,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        timer: undefined,
      };
      if (policy.queueTimeoutMs !== undefined) {
        const timeoutMs = policy.queueTimeoutMs;
        waiter.timer = setTimeout(() => {
          removeWaiter(key, waiter);
          reject(
            new RequestRejectedByPolicyError(
              opts.requestId,
              opts.kind,
              modelId,
              `timed out waiting ${timeoutMs}ms for a slot on this model`,
            ),
          );
        }, timeoutMs);
      }
      queue.waiters.push(waiter);
      waitersById.set(opts.requestId, { key, waiter });
    });

    return granted ? { slotKey: key } : { slotKey: undefined };
  }

  /**
   * Hand a freed slot to the next FIFO waiter, or free it outright when
   * none are queued. Called from `disposeEntry` after the scope has fully
   * unwound, so the native context is genuinely free before the next
   * same-model request is admitted.
   */
  function releaseSlot(key: string): void {
    const st = keyStates.get(key);
    if (!st) return;
    const next = st.waiters.shift();
    if (next) {
      // Hand off: the waiter inherits the slot, so `active` is unchanged.
      waitersById.delete(next.requestId);
      if (next.timer !== undefined) {
        clearTimeout(next.timer);
        next.timer = undefined;
      }
      next.resolve(true);
      return;
    }
    st.active--;
    if (st.active <= 0 && st.waiters.length === 0) keyStates.delete(key);
  }

  function cancelEntry(entry: RegistryEntry, reason?: string): boolean {
    if (entry.controller.signal.aborted) return false;
    entry.ctx.state = "cancelling";
    entry.controller.abort(reason);
    logLifecycle("cancel", entry.ctx);
    return true;
  }

  async function disposeEntry(
    entry: RegistryEntry,
    outcome: RequestOutcome,
  ): Promise<void> {
    if (entry.scope.disposed) return;
    entry.ctx.state = outcome;
    entry.detachParent();
    logLifecycle("end", entry.ctx, Date.now() - entry.startedAt);
    // Pull the entry out before unwinding so observers (e.g. a `cancel(...)`
    // racing with dispose) don't see a half-disposed context.
    entries.delete(entry.ctx.requestId);
    try {
      await entry.scope[Symbol.asyncDispose]();
    } finally {
      // Release the admission slot only after the scope has fully unwound:
      // the shared llama.cpp context / addon job is torn down in scope
      // cleanup, so the next queued same-model request must not be admitted
      // (and start decoding) until this one has actually let go. `finally`
      // guarantees the slot is freed even if a deferred cleanup throws,
      // otherwise a throwing teardown would strand the queue forever.
      if (entry.slotKey !== undefined) releaseSlot(entry.slotKey);
    }
  }

  async function begin(opts: BeginOpts): Promise<ManagedRequestContext> {
    // A request id is reserved for its whole lifecycle, including the time
    // it spends *queued* for an admission slot. `waitersById` holds the
    // still-queued begins (they aren't in `entries` yet), so a duplicate id
    // must be rejected against both maps — otherwise a second begin with the
    // same id would enqueue behind the first and overwrite its `waitersById`
    // index, leaving the original waiter unreachable by `cancel({ requestId })`.
    if (entries.has(opts.requestId) || waitersById.has(opts.requestId)) {
      throw new RequestIdConflictError(opts.requestId);
    }

    // Admission control runs before allocation so a rejected begin leaves
    // no controller / scope behind. This may await: a gated `(kind,
    // modelId)` at capacity queues the begin FIFO and resolves once a slot
    // frees (or rejects on overflow / queue-depth cap / timeout).
    const { slotKey } = await acquireSlot(opts);

    // The only interleaving point in this otherwise synchronous body is the
    // await above. A duplicate id could (astronomically unlikely) have
    // landed while we were queued — re-check and hand the just-acquired
    // slot back rather than stranding it on the conflicting throw.
    if (entries.has(opts.requestId)) {
      if (slotKey !== undefined) releaseSlot(slotKey);
      throw new RequestIdConflictError(opts.requestId);
    }

    const controller = new AbortController();
    const scope = createDisposableScope();

    // Stop-button race close. If a
    // `cancel({ requestId })` already arrived for this id, abort the
    // new controller before observers can subscribe to it. The
    // tripwire entry is consumed so a later, separate `begin(...)`
    // with the same id is unaffected (in practice ids are UUIDv4 and
    // never reused; this guard just keeps the contract self-
    // consistent under retries).
    const preCancel = consumeCancelBeforeBegin(opts.requestId);
    if (preCancel) {
      controller.abort(preCancel.reason);
    }

    let detachParent = () => {};
    if (opts.parentSignal) {
      const parent = opts.parentSignal;
      if (parent.aborted) {
        controller.abort(parent.reason);
      } else {
        const onParentAbort = () => controller.abort(parent.reason);
        parent.addEventListener("abort", onParentAbort, { once: true });
        detachParent = () => parent.removeEventListener("abort", onParentAbort);
      }
    }

    const ctx: RequestContext = {
      requestId: opts.requestId,
      kind: opts.kind,
      modelId: opts.modelId,
      signal: controller.signal,
      scope,
      // Land the context in `cancelling` from the outset whenever the
      // controller was already aborted by `begin(...)` itself — either
      // the Stop-button race (`preCancel`) or a `parentSignal` that was
      // already aborted at begin time. Both branches abort the
      // controller above, so without this guard observers would see a
      // momentarily-`running` context with an already-aborted signal.
      state: preCancel || opts.parentSignal?.aborted ? "cancelling" : "running",
    };

    const entry: RegistryEntry = {
      ctx,
      controller,
      scope,
      detachParent,
      startedAt: Date.now(),
      slotKey,
    };
    entries.set(opts.requestId, entry);
    logLifecycle("begin", ctx);

    return {
      get requestId() {
        return ctx.requestId;
      },
      get kind() {
        return ctx.kind;
      },
      get modelId() {
        return ctx.modelId;
      },
      get signal() {
        return ctx.signal;
      },
      get scope() {
        return ctx.scope;
      },
      get state() {
        return ctx.state;
      },
      set state(next: RequestState) {
        ctx.state = next;
      },
      [Symbol.asyncDispose]: async () => {
        await disposeEntry(entry, derivedTerminalState(ctx));
      },
    };
  }

  function get(requestId: string): RequestContext | null {
    return entries.get(requestId)?.ctx ?? null;
  }

  function list(): RequestContext[] {
    return Array.from(entries.values(), (e) => e.ctx);
  }

  /**
   * Cancel a still-queued waiter the same way the Stop-button race is
   * handled: record a cancel-before-begin so its `begin(...)` — which
   * resumes the instant we `resolve(false)` (without a slot) — observes the
   * cancel and returns an already-aborted context. The request thus ends in
   * a clean `cancelled` state rather than throwing.
   */
  function cancelQueuedWaiterGracefully(
    key: string,
    waiter: SlotWaiter,
    reason?: string,
  ): void {
    recordCancelBeforeBegin(waiter.requestId, reason);
    removeWaiter(key, waiter);
    waiter.resolve(false);
  }

  function cancel(target: CancelTarget): number {
    let cancelled = 0;
    if ("requestId" in target) {
      const entry = entries.get(target.requestId);
      if (entry) {
        if (cancelEntry(entry, target.reason)) cancelled++;
        return cancelled;
      }
      // Queued (still waiting for an admission slot)? It has no controller
      // yet, so cancel it through the cancel-before-begin tripwire: pull it
      // from the FIFO and let its begin() resume into an aborted context.
      // Counted as one — unlike the pure race below, this targets a known
      // in-flight (queued) begin, so the Stop button feels responsive
      // instead of waiting for the slot to free first.
      const queued = waitersById.get(target.requestId);
      if (queued) {
        cancelQueuedWaiterGracefully(queued.key, queued.waiter, target.reason);
        return cancelled + 1;
      }
      // Stop-button race: the client beat its own
      // `begin(...)`. Record the cancel so the next matching `begin`
      // aborts immediately. The return value stays 0 — no in-flight
      // request was matched, which is still the truth — but the
      // *effective* cancel will land when the begin arrives.
      recordCancelBeforeBegin(target.requestId, target.reason);
      return cancelled;
    }
    for (const entry of entries.values()) {
      if (entry.ctx.modelId !== target.modelId) continue;
      if (target.kind && entry.ctx.kind !== target.kind) continue;
      if (cancelEntry(entry, target.reason)) cancelled++;
    }
    // Queued waiters aren't in `entries`; drain the ones matching this
    // model (and optional kind) so a broad `cancel({ modelId })` doesn't
    // strand them behind a request that's being cancelled out from under
    // them. Snapshot first — `removeWaiter` mutates `waitersById`.
    for (const { key, waiter } of Array.from(waitersById.values())) {
      if (waiter.modelId !== target.modelId) continue;
      if (target.kind && waiter.kind !== target.kind) continue;
      cancelQueuedWaiterGracefully(key, waiter, target.reason);
      cancelled++;
    }
    return cancelled;
  }

  function cancelAll(reason: "shutdown" | "modelUnload"): Promise<void> {
    for (const entry of entries.values()) {
      cancelEntry(entry, reason);
    }
    // Drain every queued waiter so a shutdown / model-unload sweep can't
    // leave a `begin(...)` promise hung forever — which would in turn block
    // the unload waiting on a request that never resolves. Unlike the
    // targeted cancels above these *reject* rather than resolve-into-
    // aborted: the model / worker they queued against is being torn down,
    // so there is nothing left for them to run. Snapshot first —
    // `removeWaiter` mutates `waitersById`.
    for (const { key, waiter } of Array.from(waitersById.values())) {
      removeWaiter(key, waiter);
      waiter.reject(
        new RequestRejectedByPolicyError(
          waiter.requestId,
          waiter.kind,
          waiter.modelId,
          `queued request cancelled (${reason})`,
        ),
      );
    }
    // The interface returns Promise<void> so we can later make this an
    // async sweep that awaits per-handler scope unwinding (e.g. join on
    // the disposers). Today every handler unwinds on its own dispose
    // path, so the function only needs to fire-and-forget the abort.
    return Promise.resolve();
  }

  async function end(
    requestId: string,
    outcome: RequestOutcome,
  ): Promise<void> {
    const entry = entries.get(requestId);
    if (!entry) return;
    await disposeEntry(entry, outcome);
  }

  function policy(opts: ConcurrencyPolicy): void {
    policies.set(opts.kind, normalizePolicy(opts));
  }

  return {
    begin,
    get,
    list,
    cancel,
    cancelAll,
    end,
    policy,
    // Test-only: lets the registry race tests assert the bound
    // invariants on the internal "cancelled-before-begin" set without
    // exposing it as a public surface. Kept off the `RequestRegistry`
    // interface (typed via the augmented return type below) so handler
    // code can't depend on it accidentally.
    __cancelBeforeBeginSize: () => cancelledBeforeBegin.size,
    // Test-only: the number of live per-`(kind, modelId)` admission
    // states. Lets the queue tests assert the map empties on drain /
    // dispose (no `KeyState` leak). Also off the public interface.
    __keyStateSize: () => keyStates.size,
  } as RequestRegistry & {
    __cancelBeforeBeginSize: () => number;
    __keyStateSize: () => number;
  };
}

/**
 * Resolve a `ConcurrencyPolicy` to concrete numbers, applying defaults and
 * the deprecated `oneAtATimePerModel` alias. Done once at registration so
 * the `begin(...)` hot path reads plain numbers.
 */
function normalizePolicy(opts: ConcurrencyPolicy): NormalizedPolicy {
  let maxConcurrent: number;
  let onOverflow: "queue" | "reject";

  if (opts.maxConcurrentPerModel !== undefined) {
    maxConcurrent = opts.maxConcurrentPerModel;
    onOverflow = opts.onOverflow ?? "queue";
  } else if (opts.oneAtATimePerModel === true) {
    // Legacy alias: at most one in-flight per model, reject the rest.
    maxConcurrent = 1;
    onOverflow = opts.onOverflow ?? "reject";
  } else {
    // Nothing configured (includes `oneAtATimePerModel: false`) ⇒ no gating.
    maxConcurrent = Infinity;
    onOverflow = opts.onOverflow ?? "queue";
  }

  // A finite limit below 1 would gate every request forever; clamp to the
  // smallest sensible serial limit.
  if (Number.isFinite(maxConcurrent) && maxConcurrent < 1) maxConcurrent = 1;

  return {
    maxConcurrent,
    onOverflow,
    maxQueueDepth:
      opts.maxQueueDepthPerModel ?? DEFAULT_MAX_QUEUE_DEPTH_PER_MODEL,
    queueTimeoutMs: opts.queueTimeoutMs,
  };
}

/**
 * Test-only knobs exported for `request-registry.test.ts` so the bound
 * assertions can pin the documented limits without re-reading them via
 * fragile string comparison. **Not part of the public SDK surface.**
 *
 * @internal
 */
export const __requestRegistryTestHooks = {
  cancelBeforeBeginMaxEntries: CANCEL_BEFORE_BEGIN_MAX_ENTRIES,
  cancelBeforeBeginTtlMs: CANCEL_BEFORE_BEGIN_TTL_MS,
  defaultMaxQueueDepthPerModel: DEFAULT_MAX_QUEUE_DEPTH_PER_MODEL,
};

function derivedTerminalState(ctx: RequestContext): RequestOutcome {
  if (ctx.state === "failed") return "failed";
  if (ctx.signal.aborted || ctx.state === "cancelled") return "cancelled";
  return "completed";
}
