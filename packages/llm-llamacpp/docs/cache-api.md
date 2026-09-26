# KV Cache API

Cache control is managed through `runOptions`. For a single prompt, pass `runOptions` as the second argument to `model.run(prompt, runOptions)`.

For the mechanics behind these options, with state diagrams of the request
transaction, prompt reconciliation, checkpoints and the `cacheKey` file, see
[cache-lifecycle.md](./cache-lifecycle.md).

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

### Checkpoints on hybrid and recurrent models

Pure-attention models restore a matching prefix by trimming the KV tail.
Hybrid and recurrent models (Qwen3.5, Jamba, Granite-Hybrid, DeepSeek V4, ...)
cannot, so the addon keeps process-local checkpoints per sequence. A cached
request that commits keeps two:

- the state from before its prompt was sent, and
- the state at the end of the chat history, just before the generation prompt
  (`<|im_start|>assistant\n<think>\n` on Qwen3.5). The prefill stops there for
  a moment to take it.

The second is the one a normal next turn uses: templates that drop a previous
answer's reasoning change the prompt right after that answer's header, so
the history before it is the longest part the next turn shares. A diverging
history restores the longest checkpoint that is still a prefix of the new
prompt and re-prefills from there. Checkpoints are pruned as soon as they stop
matching and are lost when the process exits. With `parallel >= 2` the
scheduler keeps them per `cacheKey` between requests, since each request runs
on a fresh slot.

On hybrid and recurrent models a checkpoint holds only the recurrent state;
the attention KV is trimmed back instead. Its size is therefore fixed by the
model, not the context (about 20 MB on Qwen3.5-0.8B). DeepSeek V4 keeps full
copies of the sequence state. Three load-config fields bound the footprint.
None of them has any effect on pure-attention models.

- `cache_checkpoints`: how many to keep per sequence (default 32, maximum
  1024). `0` keeps none, which makes every divergent turn a cold prefill.
- `cache_checkpoints_max_bytes`: total payload budget per sequence, enforced
  before the count: the oldest checkpoints are dropped until the total fits.
  `0` (default) is unlimited. When set, the load fails with `InvalidArgument`
  if the budget cannot hold `cache_checkpoints` checkpoints of the largest size
  the context allows. The addon measures that size on the loaded model, so
  the error names the exact numbers and the count that would fit.
- `cache_checkpoint_storage`: `disk` (default) writes checkpoints and the
  per-request rollback snapshot to the OS temp directory; `memory` keeps them
  in host RAM, so a cached chat never touches the disk. Each live snapshot
  costs its size in RAM.

The storage setting is independent of the `cacheKey` file. In both modes that
file is written only by the saves described in [Save the cache to
disk](#save-the-cache-to-disk): a committed request with `saveCacheToDisk`, a
switch to another `cacheKey`, or a request without one. So a chat can run
entirely in memory and be persisted later by sending a turn with
`saveCacheToDisk: true`; the file then holds the full conversation state and a
later run, including one after a process restart, loads it and continues from
there. Checkpoints are never persisted: after a restart the list is empty in
both modes and the first diverging turn on a hybrid model is a cold prefill.

```js
const model = new LlmLlamacpp({
  files: { model: [modelPath] },
  config: {
    device: 'gpu',
    ctx_size: '8192',
    cache_checkpoints: '4',
    cache_checkpoints_max_bytes: String(2 * 1024 * 1024 * 1024),
    cache_checkpoint_storage: 'memory'
  }
})
```

## Save the cache to disk

`saveCacheToDisk: true` writes the full in-memory KV cache state to the
`cacheKey` file once the request commits (see [Commit and
rollback](#commit-and-rollback)). A request that rolls back leaves the file as
it was.

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

## Commit and rollback

A cached request is a transaction. It commits, and its tokens stay resident,
whenever the caller received what was produced: the model stopped on its own
(EOS or an antiprompt), it hit the caller's `n_predict` limit, or the caller
cancelled after prefill had completed. Such a cancel keeps the prompt and every
streamed token, so the next full-history turn resumes from there. A cancel
during prefill, a decode error and a context overflow roll the request back:
everything the request added is dropped, `saveCacheToDisk` is skipped, and the
on-disk file is left untouched. On pure-attention models the rollback lands on
the longest prefix the cache shares with the request's prompt, which is what a
retry reuses; on hybrid and recurrent models the state from before the prompt
is restored from a snapshot. Prefill-only requests commit as soon as prefill
completes.

A chat on a pure-attention model with one `cacheKey` and no `saveCacheToDisk`
therefore never touches the disk: the conversation lives in the KV cache, and
no snapshot or checkpoint is ever written for these models. On hybrid and
recurrent models the same holds with `cache_checkpoint_storage: 'memory'`.

The same rule applies to requests without `cacheKey`. Nothing reuses their
state, so the only visible difference is `CacheTokens`, which reports the
tokens actually decoded rather than the pre-request cursor.

The `cacheKey` file changes only through the saves described in [Save the
cache to disk](#save-the-cache-to-disk): a commit with `saveCacheToDisk`, a
switch to another `cacheKey`, or a request that omits `cacheKey`. Process-local
checkpoints are never written into it.

## Save failures

If a cache write fails (e.g. the disk is full, the path is unwritable, or `llama_state_save_file` returns false), a `StatusError` with code `UnableToSaveSessionFile` is thrown.

- On the **explicit-save** path (`saveCacheToDisk: true`): the error propagates from `model.run()`. The in-memory KV state is still valid; the caller can retry or continue without saving.
- On the **cache-switch** and **cache-clear** paths (automatic flush on key change or `cacheKey` omission): the error propagates from `model.run()` and the cache is left disabled. Subsequent calls without a `cacheKey` will proceed without attempting the flush again.
- If the active cache's backing file or parent directory was externally removed before a switch or clear, the stale in-memory cache is discarded and the next request starts from a fresh context instead of throwing `UnableToSaveSessionFile`.
- On same-key reuse, a removed backing file also starts from a fresh context. If the parent directory was removed and `saveCacheToDisk: true` is set, the fresh request can still throw `UnableToSaveSessionFile` during its explicit save.

## Cache token count

`CacheTokens` is available in `response.stats` after every run. No dedicated
command needed. It reports the tokens resident after the request settled: the
committed prompt plus generated tokens, or the pre-request cursor when the
request rolled back (see [Commit and rollback](#commit-and-rollback)).

```js
const response = await model.run(
  [{ role: 'user', content: 'Hello' }],
  { cacheKey: 'session.bin' }
)
console.log(response.stats.CacheTokens)
```
