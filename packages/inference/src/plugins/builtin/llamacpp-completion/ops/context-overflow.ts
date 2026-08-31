/**
 * Helpers for detecting and parsing the llama.cpp addon's
 * `ContextOverflow` status error (`LlmErrors.hpp::ContextOverflow = 14`).
 *
 * The addon's JS-facing throw goes through `js_throw_error(env, code,
 * msg)` (see `JsUtils.hpp::JSCATCH`) where `code` comes from
 * `qvac_errors::StatusError::codeString()` and formats as
 * `"[ <addonId> :: ContextOverflow ]"`. The message carries the
 * C++-formatted detail (which may include the prompt/ctx sizes).
 *
 * These helpers let the plugin handler convert that addon error into a
 * typed `ContextOverflowError` and let unit tests assert the detection
 * + extraction logic without a real model load.
 */

export function isAddonContextOverflowError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  // Anchor to the codeString tail (`[ <addonId> :: ContextOverflow ]`)
  // so we don't false-positive on a hypothetical sibling like
  // `ContextOverflowRecovered` or `PostContextOverflow` after an
  // addon-side rename.
  if (typeof code === 'string' && /::\s*ContextOverflow\s*\]/.test(code)) {
    return true
  }
  // Message-substring fallback for the bare `LlamaModel::processPromptImpl`
  // path, which doesn't go through `StatusError::codeString()`. Match the
  // two known C++-emitted formats only — broader substring would catch
  // wrapper / cause-chain text that mentions overflow without being one.
  const message = (err as { message?: unknown }).message
  return (
    typeof message === 'string' &&
    /(?:context overflow at (?:batch )?prefill step|processPromptImpl: context overflow)/i.test(
      message
    )
  )
}

/**
 * One entry per guard that formats numbers into a `ContextOverflow`
 * message, ordered most specific first. Each pattern keeps its numbers
 * inside a single clause (no `[^]*?` cross-newline walk) so a wrapper
 * that pastes overflow text alongside unrelated numbers cannot produce a
 * mismatched set.
 *
 * Every pattern captures the context size LAST and the quantities that
 * make up the failing requirement before it, so `promptTokens` is the sum
 * of the leading groups and `ctxSize` is the final one. That one rule
 * covers both shapes: the guards that report a warm cache capture the
 * cached size and the appended prompt, and it is their sum that failed
 * the guard, while the rest capture a single figure and the sum is that
 * figure. The guards trigger on `>=` for a request that must still
 * generate, so the reported sum can equal the window rather than exceed
 * it. Reporting the appended prompt alone would render as "31 prompt
 * tokens exceeds the 8192-token context window", which is impossible on
 * its face and useless to truncation logic. Where a guard reports both
 * positions and KV cells, capture the cells: they are the binding
 * measure, since M-RoPE media occupies more cells than positions.
 *
 * Keep this in step with the guards in `TextLlmContext.cpp` and
 * `MtmdLlmContext.cpp`. A guard whose wording drifts out of this list
 * does not fail loudly, it silently returns `undefined` for both fields.
 */
const MESSAGE_PATTERNS: RegExp[] = [
  // "cached tokens C plus prompt tokens N exceed the max context tokens M"
  /cached tokens (\d+) plus prompt tokens (\d+) exceeds? the max context tokens (\d+)/i,
  // "cached P positions / C KV cells plus P2 positions / N KV cells of
  //  prompt exceed the max context tokens M"
  /cached \d+ positions \/ (\d+) KV cells plus \d+ positions \/ (\d+) KV cells of prompt exceeds? the max context tokens (\d+)/i,
  // "prompt tokens N, max context tokens M"
  /prompt tokens (\d+)[,\s]+max context tokens (\d+)/i,
  // "prompt spans P positions / N KV cells, max context tokens M"
  /prompt spans \d+ positions \/ (\d+) KV cells,\s*max context tokens (\d+)/i,
  // "(N tokens, P positions, max M)"
  /\((\d+)\s+tokens,\s*\d+\s+positions,\s*max\s+(\d+)\)/i,
  // "(N tokens, max M)", the pre-multimodal short form
  /\((\d+)\s+tokens,\s*max\s+(\d+)\)/i
]

/**
 * Best-effort extraction of `promptTokens` / `ctxSize` from the addon
 * error message. The C++ paths in `TextLlmContext.cpp` and
 * `MtmdLlmContext.cpp` format the numbers into the message; the
 * `LlamaModel::processPromptImpl` fallback path emits a bare
 * `"<func>: context overflow\n"` with none of them. Returning
 * `undefined` for either field is fine, `ContextOverflowError` holds
 * them as optional and the message factory degrades gracefully.
 *
 * `promptTokens` is what did not fit, which on a warm cache is the
 * cached conversation plus the appended prompt rather than the appended
 * prompt alone. The name predates caching. If a caller ever needs the
 * two halves apart, that wants new typed fields on
 * `ContextOverflowError`, not a narrower reading of this one.
 */
export function parseContextOverflowMessage(message: string): {
  promptTokens?: number
  ctxSize?: number
} {
  for (const pattern of MESSAGE_PATTERNS) {
    const match = message.match(pattern)
    if (!match) continue
    const numbers = match.slice(1).map(Number)
    const ctxSize = numbers.pop()
    if (ctxSize === undefined || numbers.length === 0) continue
    if (!Number.isFinite(ctxSize) || !numbers.every(Number.isFinite)) continue
    return {
      promptTokens: numbers.reduce((sum, value) => sum + value, 0),
      ctxSize
    }
  }
  return {}
}
