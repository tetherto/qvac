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

Every admitted text, multimodal, and continuous-batch request captures a full per-sequence transaction checkpoint. Cache loading or same-key in-memory continuation is resolved first; checkpoint capture then occurs before request tokenization, automatic context sliding, media/text prefill decode, or generation mutates llama model memory.

Explicit prefill or generation cancellation restores this pre-request checkpoint. Partial output may already have streamed to the caller, but it is not retained in KV or recurrent model memory. A prediction-limit cutoff inside an unclosed reasoning block also restores the pre-request checkpoint because there is no retained answer to replay. Successful requests and successful cancellation rollback release the checkpoint.

Checkpoint capture failure aborts before request-memory mutation. If restoration fails after mutation, the affected sequence is cleared, its cursor/cache metadata is reset coherently, the active cache session is invalidated, and failed state is not saved over the last-known-good cache file.

Arbitrary thrown prefill, decode, or replay errors use a different recovery path: live model state is reset and the active cache session is invalidated instead of restoring the transaction checkpoint.

### Storage and lifecycle

For a non-empty sequence, the checkpoint is a full state file written with llama.cpp's per-sequence state API. It contains attention KV state and, where present, recurrent/SSM state. The file is stored under the operating system temporary directory with a process/sequence/counter-based name. If resolving the OS temp directory fails, the implementation currently falls back to the process working directory.

An empty sequence does not create a file. It records an in-memory captured-empty marker; restoration clears that sequence to its empty state.

Checkpoint files are owned by the request rollback state and removed on successful completion, rollback cleanup, replacement, or destruction. Removal is best-effort, so process crashes may leave residue. The files contain sensitive model state. This layer does not promise encryption or explicitly enforce permissions beyond those provided by the platform and llama.cpp file creation.

Checkpointing adds one full sequence-state write per non-empty request. Reasoning removal may add a second full state file at the end-of-prefill boundary because that state differs from the pre-request transaction checkpoint.

### Interaction with cache files

- **Freshly loaded `cacheKey`:** the validated cache is loaded first, then the same live sequence is serialized again as the transaction checkpoint. The implementation does not currently reuse the canonical cache file.
- **Dirty same-key continuation:** the live in-memory state may be newer than the on-disk file, so an explicit checkpoint is required.
- **No existing cache file:** the newly activated in-memory sequence is checkpointed normally.
- **No `cacheKey`:** caching remains disabled. Empty contexts use the captured-empty marker; non-empty live state still requires a checkpoint.
- **`saveCacheToDisk`:** controls end-of-request persistence only and does not disable transaction checkpoint capture.
- **Batch requests:** each admitted sequence owns an independent checkpoint and rollback affects only that sequence.

The canonical disk cache could only serve as a rollback checkpoint if it were validated, immutable, guaranteed to match the live sequence exactly, and pinned for the full request lifetime. Those invariants do not hold for dirty continuation or unsaved state, so current code uses an independent checkpoint.

### Reasoning replay, sliding, and tools

The transaction checkpoint is separate from the end-of-prefill reasoning boundary. Closed reasoning blocks restore that later boundary and replay only retained answer tokens. Cancellation and reasoning removal do not use partial `seq_rm`, `seq_add`, or context-window sliding.

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
