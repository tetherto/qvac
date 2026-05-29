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
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  // Anchor to the codeString tail (`[ <addonId> :: ContextOverflow ]`)
  // so we don't false-positive on a hypothetical sibling like
  // `ContextOverflowRecovered` or `PostContextOverflow` after an
  // addon-side rename.
  if (typeof code === "string" && /::\s*ContextOverflow\s*\]/.test(code)) {
    return true;
  }
  // Message-substring fallback for the bare `LlamaModel::processPromptImpl`
  // path, which doesn't go through `StatusError::codeString()`. Match the
  // two known C++-emitted formats only — broader substring would catch
  // wrapper / cause-chain text that mentions overflow without being one.
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /(?:context overflow at prefill step|processPromptImpl: context overflow)/i.test(message)
  );
}

/**
 * Best-effort extraction of `promptTokens` / `ctxSize` from the addon
 * error message. The C++ paths in `TextLlmContext.cpp` and
 * `MtmdLlmContext.cpp` format both numbers into the message; the
 * `LlamaModel::processPromptImpl` fallback path emits a bare
 * `"<func>: context overflow\n"` with neither number. Returning
 * `undefined` for either field is fine — `ContextOverflowError` holds
 * them as optional and the message factory degrades gracefully.
 */
export function parseContextOverflowMessage(message: string): {
  promptTokens?: number;
  ctxSize?: number;
} {
  // "[TextLlm] context overflow at prefill step: prompt tokens N, max context tokens M\n"
  // Same-clause separator (no `[^]*?` cross-newline walk) so a future
  // wrapper that pastes overflow text alongside unrelated numbers can't
  // produce a mismatched pair.
  const longForm = message.match(
    /prompt tokens (\d+)[,\s]+max context tokens (\d+)/i,
  );
  if (longForm?.[1] && longForm[2]) {
    return {
      promptTokens: Number(longForm[1]),
      ctxSize: Number(longForm[2]),
    };
  }
  // "[TextLlm] context overflow at prefill step (N tokens, max M)\n"
  // "[MtmdLlm] context overflow at prefill step (N tokens, max M)\n"
  const shortForm = message.match(/\((\d+)\s+tokens,\s*max\s+(\d+)\)/i);
  if (shortForm?.[1] && shortForm[2]) {
    return {
      promptTokens: Number(shortForm[1]),
      ctxSize: Number(shortForm[2]),
    };
  }
  return {};
}
