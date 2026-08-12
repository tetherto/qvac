/**
 * Helper for detecting the llama.cpp addon's `Cancelled` status error
 * (`LlmErrors.hpp::Cancelled = 27`) on the continuous-batching path.
 *
 * When a batch is cancelled while it still has prompts queued behind the
 * `parallel` slot limit, `ContinuousBatchScheduler::cancelPendingLocked`
 * fails the whole batch group with a `Cancelled` `StatusError`, which
 * `processBatch` rethrows — so `model.run(prompts)` rejects rather than
 * resolving with partial outputs (see
 * `packages/llm-llamacpp/docs/continuous-batching.md` "Cancellation
 * semantics"). In-flight slots are still cancelled gracefully, but the
 * shared group carries the error.
 *
 * The addon's JS-facing throw goes through `js_throw_error(env, code,
 * msg)` (see `JsUtils.hpp::JSCATCH`) where `code` comes from
 * `qvac_errors::StatusError::codeString()` and formats as
 * `"[ <addonId> :: Cancelled ]"`. This helper lets the batch handler
 * recognise that rejection so it can complete the run with cancelled
 * terminal events (matching the SDK's graceful cancel semantics) instead
 * of surfacing a generic `CompletionFailedError`.
 */
export function isAddonCancelledError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  // Mid-decode cancel: a `Cancelled` StatusError with code tail `:: Cancelled ]`
  // (anchored so a sibling like `CancelledByPolicy` can't false-positive).
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && /::\s*Cancelled\s*\]/.test(code)) return true
  // Queued cancel: a plain Error with no code, only this scheduler message.
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' && /cancelled before it could run/i.test(message)
}
