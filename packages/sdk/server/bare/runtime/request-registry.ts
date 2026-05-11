import {
  AbortController,
  type AbortSignal,
} from "bare-abort-controller";
import {
  createDisposableScope,
  type DisposableScope,
} from "@/server/bare/runtime/disposable-scope";
import type {
  RequestContext,
  RequestKind,
  RequestState,
} from "@/server/bare/runtime/request-context";
import { RequestIdConflictError } from "@/utils/errors-server";

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
   * Open a new request. Throws `RequestIdConflictError` if `requestId` is
   * already present (UUIDv4 collision is astronomically unlikely; the
   * guard exists so a buggy client retry sending the same id can't
   * silently overwrite an in-flight request).
   */
  begin(opts: BeginOpts): ManagedRequestContext;

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
}

export function createRequestRegistry(): RequestRegistry {
  const entries = new Map<string, RegistryEntry>();

  function cancelEntry(entry: RegistryEntry, reason?: string): boolean {
    if (entry.controller.signal.aborted) return false;
    entry.ctx.state = "cancelling";
    entry.controller.abort(reason);
    return true;
  }

  async function disposeEntry(
    entry: RegistryEntry,
    outcome: RequestOutcome,
  ): Promise<void> {
    if (entry.scope.disposed) return;
    entry.ctx.state = outcome;
    entry.detachParent();
    // Pull the entry out before unwinding so observers (e.g. a `cancel(...)`
    // racing with dispose) don't see a half-disposed context.
    entries.delete(entry.ctx.requestId);
    await entry.scope[Symbol.asyncDispose]();
  }

  function begin(opts: BeginOpts): ManagedRequestContext {
    if (entries.has(opts.requestId)) {
      throw new RequestIdConflictError(opts.requestId);
    }

    const controller = new AbortController();
    const scope = createDisposableScope();

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
      state: "running",
    };

    const entry: RegistryEntry = { ctx, controller, scope, detachParent };
    entries.set(opts.requestId, entry);

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
      if (entry && cancelEntry(entry, target.reason)) cancelled++;
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

  return { begin, get, list, cancel, cancelAll, end };
}

function derivedTerminalState(ctx: RequestContext): RequestOutcome {
  if (ctx.state === "failed") return "failed";
  if (ctx.signal.aborted || ctx.state === "cancelled") return "cancelled";
  return "completed";
}
