import type { AbortSignal } from "bare-abort-controller";
import type { DisposableScope } from "@/server/bare/runtime/disposable-scope";

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
  | "completion"
  | "embeddings"
  | "transcribe"
  | "translate"
  | "diffusion"
  | "tts"
  | "ocr"
  | "finetune"
  | "loadModel"
  | "downloadAsset"
  | "rag";

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
export type RequestState =
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Per-request lifecycle handle. Created by `RequestRegistry.begin(...)`
 * and consumed by long-running handlers as the single owner of:
 *
 *  - `requestId` — stable identity; visible to the client so it can
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
  readonly requestId: string;
  readonly kind: RequestKind;
  readonly modelId: string | undefined;
  readonly signal: AbortSignal;
  readonly scope: DisposableScope;
  state: RequestState;
}
