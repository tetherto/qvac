# Continuous Batching

`@qvac/llm-llamacpp` supports continuous batching: submitting multiple prompts in a single `run()` call so the GPU decodes tokens from all of them in one forward pass per step. This document describes the architecture and explains each component.

---

## Table of contents

- [What it does](#what-it-does)
- [Enabling it](#enabling-it)
- [JS API](#js-api)
- [How a batch flows from JS to native slots](#how-a-batch-flows-from-js-to-native-slots)
- [Components](#components)
  - [ContinuousBatchScheduler](#continuousbatchscheduler)
  - [MultiRequestBatcher](#multirequestbatcher)
  - [SequenceDriver and TextLlmContext](#sequencedriver-and-textllmcontext)
- [Queued vs active requests](#queued-vs-active-requests)
- [Per-sequence context caps](#per-sequence-context-caps)
- [Sequence ids and streaming](#sequence-ids-and-streaming)
- [Cache per slot](#cache-per-slot)
- [Cancellation semantics](#cancellation-semantics)
- [Stats and output aggregation](#stats-and-output-aggregation)
- [Limitations](#limitations)

---

## What it does

In the default single-prompt path, the GPU sits idle between generation steps while sampling and I/O run on the CPU. Concurrent callers each get their own sequential decode loop, so there is no GPU work sharing between them.

With continuous batching enabled, a single worker thread runs a shared decode loop. On every step it collects one token from each active sequence into one `llama_batch`, calls `llama_decode` once, then samples a token per sequence. A new sequence can join at any step as soon as a slot frees up.

---

## Enabling it

Set `parallel` in the model config to the number of concurrent sequence slots you want:

```js
const model = new LlmLlamacpp({
  files: { model: ['/path/to/model.gguf'] },
  config: {
    device: 'gpu',
    gpu_layers: '99',
    ctx_size: '8192',
    parallel: '4'  // 4 concurrent sequences; values >= 2 activate continuous batching
  }
})
```

`parallel` maps to `n_seq_max` in llama.cpp. The KV cache is split uniformly: with `ctx_size: '8192'` and `parallel: '4'`, each slot gets a 2048-token window. Values less than 2 leave the single-prompt path active; batch `run()` calls throw `InvalidArgument` in that case.

Continuous batching works on text-only models. Multimodal (vision) models use a separate context type and do not support batch mode.

---

## JS API

### Input shapes

`run()` accepts three shapes:

```ts
// Single prompt — unchanged
run(prompt: Message[]): Promise<QvacResponse>

// Batch prompts, with raw prompts and BatchPrompt wrappers allowed in the same array
run(prompt: (Message[] | BatchPrompt)[]): Promise<BatchResponse>
```

`BatchPrompt`:
```ts
interface BatchPrompt {
  id?: string         // caller-supplied; the scheduler assigns one if omitted
  prompt: Message[]
  runOptions?: RunOptions  // per-item generationParams, cacheKey, saveCacheToDisk
}
```

### BatchResponse

`BatchResponse` extends `QvacResponse`:

```ts
interface BatchResponse extends QvacResponse {
  ids: string[]                                        // JS-facing ids, in input order
  on(event: 'output', cb: (chunk: BatchOutputChunk) => void): this
  onUpdate(cb: (chunk: BatchOutputChunk) => void): this
  await(): Promise<BatchResult[]>
}

interface BatchOutputChunk {
  id: string    // JS-facing id
  chunk: string // decoded text fragment
}

interface BatchResult {
  id: string
  output: string  // full accumulated output for this sequence
}
```

Streaming chunks arrive in decode order, interleaved across sequences. The `id` field correlates each chunk to the prompt that produced it. `await()` resolves once all sequences finish and returns results in the original input order.

### Stats

`RuntimeStats` gains `avgConcurrentSeq`: the mean number of sequences decoded together during the batch, measured across all `llama_decode` steps.

`TPS` reflects decode throughput and `ppTPS` reflects prefill throughput, each measured from per-step wall-clock timing. (llama.cpp's context counters misfile batched generation as prompt eval, so phase-separated rates require independent timing.)

---

## How a batch flows from JS to native slots

```
JS: run([ [...], [...], [...] ])
        |
        v
index.js: BatchHandler.isBatchInput() => true
        |
        v
_runBatchInternal():
  items = BatchHandler._unwrapItems(batchInput)
  response = new QvacResponse(...)
  job.startWith(response)
  result = await _runJob(items)   // calls addon.runJob(items) via LlamaInterface
        |
        v
AddonJs.hpp: runJob() [C++ binding]
  getLlamaModel(instance)->supportsBatching() check
  parsePromptBatch(items) -> vector<Prompt>
  LlamaModel::processPromptBatch(prompts)
        |
        v
LlamaModel::processPromptBatchImpl():
  validateBitnetQuantization()
  check duplicate saveCacheToDisk keys (throws InvalidArgument)
  ContinuousBatchScheduler::processBatch(requests)
        |
        v
ContinuousBatchScheduler::processBatch():
  push requests into pending_ (lock-free ConcurrentQueue)
  wake worker thread via workCv_
  block until BatchGroup.done == true
  return BatchResult { outputs[], stats }
        |
        v
Worker thread loop:
  admitPendingIntoFreeSlotsLocked()   // move pending -> active slots
  stepLocked():
    batcher_.fillBatch(batch_)         // fill llama_batch from active slots
    llama_decode(ctx, batch_)
    batcher_.sampleAndAppendIdle()     // sample one token per active slot
    batcher_.advance()                 // advance position, check budget
    finalizeFinishedSequences()        // fire lifecycle hooks, free slots
    admitPendingIntoFreeSlotsLocked()  // refill freed slots
```

---

## Components

### ContinuousBatchScheduler

**File:** `addon/src/model-interface/ContinuousBatchScheduler.{hpp,cpp}`

The scheduler owns the decode loop. It wraps `MultiRequestBatcher`, the shared `LlamaBatch`, per-slot state (`SlotState`), and a dedicated worker thread.

**Worker thread lifecycle:**

1. The thread starts on the first `processBatch` call.
2. It waits on `workCv_` when there is no work.
3. On wake, it calls `admitPendingIntoFreeSlotsLocked()` to move requests from `pending_` into free slots.
4. It runs `stepLocked()` in a loop until no active sequences remain.
5. Each step: fill batch, decode, sample, advance, finalize finished sequences, refill slots.

**SlotState** holds, per slot:
- `driver` — a `TextLlmContext` instance implementing `SequenceDriver`
- `group` + `outputIndex` — back-pointer to the `BatchGroup` this slot belongs to
- `streams` — per-sequence `onToken` / `onDone` callbacks wired to the JS streaming path
- `cacheKey`, `saveCacheToDisk`, `prefillOnly`
- `tools` — `ToolsCompactController` instance (when tools support is enabled)

**BatchGroup** is shared by all sequences admitted in one `processBatch` call. It tracks completion count and accumulates outputs and stats. When `completedCount == totalCount` the group is marked done and `processBatch` returns.

**Per-sequence context cap:**

```
perSeqMaxTokens_ = ctxTotalTokens / batchSize
```

This is enforced at admission: prompts larger than the cap, or with `prompt + n_predict` exceeding the cap, throw `InvalidArgument` before any state is mutated.

### MultiRequestBatcher

**File:** `addon/src/model-interface/MultiRequestBatcher.{hpp,cpp}`

Handles the lower-level mechanics of turning per-slot state into a `llama_batch`.

The batcher keeps a fixed-size `vector<optional<Request>>` indexed by `seqId`. A free slot is one where the optional is empty. When a request is admitted, `addRequestAt(seqId, tokens)` places it at that index.

**fillBatch** — called once per step:
- Iterates active slots.
- For each slot, feeds up to `maxChunkSize` tokens into the shared `llama_batch` (prompt tokens during prefill, the last sampled token during generation).
- Returns `FillResult { chunkSize, numActiveSequences, numPrefillingSequences }`. The prefill count lets the scheduler split a step's tokens into prompt vs decode for TPS/ppTPS measurement.

**sampleAndAppendIdle** — called after `llama_decode`:
- Fires the caller-supplied `SamplerFn(seqId, logitIdx)` for each slot whose chunk consumed all its pending tokens.
- The sampled token is appended to the slot's `generatedTokens` and staged for the next step.

**advance** — advances `currentPos` for each slot, notifies the driver via `PrefillCompleteFn` when prefill finishes.

**extractFinished** — moves finished `Request` objects out and returns them; the scheduler then fires terminal lifecycle hooks and frees the KV cache entries before making the slot available again.

### SequenceDriver and TextLlmContext

**Files:** `addon/src/model-interface/SequenceDriver.hpp`, `TextLlmContext.{hpp,cpp}`

`SequenceDriver` is the interface the scheduler calls for per-sequence decisions. `TextLlmContext` implements it (as well as the older `LlmContext` interface used by the single-prompt path).

Lifecycle methods in call order:

| Method | When | What it does |
|--------|------|--------------|
| `validatePromptPolicy` | Before admission | Rejects oversized prompts or invalid layout |
| `loadCache` | After validation | Loads KV cache from disk if `cacheKey` is set |
| `preparePrefill` | At admission | Tokenizes chat messages, returns pending tokens |
| `onPrefillComplete` | When prefill finishes | Records `nPast`, triggers context-shift check |
| `onLogitsReady` | Each generation step | Samples next token, runs antiprompt/stop checks |
| `onGenerationFinished` | Natural EOG | Runs `onGenerationCompletePolicy` (tools_compact trim), flushes UTF-8 buffer |
| `onCancel` | User cancel or decode error | Same policy as above; called before KV clear |
| `onSequenceEnd` | Every terminal path | Flushes remaining UTF-8 buffer |
| `saveCache` | After KV clear | Persists KV cache to disk if `saveCacheToDisk` is set |

`TextLlmContext` carries `perSeqCtxCeiling_` (set to `perSeqMaxTokens_` by the scheduler, or `-1` for single-sequence). Prefill sliding and generation overflow checks use this ceiling rather than the full `llama_n_ctx()`. `n_discarded` is clamped to the per-slot window at construction.

---

## Queued vs active requests

When a batch has more prompts than `parallel` slots, the scheduler pushes all requests into `pending_` (a `moodycamel::ConcurrentQueue`) and admits them into free slots as generation completes.

`pending_` is lock-free for writes (push path from `processBatch`) and drained under `mutex_` (pop path from `admitPendingIntoFreeSlotsLocked`). This keeps admission off the hot decode path.

State diagram for one sequence:

```
pending_ queue
    |
    v  (slot frees up)
active slot (prefill phase)
    |
    v  (prefill finishes)
active slot (generation phase)
    |
    v  (EOG / budget / cancel)
finalizeFinishedSequences()
    |
    v
slot freed, BatchGroup updated
```

---

## Per-sequence context caps

With `parallel = N` and `ctx_size = C`, each slot gets `C / N` tokens. This affects:

- **Admission** — prompts larger than `C / N` are rejected with `InvalidArgument` before any tokens are staged.
- **Budget check** — `prompt_tokens + n_predict` must fit within `C / N`. Requests that exceed this are also rejected at admission rather than truncated silently.
- **Context sliding** — when `n_discarded > 0`, the slide triggers against `C / N`, not the full context. A value of `n_discarded >= C / N` is clamped and logs a warning.
- **Cache loading** — the overflow check on cached prompts uses `C / N` as the ceiling.

---

## Sequence ids and streaming

Each admitted native sequence gets an internal `uint32_t seqId` equal to its
slot index (0 to N-1). This is the llama.cpp slot id only.

The JS-facing `id` is separate: it is the caller-provided `BatchPrompt.id` when
present, or an auto-minted id such as `batch-1` when the prompt is passed as a
plain `Message[]` or omits `id`. `AddonBatchRunResult.ids` returns those
JS-facing ids in input order.

Streaming works as follows:

1. `processPromptBatch` returns `{accepted: true, ids: ["batch-1","batch-2","batch-3"]}` for plain `Message[]` inputs, or caller-provided ids such as `["fruit","country"]` for `BatchPrompt` inputs.
2. `BatchHandler` stores these as `response.ids` on the `BatchResponse`.
3. Each token from the native side fires a `BatchOutput` event carrying `{id, output}`, where `id` is the JS-facing id rather than the native slot index.
4. `index.js` routes this to `batchHandler.onOutput(data)`, which calls `job.output({ id: data.id, chunk: data.output })`.
5. The response emits an `output` event with a `BatchOutputChunk`.
6. When all sequences finish, the scheduler fires a `BatchResult` event with the full ordered output array; `buildFinalResultIfActive()` maps it back to `{id, output}` pairs in input order.

---

## Cache per slot

Each `BatchPrompt` may carry its own `cacheKey` and `saveCacheToDisk`. The scheduler creates one `TextLlmContext` per slot, so KV caches are isolated by slot index.

Two restrictions apply in batch mode:

1. **Read sharing is allowed.** Multiple prompts in the same batch may use the same `cacheKey` without `saveCacheToDisk`. This is a valid cache-warming pattern.
2. **Write sharing is rejected.** Two prompts with the same `cacheKey` and `saveCacheToDisk: true` would clobber each other (last writer wins, no ordering guarantee). `processPromptBatchImpl` detects this before any admission and throws `InvalidArgument`.

---

## Cancellation semantics

Cancellation behaves differently depending on where a prompt is when `cancel()` fires:

| Prompt state | What happens |
|--------------|--------------|
| In a slot (decoding) | Cancelled gracefully. The slot runs `onCancel`, flushes its UTF-8 buffer, and the batch call resolves normally with whatever was generated so far. |
| In `pending_` (never admitted) | Drained without running. The associated `BatchGroup` is failed with a `Cancelled` `StatusError`. |

If a batch had overflow prompts still in `pending_`, the batch call rejects with `Cancelled`. Callers should handle that rejection rather than expecting empty strings for the prompts that never ran.

`requestCancelAll()` sets `cancelRequested_` atomically. The worker loop detects the flag after each step: it drains `pending_` (failing pending groups) before the flag is cleared, so active and queued prompts are both covered.

---

## Stats and output aggregation

Stats are collected in two places and merged at the end:

- **Per-step** — `RuntimeStatsSnapshot::recordDecodeStep` accumulates decode vs prefill tokens and their wall-clock duration. A step that carries any generation token is charged wholly to the decode bucket; only pure-prefill steps feed the prefill bucket.
- **Per-slot** — `accumulateSlotRuntimeStats` folds `nPast`, context slides, and cache tokens for each completed slot into the scheduler's `RuntimeStatsSnapshot`.

`avgConcurrentSeq` is computed as:

```
concurrentSeqSum_ / decodeStepCount_
```

where `concurrentSeqSum_` accumulates `numActiveSequences` on every step.

When the batch completes, `BatchResult.stats` carries the full snapshot. `LlamaModel` maps it to `RuntimeStats` for the JS side (`TPS`, `ppTPS`, `CacheTokens`, etc.).

---

## Limitations

| Feature | Batch mode |
|---------|-----------|
| Text models | Supported |
| Multimodal / vision models | Not supported (separate context type) |
| Tools | Supported (per-slot `ToolsCompactController`) |
| `tools_compact` | Supported |
| Per-prompt `cacheKey` | Supported (read sharing allowed; write sharing rejected) |
| Context shifting (`n_discarded`) | Supported, against per-slot window |
| Multiple consecutive `run()` calls | Do not batch together; submit all prompts in one `run()` call |
| `parallel < 2` | Batch input throws `InvalidArgument` before admission |

For the JS-side cancellation contract, see [README — Cancelling a batch](../README.md#cancelling-a-batch). For the cache API, see [cache-api.md](cache-api.md).
