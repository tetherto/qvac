# KV Cache API

Cache control is managed through `runOptions`. For a single prompt, pass `runOptions` as the second argument to `model.run(prompt, runOptions)`.

Examples that need to add an assistant response back to history use this
helper:

```js
async function collectOutput(response) {
  let output = ''
  await response.onUpdate((chunk) => { output += chunk }).await()
  return output
}
```

For a batch (`model.run([...])`) there is no top-level second argument — set cache options **per prompt** in `BatchPrompt.runOptions` (`cacheKey`, `saveCacheToDisk`, `prefill`, `generationParams`). Passing a second argument to a batch `run()` throws.

```js
// Batch: cache options go per item, not as a second run() argument.
await model.run([
  { prompt: [{ role: 'user', content: 'Hi' }], runOptions: { cacheKey: 'a.bin', saveCacheToDisk: true } },
  { prompt: [{ role: 'user', content: 'Yo' }], runOptions: { cacheKey: 'b.bin' } },
])
```

## runOptions reference

| Option | Type | Description |
| --- | --- | --- |
| `cacheKey` | `string` | Path to the cache file. Omit to disable caching. |
| `saveCacheToDisk` | `boolean` | `true` writes the cache to the `cacheKey` path after inference. If omitted, cache stays in RAM and only auto-saves on cache switch or clear. |
| `prefill` | `boolean` | Evaluate prompt without generating a response. On a model loaded with `parallel >= 2`, must be paired with `saveCacheToDisk: true` and a `cacheKey` — see below. |
| `generationParams` | `object` | Per-run overrides for temp, top_p, top_k, predict, seed, penalties. |

## Prefill on a parallel model (`parallel >= 2`)

A prefill-only run warms context state without generating. On a model loaded with `parallel >= 2` that state lives in a scheduler slot which is torn down when the run ends, so nothing a concurrent job could reach survives unless the prefill is **persistable** — `saveCacheToDisk: true` plus a `cacheKey`.

A *live-only* prefill (no persistence) is therefore rejected with `InvalidArgument` on a parallel model, both as a single `run()` and per batch item, rather than silently producing nothing. Load with `parallel: 1` if you want live-only cache warming, where the warmed context is reused by the next run on that instance.

See [continuous-batching.md](continuous-batching.md#prefill-rules-persistable-vs-live-only) for the scheduler-side rules.

## Enable caching

Pass `cacheKey` with a file path. The KV cache is loaded from that file if it exists, or created fresh if it doesn't.

```js
await model.run(
  [{ role: 'user', content: 'What is bitcoin?' }],
  { cacheKey: 'session.bin' }
)
```

## Continue a conversation

Use the same `cacheKey`, but resend the complete conversation and the complete
tool list on every turn. The addon renders that authoritative history once,
compares it with the token/media ledger embedded in the same sequence-state
file, and evaluates only the suffix after the longest common prefix.

```js
const history = [{ role: 'user', content: 'What is bitcoin?' }]
const first = await collectOutput(await model.run(history, { cacheKey: 'session.bin' }))
history.push({ role: 'assistant', content: first })
history.push({ role: 'user', content: 'Tell me more' })
await model.run(
  history,
  { cacheKey: 'session.bin' }
)
```

Delta-only prompts are no longer supported for cached requests. Edited or
shortened history is detected and the addon trims or restores the cache at a
matching prefix before prefilling again. Legacy cache files without a ledger
are treated as cold misses. A current-format file with a corrupt ledger fails
to load.

## Save the cache to disk

`saveCacheToDisk: true` writes the full in-memory KV cache state to the `cacheKey` file after inference completes.

```js
await model.run(
  [{ role: 'user', content: 'Hello' }],
  { cacheKey: 'session.bin', saveCacheToDisk: true }
)
```

Without `saveCacheToDisk`, the cache stays in RAM. It is only written to disk automatically in two cases:

1. **Switching to a different `cacheKey`** — the old session is saved before loading the new one.
2. **Omitting `cacheKey`** — the active session is saved and then cleared.

### saveCacheToDisk on some turns, omitted on others

```js
// Turn 1: saved to disk
const history = [{ role: 'user', content: 'Hello' }]
const first = await collectOutput(
  await model.run(history, { cacheKey: 'a.bin', saveCacheToDisk: true })
)
history.push({ role: 'assistant', content: first })

// Turn 2: RAM has turn 1 + 2, but a.bin on disk still only has turn 1
history.push({ role: 'user', content: 'More' })
const second = await collectOutput(await model.run(history, { cacheKey: 'a.bin' }))
history.push({ role: 'assistant', content: second })

// Turn 3: a.bin on disk updated with turn 1 + 2 + 3
history.push({ role: 'user', content: 'Continue' })
await model.run(history, { cacheKey: 'a.bin', saveCacheToDisk: true })
```

### Started without saving, then saved later

```js
// Turn 1: cache in RAM only, no file written
const history = [{ role: 'user', content: 'Hello' }]
const first = await collectOutput(await model.run(history, { cacheKey: 'a.bin' }))
history.push({ role: 'assistant', content: first })

// Turn 2: saves everything (turn 1 + 2) to disk
history.push({ role: 'user', content: 'More' })
await model.run(history, { cacheKey: 'a.bin', saveCacheToDisk: true })
```

## Switch between cache files

Passing a different `cacheKey` auto-saves the old session to disk, then loads the new one.

```js
await model.run([{ role: 'user', content: 'Topic A' }], { cacheKey: 'session1.bin' })

// session1.bin is auto-saved, then session2.bin is loaded
await model.run([{ role: 'user', content: 'Topic B' }], { cacheKey: 'session2.bin' })
```

## Single-shot inference (no caching)

Omit `cacheKey`. No cache is used and the context is reset after each call.

```js
await model.run([{ role: 'user', content: 'One-off question' }])
```

If caching was previously active, omitting `cacheKey` auto-saves the active session to disk and clears it.

## Tools and reasoning

Cached tool-calling requests must resend the complete tool list with the full
history on every turn. Prompt text and the tool grammar come from the same
render, so the tool block appears once and `tool_choice` is armed on warm turns.
Changing the tools naturally causes a prefix divergence and re-prefill.

```js
await model.run(
  [
    { role: 'system', content: 'You are a helpful assistant.' },
    ...history,
    { role: 'user', content: 'Calculate 256 * 128' },
    TOOL_CALCULATOR
  ],
  { cacheKey: 'session.bin', generationParams: { tool_choice: 'required' } }
)
```

Generated reasoning is retained in the live cache immediately after a turn.
If the next full-history render omits that reasoning, normal prefix
reconciliation removes it; if the render preserves it, it remains reusable.

> Migration note: this addon contract is intentionally incompatible with SDK
> versions that still send delta messages/tools or expose
> `remove_thinking_from_context`. Upgrade the SDK only after its full-history
> cache migration lands.

## Save failures

If a cache write fails (e.g. the disk is full, the path is unwritable, or `llama_state_save_file` returns false), a `StatusError` with code `UnableToSaveSessionFile` is thrown.

- On the **explicit-save** path (`saveCacheToDisk: true`): the error propagates from `model.run()`. The in-memory KV state is still valid; the caller can retry or continue without saving.
- On the **cache-switch** and **cache-clear** paths (automatic flush on key change or `cacheKey` omission): the error propagates from `model.run()` and the cache is left disabled. Subsequent calls without a `cacheKey` will proceed without attempting the flush again.
- If the active cache's backing file or parent directory was externally removed before a switch or clear, the stale in-memory cache is discarded and the next request starts from a fresh context instead of throwing `UnableToSaveSessionFile`.
- On same-key reuse, a removed backing file also starts from a fresh context. If the parent directory was removed and `saveCacheToDisk: true` is set, the fresh request can still throw `UnableToSaveSessionFile` during its explicit save.

## Cache token count

`CacheTokens` is available in `response.stats` after every run. No dedicated command needed.

```js
const response = await model.run(
  [{ role: 'user', content: 'Hello' }],
  { cacheKey: 'session.bin' }
)
console.log(response.stats.CacheTokens)
```
