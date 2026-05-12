import { AsyncDisposeUnavailableError } from "@/utils/errors-server";

/**
 * Module-load guard. The whole request-lifecycle primitive stack (scopes,
 * the registry's `ManagedRequestContext`, `await using ctx = ...`) is
 * built on `Symbol.asyncDispose`, which is an ES2024 feature. If the host
 * runtime doesn't expose it (older Bare/Expo build, missing polyfill),
 * the `[Symbol.asyncDispose]:` property key in this file's `dispose`
 * function would coerce to the string `"undefined"` and silently produce
 * objects that look async-disposable but are not — handlers would leak
 * registry entries forever. Better to fail loudly at import time with a
 * clear error than to debug a slow registry leak in production.
 */
if (typeof Symbol.asyncDispose !== "symbol") {
  throw new AsyncDisposeUnavailableError();
}

/**
 * Bounded-lifetime cleanup scope for an in-flight request.
 *
 * Callers register cleanup callbacks via `defer(...)` while a handler runs.
 * On `[Symbol.asyncDispose]()` (used implicitly by `await using` or
 * explicitly) every registered callback is awaited in **LIFO** order — the
 * mirror of how `try/finally` blocks would unwind in a sequential write-up
 * of the same handler.
 *
 * Guarantees:
 *
 *  - **Idempotent.** A scope can be disposed once. Subsequent disposes are
 *    no-ops; subsequent `defer` calls run the cleanup eagerly so callers
 *    never silently leak a deferred resource if they hand a deferred
 *    callback to an already-disposed scope.
 *  - **Error aggregation.** Every deferred cleanup runs even when an
 *    earlier one throws. If a single cleanup throws, that error is
 *    rethrown verbatim. If two or more throw, an `AggregateError` is
 *    rethrown carrying every failure in the order it occurred. The
 *    handler unwinding the scope can therefore see _all_ cleanup
 *    failures, not just the first one.
 */

export interface DisposableScope {
  /**
   * Register a cleanup callback. Cleanups run on dispose in LIFO order.
   * Calling `defer` after the scope has been disposed runs the cleanup
   * eagerly so resources never leak silently.
   */
  defer(cleanup: () => Promise<void> | void): void;
  /** Run all registered cleanups. Idempotent. */
  [Symbol.asyncDispose](): Promise<void>;
  /** True after the first dispose has been initiated. */
  readonly disposed: boolean;
}

export function createDisposableScope(): DisposableScope {
  const cleanups: Array<() => Promise<void> | void> = [];
  let disposed = false;
  let disposing = false;

  function defer(cleanup: () => Promise<void> | void) {
    if (disposed || disposing) {
      void runEagerly(cleanup);
      return;
    }
    cleanups.push(cleanup);
  }

  async function runEagerly(cleanup: () => Promise<void> | void) {
    try {
      await cleanup();
    } catch {
      // Late-deferred cleanups have no caller waiting on them; the
      // unwinding path that disposed the scope already returned its own
      // errors. Swallowing here matches the user's intent of registering
      // a fire-and-forget cleanup.
    }
  }

  async function dispose() {
    if (disposed || disposing) return;
    disposing = true;
    const errors: unknown[] = [];
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (!cleanup) continue;
      try {
        await cleanup();
      } catch (err) {
        errors.push(err);
      }
    }
    disposed = true;
    disposing = false;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `DisposableScope: ${errors.length} cleanups failed`,
      );
    }
  }

  return {
    defer,
    [Symbol.asyncDispose]: dispose,
    get disposed() {
      return disposed;
    },
  };
}
