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

export type ContextOverflowSizes = {
  /**
   * The prompt alone, in tokens — set only when the guard reports an
   * actual token count for the prompt. Guards that denominate the prompt
   * in KV cells leave it undefined rather than mislabelling cells as
   * tokens (M-RoPE media occupies more cells than positions).
   */
  promptTokens?: number
  /**
   * The cached conversation a warm-cache guard reports, in the same
   * units as `ctxSize` (KV cells; equal to tokens for text).
   */
  cachedTokens?: number
  /**
   * The total context the request needs — the figure that failed the
   * guard, in the same units as `ctxSize`. On a warm cache this is the
   * cached conversation plus the appended prompt; on a cold prefill it
   * equals the prompt figure. The guards trigger on `>=` for a request
   * that must still generate, so this can equal the window rather than
   * exceed it.
   */
  requiredTokens?: number
  /** The model's context window (`ctx_size`), which counts KV cells. */
  ctxSize?: number
}

type PatternEntry = {
  pattern: RegExp
  /** Maps the numeric capture groups (in order) to typed fields. */
  map: (groups: number[]) => ContextOverflowSizes
}

/**
 * One entry per guard that formats numbers into a `ContextOverflow`
 * message, ordered most specific first. Each pattern keeps its numbers
 * inside a single clause (no `[^]*?` cross-newline walk) so a wrapper
 * that pastes overflow text alongside unrelated numbers cannot produce a
 * mismatched set.
 *
 * Where a guard reports both positions and KV cells, the cells are
 * captured: they are the binding measure, and `ctx_size` counts cells,
 * so `requiredTokens` and `ctxSize` stay comparable. `promptTokens` is
 * set only from figures the guard denominates in tokens.
 *
 * Keep this in step with the guards in `TextLlmContext.cpp` and
 * `MtmdLlmContext.cpp`. A guard whose wording drifts out of this list
 * does not fail loudly, it silently returns no fields.
 */
const MESSAGE_PATTERNS: PatternEntry[] = [
  {
    // "cached tokens C plus prompt tokens N exceed the max context tokens M"
    pattern: /cached tokens (\d+) plus prompt tokens (\d+) exceeds? the max context tokens (\d+)/i,
    map: ([cached, prompt, ctx]) => ({
      promptTokens: prompt!,
      cachedTokens: cached!,
      requiredTokens: cached! + prompt!,
      ctxSize: ctx!
    })
  },
  {
    // "cached P positions / C KV cells plus P2 positions / N KV cells of
    //  prompt exceed the max context tokens M" — the prompt figure is KV
    // cells, not tokens, so promptTokens stays unset.
    pattern:
      /cached \d+ positions \/ (\d+) KV cells plus \d+ positions \/ (\d+) KV cells of prompt exceeds? the max context tokens (\d+)/i,
    map: ([cached, prompt, ctx]) => ({
      cachedTokens: cached!,
      requiredTokens: cached! + prompt!,
      ctxSize: ctx!
    })
  },
  {
    // "prompt tokens N, max context tokens M"
    pattern: /prompt tokens (\d+)[,\s]+max context tokens (\d+)/i,
    map: ([prompt, ctx]) => ({ promptTokens: prompt!, requiredTokens: prompt!, ctxSize: ctx! })
  },
  {
    // "prompt spans P positions / N KV cells, max context tokens M" —
    // KV cells again, so promptTokens stays unset.
    pattern: /prompt spans \d+ positions \/ (\d+) KV cells,\s*max context tokens (\d+)/i,
    map: ([prompt, ctx]) => ({ requiredTokens: prompt!, ctxSize: ctx! })
  },
  {
    // "(N tokens, P positions, max M)"
    pattern: /\((\d+)\s+tokens,\s*\d+\s+positions,\s*max\s+(\d+)\)/i,
    map: ([prompt, ctx]) => ({ promptTokens: prompt!, requiredTokens: prompt!, ctxSize: ctx! })
  },
  {
    // "(N tokens, max M)", the retired short form. Both of its emitters
    // format a cached total, not the prompt alone — promptTokens stays unset.
    pattern: /\((\d+)\s+tokens,\s*max\s+(\d+)\)/i,
    map: ([total, ctx]) => ({ requiredTokens: total!, ctxSize: ctx! })
  }
]

/**
 * Best-effort extraction of the overflow sizes from the addon error
 * message. The C++ paths in `TextLlmContext.cpp` and
 * `MtmdLlmContext.cpp` format the numbers into the message; the
 * `LlamaModel::processPromptImpl` fallback path emits a bare
 * `"<func>: context overflow\n"` with none of them. Returning
 * `undefined` fields is fine, `ContextOverflowError` holds them as
 * optional and the message factory degrades gracefully.
 */
export function parseContextOverflowMessage(message: string): ContextOverflowSizes {
  for (const { pattern, map } of MESSAGE_PATTERNS) {
    const match = message.match(pattern)
    if (!match) continue
    const numbers = match.slice(1).map(Number)
    if (numbers.length === 0 || !numbers.every(Number.isFinite)) continue
    return map(numbers)
  }
  return {}
}
