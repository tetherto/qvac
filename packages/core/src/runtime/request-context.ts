import type { AbortSignal } from 'bare-abort-controller'
import type { DisposableScope } from './disposable-scope'
import { createRequestRegistry as createRegistry, type RequestRegistry } from './request-registry'
import type { Logger, LogTransport } from '../logging/types'
import type { LogLevel } from '@qvac/logging'

/**
 * Coarse classification of a long-running request. Used by
 * `RequestRegistry.cancel({ modelId, kind })` so a broad cancel can target
 * just one operation kind on a given model (e.g. cancel an in-flight
 * completion without touching a finetune running on the same model).
 *
 * The set is intentionally open-coded — adding a new kind is a one-line
 * change and the union surfaces in editor autocomplete at every call site.
 */
export type RequestKind =
  | 'completion'
  | 'embeddings'
  | 'transcribe'
  | 'translate'
  | 'diffusion'
  | 'tts'
  | 'ocr'
  | 'vla'
  | 'finetune'
  | 'loadModel'
  | 'downloadAsset'
  | 'rag'

/**
 * Lifecycle states a request transitions through. A new context starts in
 * `"running"`. `cancel(...)` flips it to `"cancelling"` and aborts the
 * signal; `end({ outcome: "completed" | "failed" | "cancelled" })` flips
 * it to a terminal state and removes it from the registry.
 *
 * Kept as a string union (not a state machine) on purpose — handlers read
 * `state` defensively at most a couple of points and a flat enum is easier
 * to log/assert than a transition table.
 */
export type RequestState = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'

/**
 * Per-request lifecycle handle. Created by `RequestRegistry.begin(...)`
 * and consumed by long-running handlers as the single owner of:
 *
 *  - `requestId` — stable identity; visible to the caller so it can
 *    target this exact request with `cancel({ requestId })`.
 *  - `signal` — `AbortSignal` that fires when the request is cancelled.
 *    Composes with addon-level cancellation through a single
 *    `signal.addEventListener("abort", ...)` hook installed by the
 *    handler.
 *  - `scope` — `DisposableScope` for `await using` / `Symbol.asyncDispose`
 *    cleanup. The scope unwinds whether the handler returns, throws, or
 *    is cancelled — there is no manual cleanup path for handlers to
 *    forget on the cancel branch.
 *  - `state` — current lifecycle state. Treat as read-mostly; the
 *    registry mutates it.
 */
export interface RequestContext {
  readonly requestId: string
  readonly kind: RequestKind
  readonly modelId: string | undefined
  readonly signal: AbortSignal
  readonly scope: DisposableScope
  state: RequestState
}

/**
 * Shared singleton. Every long-running request registers under this
 * registry, so a `cancel({ requestId })` call can find its target without
 * the caller needing to know which plugin / handler owns the request.
 *
 * Exposed alongside `createRequestRegistry()` rather than replacing it so
 * unit tests can spin up isolated registries without contaminating the
 * shared instance. On first use the singleton registers core's
 * baseline concurrency policies.
 */
let registry: RequestRegistry | null = null

function installDefaultPolicies(r: RequestRegistry): void {
  // A loaded model is a single native context (one KV-cache, single-slot
  // decode), so two same-model completions can't run in parallel. Serialize
  // rather than reject: the second waits FIFO. maxConcurrentPerModel: 1 is
  // today's reality — raise it once continuous batching lands. The depth cap
  // bounds queue memory.
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    maxQueueDepthPerModel: 64
  })
}

export function getRequestRegistry(): RequestRegistry {
  if (!registry) {
    registry = createRegistry()
    installDefaultPolicies(registry)
  }
  return registry
}

export { createRegistry as createRequestRegistry }

export interface RequestLogContext {
  requestId: string
  kind: string
  modelId: string | undefined
}

type LogMethod = 'error' | 'warn' | 'info' | 'debug' | 'trace'

/**
 * Wraps `logger` so every emit is prefixed with
 * `[request-lifecycle <kind> requestId=<id> modelId=<modelId>] `
 * (the `modelId=...` segment is dropped when absent). The wrapper is a
 * thin shim: `setLevel` / `getLevel` / `addTransport` / `setConsoleOutput`
 * pass through to the underlying logger, and transport callbacks receive
 * the prefixed message.
 *
 * @example
 *   await using ctx = await registry.begin({ requestId, kind: "completion", modelId });
 *   const log = withRequestContext(getEngineLogger(), ctx);
 *   log.info("decoding token 7");
 *   // → "[request-lifecycle completion requestId=<id> modelId=<id>] decoding token 7"
 */
export function withRequestContext(logger: Logger, ctx: RequestLogContext): Logger {
  const prefix =
    ctx.modelId !== undefined
      ? `[request-lifecycle ${ctx.kind} requestId=${ctx.requestId} modelId=${ctx.modelId}] `
      : `[request-lifecycle ${ctx.kind} requestId=${ctx.requestId}] `

  function pick(method: LogMethod): (...args: unknown[]) => void {
    switch (method) {
      case 'error':
        return logger.error
      case 'warn':
        return logger.warn
      case 'info':
        return logger.info
      case 'debug':
        return logger.debug
      case 'trace':
        return logger.trace
    }
  }

  function emit(method: LogMethod, args: unknown[]): void {
    const sink = pick(method)
    if (args.length === 0) {
      sink(prefix)
      return
    }
    const [first, ...rest] = args
    sink(prefix + String(first), ...rest)
  }

  return {
    error: (...args: unknown[]) => emit('error', args),
    warn: (...args: unknown[]) => emit('warn', args),
    info: (...args: unknown[]) => emit('info', args),
    debug: (...args: unknown[]) => emit('debug', args),
    trace: (...args: unknown[]) => emit('trace', args),
    setLevel: (level: LogLevel) => logger.setLevel(level),
    getLevel: () => logger.getLevel(),
    addTransport: (transport: LogTransport) => logger.addTransport(transport),
    setConsoleOutput: (enabled: boolean) => logger.setConsoleOutput(enabled)
  }
}
