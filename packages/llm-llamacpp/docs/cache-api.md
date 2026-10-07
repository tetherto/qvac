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

For a batch (`model.run([...])`) there is no top-level second argument — set cache options **per prompt** in `BatchPrompt.runOptions` (`cacheKey`, `ephemeral`, `prefill`, `generationParams`). Passing a second argument to a batch `run()` throws.

```js
// Batch: cache options go per item, not as a second run() argument.
await model.run([
  { prompt: [{ role: 'user', content: 'Hi' }], runOptions: { cacheKey: 'a.bin' } },
  { prompt: [{ role: 'user', content: 'Yo' }], runOptions: { cacheKey: 'b.bin', ephemeral: true } },
])
```

A cached conversation is written to its file by `model.saveCache(cacheKey)`,
or automatically when it would otherwise be lost; see [Save the cache to
disk](#save-the-cache-to-disk).

## runOptions reference

| Option | Type | Description |
| --- | --- | --- |
| `cacheKey` | `string` | Path to the cache file. Omit to disable caching. The conversation stays in memory and is written to this file only by `saveCache()` or when it would otherwise be lost (see [Save the cache to disk](#save-the-cache-to-disk)). |
| `ephemeral` | `boolean` | `true` keeps the conversation in memory only: whenever it would be written automatically, it is dropped instead. `saveCache()` still writes it. Default `false`. |
| `prefill` | `boolean` | Evaluate prompt without generating a response. On a model loaded with `parallel >= 2`, needs a `cacheKey` — see below. |
| `generationParams` | `object` | Per-run overrides for temp, top_p, top_k, predict, seed, penalties. |

`saveCacheToDisk` was removed; passing it throws a `TypeError` that points to
`saveCache()`.

## Prefill on a parallel model (`parallel >= 2`)

A prefill-only run warms context state without generating. On a model loaded with `parallel >= 2` that state lives in a scheduler slot, and concurrent jobs can only reach it through its `cacheKey`, so the prefill needs a `cacheKey`: the warmed conversation then stays in its slot for the next request on that key.

A *keyless* prefill is therefore rejected with `InvalidArgument` on a parallel model, both as a single `run()` and per batch item, rather than silently producing nothing. Load with `parallel: 1` if you want keyless cache warming, where the warmed context is reused by the next run on that instance.

See [continuous-batching.md](continuous-batching.md#prefill-rules-keyed-vs-keyless) for the scheduler-side rules.

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

An earlier answer can go back exactly as it was streamed, reasoning included
(`<think>…</think>` first). The addon moves that block into the message's
`reasoning_content` before rendering, and a message can carry
`reasoning_content` itself instead, as in OpenAI-compatible APIs. The block's
markers are the ones the chat template reports (read once at load, the way
llama-server reads them: `<think>`/`</think>`, Gemma 4's
`<|channel>thought`/`<channel|>`, `[THINK]`/`[/THINK]`, …), with the
model-family table as the fallback. Messages are left as they are on a model
whose template marks no reasoning, and on gpt-oss, whose Harmony channels
are not a block followed by the answer. The chat
template then decides: most drop the reasoning of turns before the last user
message, so the next prompt holds only the answers. Without the split, a
template that reads only `reasoning_content` (DeepSeek V4, Gemma 4) would print
the reasoning as part of the answer.

### Checkpoints on hybrid and recurrent models

Pure-attention models restore a matching prefix by trimming the KV tail.
Hybrid and recurrent models (Qwen3.5, Jamba, Granite-Hybrid, DeepSeek V4, ...)
cannot, so the addon keeps process-local checkpoints per sequence. A cached
request that commits keeps one: the state at the end of the chat history,
just before the generation prompt (`<|im_start|>assistant\n<think>\n` on
Qwen3.5). The prefill stops there for a moment to take it. The state from
before the prompt was sent is also snapshotted, but only to roll the request
back on a cancel or failure; it is dropped when the request commits.

Templates that drop a previous answer's reasoning change the prompt right
after that answer's header, so the history before it is the longest part the
next turn shares. The default single checkpoint serves an ordinary next turn
and a regenerate; with `cache_checkpoints: 2` the one a turn older also serves
an edit of the last user message. A diverging history restores the longest checkpoint
that is still a prefix of the new prompt and re-prefills from there. See
[When checkpoints are taken](./cache-lifecycle.md#when-checkpoints-are-taken)
for the exact points in the pipeline. Checkpoints are pruned as soon as they stop
matching and are lost when the process exits. With `parallel >= 2` the
scheduler keeps them per `cacheKey` between requests, since each request runs
on a fresh slot.

A checkpoint holds only the part of the memory a tail trim cannot rebuild,
and a restore trims the rest back to its position: the recurrent state on
recurrent and hybrid models, the sliding-window cells and compressor states
on DeepSeek V4. Its size is therefore fixed by the model, not the context
(about 20 MB on Qwen3.5-0.8B). Three load-config fields bound the footprint.
None of them has any effect on pure-attention models.

- `cache_checkpoints`: how many to keep per sequence (default 1, maximum
  1024). Each committed request adds one, at the end of its history, before
  the generation prompt. The default keeps the last one, which serves an
  ordinary next turn and a regenerate. `2` also keeps the one before it, which
  serves an edit of the last user message; both stop before an answer, so they
  still match when the template rewrites earlier answers (thinking models drop
  the reasoning).

  To change the user message that is *k*-th from the end (`1` = the last
  one) without reprocessing the whole conversation, keep at least `k + 1`
  checkpoints:

  | Change | Needs `cache_checkpoints` | Reprocessed |
  |---|---|---|
  | next turn, regenerate | 1 (default) | the previous answer, the new message |
  | edit the last user message | 2 | the answer before it, the edited message |
  | edit the user message before it | 3 | from that message's previous answer on |
  | edit the *k*-th from the end | *k* + 1 | from that message's previous answer on |

  With fewer, nothing usable is left and the whole prompt is reprocessed, so
  with the default 1 an edit of the last user message reprocesses the entire
  conversation. That holds only while the turns in between each committed a
  checkpoint and `cache_checkpoints_max_bytes` did not evict it; a restart
  clears them. An edit also drops the checkpoints after it, which no longer
  match. `0` keeps none and takes none, which makes every divergent turn a
  cold prefill.
- `cache_checkpoints_max_bytes`: total payload budget per sequence, enforced
  before the count: the oldest checkpoints are dropped until the total fits.
  `0` (default) is unlimited. When set, the load fails with `InvalidArgument`
  if the budget cannot hold `cache_checkpoints` checkpoints of the largest size
  the context allows. The addon measures that size on the loaded model, so
  the error names the exact numbers and the count that would fit.
- `cache_checkpoint_storage`: `memory` (default) keeps checkpoints and the
  per-request rollback snapshot in host RAM, so a cached chat never touches
  the disk; each live snapshot costs its size in RAM (about 20 MB on
  Qwen3.5-0.8B, 18 MB on DeepSeek V4). `disk` writes them instead to a
  private directory (mode 0700 on POSIX) the addon creates under the OS temp
  directory when the model loads. If that directory cannot be created, the
  load fails with `InvalidArgument`; set `TMPDIR` to a writable directory or
  use `memory`.

The storage setting is independent of the `cacheKey` file. In both modes that
file is written only by the writes described in [Save the cache to
disk](#save-the-cache-to-disk): `saveCache()`, or the conversation leaving
memory with unsaved turns. So a chat can run entirely in memory and be
persisted at any point with `model.saveCache(cacheKey)`; the file then holds
the full conversation state and a later run, including one after a process
restart, loads it and continues from there. Checkpoints are never persisted:
after a restart the list is empty in both modes and the first diverging turn
on a hybrid model is a cold prefill.

```js
const model = new LlmLlamacpp({
  files: { model: [modelPath] },
  config: {
    device: 'gpu',
    ctx_size: '8192',
    cache_checkpoints: '4',
    cache_checkpoints_max_bytes: String(2 * 1024 * 1024 * 1024),
    cache_checkpoint_storage: 'disk'
  }
})
```

## Batch mode (`parallel >= 2`)

On a model loaded with `parallel >= 2`, keyed requests keep the same promise
as the single-prompt path: the conversation stays in memory between requests.

- **Resident slot.** When a keyed request commits, its state stays in its
  scheduler slot. The next request with the same `cacheKey` is routed to that
  slot and continues from it, with nothing copied or read from disk.
- **One request per key at a time.** A request whose `cacheKey` is already
  running waits until that request ends, then continues from its committed
  state. Several prompts on one key in the same batch therefore run one after
  another, while prompts on other keys run in parallel.
- **Eviction.** When every slot holds a resident conversation and a request
  needs a slot for another key, the least recently used conversation is moved
  out: into the [RAM tier](#keep-switched-away-conversations-in-ram) when it is
  enabled, otherwise to its `cacheKey` file if it has turns the file does not
  hold yet (the same automatic save the single-prompt path does when it
  switches keys), or dropped if it is ephemeral. Its next request restores it
  from wherever it went.
- A conversation whose loaded `cacheKey` file is deleted is dropped, as on the
  single-prompt path. Requests without a `cacheKey` are never kept.

Resident conversations with unsaved turns are written to their files when
the model is reloaded (finetuning reloads it) or unloaded, except ephemeral
ones; a crash always loses turns that were only in memory.

## Keep switched-away conversations in RAM

`cache_ram_mib` (load config, default `0` = off) gives the model a host-RAM
budget, in MiB, for conversations that are not the one currently running.
Both paths share it:

- **Single prompt (`parallel = 1`).** A switch to another `cacheKey`, or a
  request without one, moves the active conversation into RAM instead of
  writing its file. Switching back restores it from RAM, including its
  checkpoints, so neither a file read nor a file write happens.
- **Batch (`parallel >= 2`).** A conversation evicted from its slot moves into
  RAM instead of being written through to its file.

The tier is a write-back cache. A conversation with unsaved turns reaches its
`cacheKey` file only when:

- `saveCache(cacheKey)` is called;
- the budget is full and it is the oldest entry: it is written, then dropped;
- it is too large to fit the whole budget: it is saved the way it would be
  without the tier;
- the model is unloaded or reloaded: every conversation with unsaved turns,
  in RAM, resident in a slot or active on the single-prompt path, is written
  to its file.

Ephemeral conversations move into the tier like any other, but the budget and
the unload drop them instead of writing them. Admission and eviction follow
llama-server's `--cache-ram`: a newer entry for the same key replaces the
older one, and the oldest entries go first. A conversation whose loaded file
was deleted is dropped instead of written back. A crash loses turns that were
only in RAM; call `saveCache()` after the turns that must survive one.

```js
const model = new LlmLlamacpp({
  files: { model: [modelPath] },
  config: { ctx_size: '16384', parallel: '4', cache_ram_mib: '2048' }
})
```

## Save the cache to disk

A cached conversation lives in memory. Its `cacheKey` file holds the full
in-memory state (KV cache, plus the recurrent state on hybrid and recurrent
models) and the cache ledger, and is written in two ways: on request, with
`saveCache()`, and automatically, when the conversation would otherwise be
lost with turns the file does not hold yet ("unsaved turns": a request ran on
it since its file was last written or loaded). Checkpoints are never written
to the file.

Every write goes to `<cacheKey>.tmp` first and then replaces `<cacheKey>` in
one rename, so a crash or a failed write never leaves a half-written file.
[How the `cacheKey` file is
written](cache-lifecycle.md#how-the-cachekey-file-is-written) lists every
write on both paths in detail.

### `saveCache(cacheKey)`

```js
const history = [{ role: 'user', content: 'Hello' }]
await collectOutput(await model.run(history, { cacheKey: 'session.bin' }))
await model.saveCache('session.bin') // session.bin now holds the conversation
```

`saveCache` works for any `cacheKey`, on both paths:

- it writes the conversation wherever it is kept: the active single-prompt
  conversation, a batch conversation resident in its slot, or one in the RAM
  tier;
- when a request on that key is running, it waits for it to finish and writes
  what it committed, never a request in progress (a request that rolls back
  leaves the previous state, which is what gets written);
- it runs between decode steps on a parallel model, so other slots keep
  generating;
- it resolves without writing when the file already holds the conversation,
  and rejects with `InvalidArgument` when nothing is cached under the key and
  no file exists;
- it writes ephemeral conversations too, and writes even when the caller
  deleted the old file.

Because it runs after `run()` returns, another request on the same key can be
served first, and the file then holds that turn as well. It is always a
committed state.

### `discardCache(cacheKey)`

```js
await model.discardCache('session.bin') // nothing in memory for session.bin
fs.rmSync('session.bin', { force: true }) // and nothing on disk
```

`discardCache` drops the conversation kept in memory for `cacheKey` without
writing it: the active single-prompt conversation, a batch conversation
resident in its slot, its RAM-tier entry and its checkpoints. No later
eviction or unload writes it, so it is how an app deletes a chat. Like
`saveCache`, it waits for a request running on that key. It leaves the file
alone: delete the file as well to remove a conversation that was already
written. It resolves when nothing is kept for the key.

### Automatic writes

**Single prompt (`parallel = 1`).** Without the [RAM
tier](#keep-switched-away-conversations-in-ram), a conversation with unsaved
turns is written:

1. **When switching to a different `cacheKey`**: the old conversation is
   saved, then the new one is loaded.
2. **When a request omits `cacheKey`**: the active conversation is saved, then
   cleared.
3. **When the model is reloaded** (finetuning does) **or unloaded.**

Sending the same `cacheKey` again writes nothing. With the RAM tier on, cases
1 and 2 move the conversation into RAM instead of writing it.

**Batch (`parallel >= 2`).** Without the RAM tier, a conversation with unsaved
turns is written:

1. **When a slot is needed for another key**: the least recently used resident
   conversation is evicted and saved.
2. **When the model is reloaded or unloaded.** This is skipped, with a
   warning, while a batch request is running.

A request that finishes leaves its conversation in its slot and writes
nothing. With the RAM tier on, an evicted conversation moves into RAM instead
of being written.

Eviction copies the conversation's whole state off the device, and writes it
to its file when the RAM tier is off; `saveCache()` writes it too. With the
tier on, a full tier writes its oldest entry with unsaved turns at that same
point to make room. All of these run on the scheduler's worker thread, so
every slot pauses for that long: up to hundreds of MB on a long context.
Sizing `cache_ram_mib` to hold the conversations in use moves eviction writes
from admission to unload.

**On both paths:**

- An ephemeral conversation is never written automatically: each of the
  writes above drops it instead, and its next request starts cold.
- A conversation with no unsaved turns, or with nothing committed (its only
  request rolled back), is not written.
- A conversation whose loaded or saved file has been deleted (or its
  directory removed, or the file emptied) is dropped instead of written back,
  and its next request starts cold. This covers only a conversation that was
  already written: one that never was has no file to delete, and is written
  at the next eviction or unload. Use
  [`discardCache(cacheKey)`](#discardcachecachekey) to discard a conversation
  either way.
- A crash or a killed process loses the turns that were only in memory. On
  mobile, where the OS can kill a backgrounded app without an unload, call
  `saveCache()` when the app goes to the background or after the turns that
  must survive.

### Saved after some turns only

```js
// Turn 1: in memory only
const history = [{ role: 'user', content: 'Hello' }]
const first = await collectOutput(await model.run(history, { cacheKey: 'a.bin' }))
history.push({ role: 'assistant', content: first })
await model.saveCache('a.bin') // a.bin holds turn 1

// Turn 2: memory has turns 1 + 2, a.bin on disk still only has turn 1
history.push({ role: 'user', content: 'More' })
const second = await collectOutput(await model.run(history, { cacheKey: 'a.bin' }))
history.push({ role: 'assistant', content: second })
await model.saveCache('a.bin') // a.bin holds turns 1 + 2
```

### Never written: ephemeral conversations

```js
// Kept in memory for reuse, never written automatically.
const history = [{ role: 'user', content: 'Private question' }]
await model.run(history, { cacheKey: 'tmp.bin', ephemeral: true })
// Switching away (or unloading) drops it; tmp.bin is never created.
await model.run([{ role: 'user', content: 'Other chat' }], { cacheKey: 'b.bin' })
```

The flag belongs to the conversation's latest request: a later request on the
same key without `ephemeral` makes it a normal conversation again.

## Switch between cache files

On the single-prompt path, passing a different `cacheKey` saves the old conversation to its file if it has unsaved turns (moves it into the RAM tier when that is on, or drops it when it is ephemeral), then loads the new one.

```js
await model.run([{ role: 'user', content: 'Topic A' }], { cacheKey: 'session1.bin' })

// session1.bin is saved (it has an unsaved turn), then session2.bin is loaded
await model.run([{ role: 'user', content: 'Topic B' }], { cacheKey: 'session2.bin' })
```

## Single-shot inference (no caching)

Omit `cacheKey`. No cache is used and the context is reset after each call.

```js
await model.run([{ role: 'user', content: 'One-off question' }])
```

If caching was previously active, omitting `cacheKey` saves the active conversation to its file (unless it is ephemeral or has no unsaved turns) and clears it.

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
everything the request added is dropped, and the on-disk file is left
untouched. On pure-attention models the rollback lands on
the longest prefix the cache shares with the request's prompt, which is what a
retry reuses. On hybrid and recurrent models the state from before the prompt
is restored from a snapshot, unless the request diverged and restored a
checkpoint: that restore already replaced the KV cache past the checkpoint, so
the rollback lands on the checkpoint, the state the KV cache, the recurrent
state and the ledger still agree on. Prefill-only requests commit as soon as
prefill completes.

A chat on a pure-attention model with one `cacheKey` therefore never touches
the disk until it is saved, switched away from or unloaded: the conversation
lives in the KV cache, and no snapshot or checkpoint is ever written for these
models. On hybrid and
recurrent models the same holds by default; `cache_checkpoint_storage:
'disk'` moves their snapshots and checkpoints to temp files.

The same rule applies to requests without `cacheKey`. Nothing reuses their
state, so the only visible difference is `CacheTokens`, which reports the
tokens actually decoded rather than the pre-request cursor.

The `cacheKey` file changes only through the writes described in [Save the
cache to disk](#save-the-cache-to-disk). Process-local checkpoints are never
written into it.

## Save failures

If a cache write fails (e.g. the disk is full, the path is unwritable, or `llama_state_save_file` returns false), a `StatusError` with code `UnableToSaveSessionFile` is raised.

- **`saveCache()`**: the promise rejects. The conversation stays in memory, still marked unsaved, so the call can be retried (for example once the directory exists). On a parallel model only the caller sees the error; other slots keep running.
- **Single-prompt switch or keyless request** (the automatic save before a key change or a request without `cacheKey`): the error propagates from `model.run()` and the old conversation is dropped. Subsequent calls proceed without attempting that save again.
- **Writes no request asked for** (a batch eviction, a full RAM tier letting an entry go, the flush on reload or unload) never fail a request: the failure is logged and that conversation's unsaved turns are lost.
- If the active cache's backing file or parent directory was externally removed before a switch or clear, the stale in-memory cache is discarded and the next request starts from a fresh context instead of throwing `UnableToSaveSessionFile`.
- On same-key reuse, a removed backing file also starts from a fresh context.

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
