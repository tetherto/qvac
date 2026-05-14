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
 */
export interface ConcurrencyPolicy {
  kind: RequestKind;
  /**
   * When true, at most one in-flight request per `(kind, modelId)`
   * tuple — a second `begin(...)` rejects with
   * `RequestRejectedByPolicyError`. Requests without a `modelId` are
   * unaffected.
   */
  oneAtATimePerModel: boolean;
}

/**
 * `ManagedRequestContext` is the value `begin(...)` returns. It extends
 * `RequestContext` with an async-dispose method so handlers can write:
 *
 *   await using ctx = registry.begin({ ... });
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
   * Open a new request. Throws:
   *  - `RequestIdConflictError` if `requestId` is already present
   *    (UUIDv4 collision is astronomically unlikely; the guard exists
   *    so a buggy client retry sending the same id can't silently
   *    overwrite an in-flight request).
   *  - `RequestRejectedByPolicyError` if a concurrency policy was
   *    registered for `opts.kind` and the new request would violate
   *    it (e.g. `oneAtATimePerModel` rejects when another request
   *    with the same `(kind, modelId)` pair is already in flight).
   */
  begin(opts: BeginOpts): ManagedRequestContext;

  /**
   * Register or replace the concurrency policy for a `RequestKind`.
   * Subsequent `begin(...)` calls for that kind run the policy before
   * allocating a controller / scope. One policy per kind — calling
   * twice replaces the previous declaration.
   *
   * @example
   *   r.policy({ kind: "completion", oneAtATimePerModel: true });
   *   await using a = r.begin({ requestId: "r-1", kind: "completion", modelId: "m1" });
   *   r.begin({ requestId: "r-2", kind: "completion", modelId: "m1" });
   *   // → throws RequestRejectedByPolicyError (code 52420)
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

export function createRequestRegistry(options?: {
  /** Defaults to `getServerLogger()`. Tests inject a stub. */
  logger?: Logger;
}): RequestRegistry {
  const entries = new Map<string, RegistryEntry>();
  const policies = new Map<RequestKind, ConcurrencyPolicy>();
  const logger = options?.logger ?? getServerLogger();

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
    await entry.scope[Symbol.asyncDispose]();
  }

  function begin(opts: BeginOpts): ManagedRequestContext {
    if (entries.has(opts.requestId)) {
      throw new RequestIdConflictError(opts.requestId);
    }

    // Admission control runs before allocation so a rejected begin
    // leaves no controller / scope behind.
    const policy = policies.get(opts.kind);
    if (policy && policy.oneAtATimePerModel && opts.modelId !== undefined) {
      for (const existing of entries.values()) {
        if (existing.ctx.kind !== opts.kind) continue;
        if (existing.ctx.modelId !== opts.modelId) continue;
        throw new RequestRejectedByPolicyError(
          opts.requestId,
          opts.kind,
          opts.modelId,
          `another ${opts.kind} request (${existing.ctx.requestId}) is already running on this model`,
        );
      }
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

  function cancel(target: CancelTarget): number {
    let cancelled = 0;
    if ("requestId" in target) {
      const entry = entries.get(target.requestId);
      if (entry) {
        if (cancelEntry(entry, target.reason)) cancelled++;
        return cancelled;
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
    return cancelled;
  }

  function cancelAll(reason: "shutdown" | "modelUnload"): Promise<void> {
    for (const entry of entries.values()) {
      cancelEntry(entry, reason);
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
    policies.set(opts.kind, opts);
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
  } as RequestRegistry & { __cancelBeforeBeginSize: () => number };
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
};

function derivedTerminalState(ctx: RequestContext): RequestOutcome {
  if (ctx.state === "failed") return "failed";
  if (ctx.signal.aborted || ctx.state === "cancelled") return "cancelled";
  return "completed";
}
