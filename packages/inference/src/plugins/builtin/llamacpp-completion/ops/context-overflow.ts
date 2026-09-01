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

// Refusals thrown before any decode or disk save; the async transport delivers
// exception.what() alone, so each form is matched complete and end-anchored.
const PRE_MUTATION_REFUSAL_FORMS = [
  /^ContinuousBatchScheduler::submit: prompt of \d+ KV cells exceeds per-sequence cap \d+ \(ctxTotalTokens \/ n_parallel\)$/,
  /^ContinuousBatchScheduler::submit: prompt of \d+ tokens leaves no room under per-sequence cap \d+ \(ctxTotalTokens \/ n_parallel\)$/,
  /^ContinuousBatchScheduler::submit: prefill prompt of \d+ tokens exceeds per-sequence cap \d+ \(ctxTotalTokens \/ n_parallel\)$/,
  /^ContinuousBatchScheduler::submit: n_predict \d+ \+ prompt \d+ KV cells exceeds per-sequence cap \d+ \(ctxTotalTokens \/ n_parallel\)$/,
  /^ContinuousBatchScheduler::submit: failed to add to batch \(MultiRequestBatcher::AddStatus=[1-4]\)$/,
  /^invalid generationParams\.json_schema: [^\n]*$/,
  /^failed to initialise sampler with per-request generationParams \(invalid grammar or json_schema\?\)$/
]

export function isAddonPreMutationRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  // A status code only exists on the synchronous throw path; when present it
  // must be InvalidArgument, and its absence (the async transport) is fine.
  const code = (err as { code?: unknown }).code
  if (code !== undefined && (typeof code !== 'string' || !/::\s*InvalidArgument\s*\]/.test(code))) {
    return false
  }
  const message = (err as { message?: unknown }).message
  if (typeof message !== 'string') return false
  const trimmed = message.trim()
  return PRE_MUTATION_REFUSAL_FORMS.some((form) => form.test(trimmed))
}

export type ContextOverflowSizes = {
  /** The prompt alone, in tokens; unset when the guard reports KV cells. */
  promptTokens?: number
  /** Cached conversation on a warm-cache guard, in `ctxSize` units. */
  cachedTokens?: number
  /** Total the failing guard reported, in `ctxSize` units; the guards trigger on `>=`, so it can equal the window. */
  requiredTokens?: number
  /** Effective per-request ceiling: `ctx_size` split across slots at `parallel > 1`. */
  ctxSize?: number
}

type PatternEntry = {
  pattern: RegExp
  /** Maps the numeric capture groups (in order) to typed fields. */
  map: (groups: number[]) => ContextOverflowSizes
}

// One entry per number-formatting guard, most specific first; keep in step
// with TextLlmContext.cpp / MtmdLlmContext.cpp or fields silently vanish.
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
    // "cached P positions / C KV cells plus ... of prompt exceed the max
    // context tokens M" — KV cells, not tokens, so promptTokens stays unset.
    pattern:
      /cached (\d+) positions \/ (\d+) KV cells plus (\d+) positions \/ (\d+) KV cells of prompt exceeds? the max context tokens (\d+)/i,
    map: ([cPos, cCells, pPos, pCells, ctx]) => ({
      cachedTokens: Math.max(cPos!, cCells!),
      requiredTokens: Math.max(cPos! + pPos!, cCells! + pCells!),
      ctxSize: ctx!
    })
  },
  {
    // "prompt tokens N, max context tokens M"
    pattern: /prompt tokens (\d+)[, \t]+max context tokens (\d+)/i,
    map: ([prompt, ctx]) => ({ promptTokens: prompt!, requiredTokens: prompt!, ctxSize: ctx! })
  },
  {
    // "prompt spans P positions / N KV cells, max context tokens M" —
    // not tokens, so promptTokens stays unset.
    pattern: /prompt spans (\d+) positions \/ (\d+) KV cells,[ \t]*max context tokens (\d+)/i,
    map: ([pos, cells, ctx]) => ({ requiredTokens: Math.max(pos!, cells!), ctxSize: ctx! })
  },
  {
    // "(N tokens, P positions, max M)" — the "tokens" figure is
    // mtmd_helper_get_n_tokens, i.e. KV cells, so promptTokens stays unset.
    pattern: /\((\d+)[ \t]+tokens,[ \t]*(\d+)[ \t]+positions,[ \t]*max[ \t]+(\d+)\)/i,
    map: ([cells, pos, ctx]) => ({
      requiredTokens: Math.max(cells!, pos!),
      ctxSize: ctx!
    })
  },
  {
    // "(N tokens, max M)", the retired short form. Both of its emitters
    // format a cached total, not the prompt alone — promptTokens stays unset.
    pattern: /\((\d+)[ \t]+tokens,[ \t]*max[ \t]+(\d+)\)/i,
    map: ([total, ctx]) => ({ requiredTokens: total!, ctxSize: ctx! })
  }
]

// Best-effort extraction of the overflow sizes; the bare processPromptImpl
// path carries no numbers, and undefined fields degrade gracefully.
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
