# KV Cache API

Cache control is managed through `runOptions`. For a single prompt, pass `runOptions` as the second argument to `model.run(prompt, runOptions)`.

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
| `prefill` | `boolean` | Evaluate prompt without generating a response. |
| `generationParams` | `object` | Per-run overrides for temp, top_p, top_k, predict, seed, penalties. |

## Transaction checkpoints and cancellation

Transaction durability is opt-in. A request has a restorable pre-request checkpoint only when both `cacheKey` and `saveCacheToDisk: true` are set.

Cache resolution happens first. A non-empty persistent request requires a last-known-valid canonical artifact and reserves that cache path exclusively within the process. Metadata is parsed directly from that exact artifact before mutation, including logical position, protected-prefix position, physical KV-cell usage, and protected-prefix KV usage. Newer unsaved live state does not block admission and is never silently committed at admission. A missing, malformed, out-of-range, or already-reserved artifact rejects the request before tokenization, media loading, sliding, or decode mutates request state.

An empty persistent baseline uses an in-memory empty marker and creates no file. Successful requests release the checkpoint before normal end-of-request persistence may atomically replace the canonical cache.

Explicit prefill or generation cancellation restores the committed cache bytes and their artifact-derived metadata as one coherent unit even when it is older than live state; losing unsaved deltas is expected. Loaded position and physical KV-cell counts are validated against the pinned metadata before restoration succeeds. Partial output may already have streamed to the caller, but it is not retained in KV or recurrent model memory. A prediction-limit cutoff inside an unclosed reasoning block follows the same transaction policy because there is no retained answer to replay.

With `saveCacheToDisk: false`, no pre-request transaction snapshot or file is created. Cancellation clears the affected sequence, resets its cursor/cache metadata, and invalidates unsaved in-memory cache state. Any existing on-disk cache is left untouched and may be loaded by a later request using that key.

If restoration fails after mutation, the affected sequence is cleared, the active cache session is invalidated, and failed state is not saved over the last-known-good cache file.

Arbitrary thrown prefill, decode, or replay errors use a different recovery path: live model state is reset and the active cache session is invalidated instead of restoring the transaction checkpoint.

### Storage and lifecycle

The persistent checkpoint directly references the canonical per-sequence cache path. Admission records its size, modification time, and parsed metadata, and restoration verifies that identity before loading. The same path cannot be reserved by another persistent request in the process until completion, cancellation, or failure releases ownership. Successful persistence retains that reservation through atomic replacement. Cross-process use of one cache path is unsupported unless callers provide external synchronization; external replacement is detected best-effort and causes rollback failure rather than loading an unverified file.

No transaction checkpoint uses the OS temp directory or working-directory fallback. Sensitive temporary state remains relevant to reasoning removal: when reasoning compaction is active, the distinct end-of-prefill reasoning boundary is stored in a temporary full-state file and removed best-effort on completion, rollback cleanup, replacement, or destruction. Process crashes may leave that reasoning snapshot behind. This layer does not promise encryption or explicitly enforce permissions beyond the platform and llama.cpp file creation.

### Interaction with cache files

- **Freshly loaded `cacheKey` with `saveCacheToDisk: true`:** the validated canonical artifact is pinned without a pre-request save or state serialization.
- **Dirty same-key continuation with `saveCacheToDisk: true`:** admission succeeds and pins the older committed artifact. Cancellation restores that artifact and intentionally loses the unsaved delta; successful completion atomically persists the resulting live state normally.
- **Missing/unusable rollback artifact for a non-empty persistent baseline:** admission fails before request mutation.
- **Missing cache file with an empty baseline:** an in-memory empty marker is used; no file is created until successful persistence.
- **No `cacheKey`, or `saveCacheToDisk: false`:** there is no transaction checkpoint. Cancellation clears unsaved live state.
- **Existing disk cache with `saveCacheToDisk: false`:** the request may load it, but cancellation does not promise restoration. The disk artifact remains unchanged and can be reloaded later.
- **Batch requests:** each admitted sequence owns an independent checkpoint reference and cancellation clears or restores only that sequence. Duplicate cache keys that could overwrite the same artifact are rejected at batch admission.

### Reasoning replay, sliding, and tools

The persistent transaction checkpoint is separate from the end-of-prefill reasoning boundary. Closed reasoning blocks still create the required temporary boundary snapshot, restore it, and replay only retained answer tokens. Cancellation and reasoning removal do not use partial `seq_rm`, `seq_add`, or context-window sliding.

General context-window sliding remains a separate pressure-management operation and may shift supported attention memory. `tools_compact` detection remains available, but tools-tail cache removal is currently disabled.

## Enable caching

Pass `cacheKey` with a file path. The KV cache is loaded from that file if it exists, or created fresh if it doesn't.

```js
await model.run(
  [{ role: 'user', content: 'What is bitcoin?' }],
  { cacheKey: 'session.bin' }
)
```

## Continue a conversation

Use the same `cacheKey`. The existing cache is reused — only the new tokens are evaluated.

```js
await model.run(
  [{ role: 'user', content: 'Tell me more' }],
  { cacheKey: 'session.bin' }
)
```

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
await model.run([{ role: 'user', content: 'Hello' }], { cacheKey: 'a.bin', saveCacheToDisk: true })

// Turn 2: RAM has turn 1 + 2, but a.bin on disk still only has turn 1
await model.run([{ role: 'user', content: 'More' }], { cacheKey: 'a.bin' })

// Turn 3: a.bin on disk updated with turn 1 + 2 + 3
await model.run([{ role: 'user', content: 'Continue' }], { cacheKey: 'a.bin', saveCacheToDisk: true })
```

### Started without saving, then saved later

```js
// Turn 1: cache in RAM only, no file written
await model.run([{ role: 'user', content: 'Hello' }], { cacheKey: 'a.bin' })

// Turn 2: saves everything (turn 1 + 2) to disk
await model.run([{ role: 'user', content: 'More' }], { cacheKey: 'a.bin', saveCacheToDisk: true })
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

## Replay with dynamic tools

When tools change between turns, omit `cacheKey` and send the full conversation history. This gives the model a fresh context with the new tool set.

```js
await model.run(
  [
    { role: 'system', content: 'You are a helpful assistant.' },
    ...history,
    { role: 'user', content: 'Calculate 256 * 128' },
    TOOL_CALCULATOR
  ]
)
```

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
