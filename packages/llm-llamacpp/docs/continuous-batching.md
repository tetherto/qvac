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
- [Runtime stats: JSON shapes per request mode](#runtime-stats-json-shapes-per-request-mode)
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

Continuous batching works on both text and multimodal (vision) models. A batch prompt may include media messages; each sequence runs its own per-slot MTMD driver that loads its media, sharing the model's mmproj weights.

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

`RuntimeStats` gains `avgConcurrentSeq`: the mean number of sequences decoded together, measured across all `llama_decode` steps. It describes the shared backend, not any one request — a request contributes at most 1 to it; the rest is overlapping traffic from other callers, capped by the `parallel` configuration. `1.0` means the model was effectively yours alone; `~N` means each request's tokens shared compute with N-1 others (so a request's observed `TPS` is roughly the aggregate rate divided by N). Even for a single request it distinguishes "slow model" from "busy backend".

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

## KV reuse: single-prompt vs batch

The single-prompt path keeps one `TextLlmContext` for the model's lifetime, so its KV survives across `run()` calls and a follow-up only evaluates the new tokens. The batch path is the reverse: each `submit` gets a fresh `SequenceDriver` on a recycled slot (`nPast_ = 0`, empty KV) because slots serve unrelated requests, so a cache miss costs a full prefill. That is also why a rejected `loadCache` must clear the cells it restored: otherwise they strand under the slot's `seqId`, contaminating an empty batch slot or following the single-prompt sequence for the rest of the session.

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

Additionally, `BatchResult.requestStats` carries each request's observed end-to-end figures (`ObservedRequestStats`, computed at drain from per-request wall-clock stamps), which power the per-job stats below.

---

## Runtime stats: JSON shapes per request mode

Every completed job emits one `JobEnded` event whose payload is the stats
JSON below. The keys are ALWAYS the same; what changes per mode is where the
values come from:

- Untagged / generic snapshot (`runtimeStats()`, no job id): whole-model
  aggregate over everything in flight — the current default, including
  `avgConcurrentSeq`.
- Tagged job (multi-job scheduler, `parallel >= 2`): the job's terminal
  snapshot starts from that same aggregate, then `TTFT`, `TPS`,
  `generatedTokens` and `promptTokens` are overridden with the job's OWN
  observed figures. All other keys (`ppTPS`, `CacheTokens`, `contextSlides`,
  `thinkingBlockDiscards`, `avgConcurrentSeq`, `backendDevice`) stay
  model-level.

Four variants for tagged job:

1. `parallel = 1` single → generic snapshot only, no per-job entry
2. multiple singles → per-job override (same keys), aggregate == sum of jobs
3. multiple batched groups (micro-batch < parallel) → per-group avg-of-active / summed counts, groups isolated
4. full-width batch (== parallel) → same legacy engine path; group counts equal the aggregate exactly, `avgConcurrentSeq` > 1


How the per-job figures are obtained (wall clock, measured by the batch
engine per request):

- `TTFT` — from handing the request to the engine until its first sampled
  token (queue wait + prefill included).
- `TPS` — the request's own first→last token window: `(N-1) tokens / window`.
  Under load this is lower than the aggregate `TPS`: it is what this caller
  experienced while sharing the GPU, not isolated compute speed (which is
  unmeasurable under fused batch decode).
- `generatedTokens` / `promptTokens` — the request's own token counts.

### 1. Single request, no batching (`parallel = 1`)

Single-prompt path (from `llama_perf_context`). One job owns the model, so
the generic snapshot's figures already ARE that request's figures — there is
no separate per-job source, nothing is overridden.

```json
{
  "TTFT": 143.2,
  "TPS": 34.7,
  "ppTPS": 512.9,
  "CacheTokens": 210,
  "generatedTokens": 180,
  "promptTokens": 30,
  "contextSlides": 0,
  "thinkingBlockDiscards": 0,
  "avgConcurrentSeq": 1.0,
  "backendDevice": "gpu"
}
```

### 2. Multiple async single requests that get batched (`parallel >= 2`)

Each request is its own tagged job; the scheduler batches whatever overlaps.
Every job gets its own `JobEnded`, routed to its own response sink by job id,
with `TTFT` / `TPS` / `generatedTokens` / `promptTokens` overridden by that
job's observed figures:

```json
{
  "TTFT": 121.7,
  "TPS": 33.2,
  "ppTPS": 1450.0,
  "CacheTokens": 840,
  "generatedTokens": 174,
  "promptTokens": 28,
  "contextSlides": 0,
  "thinkingBlockDiscards": 0,
  "avgConcurrentSeq": 2.9,
  "backendDevice": "gpu"
}
```

Here `TPS` (33.2) is this job's observed rate while `avgConcurrentSeq` (2.9)
tells you the model was shared; the aggregate decode rate is roughly
`TPS * avgConcurrentSeq`. `sum(generatedTokens)` over an epoch's jobs equals
the generic snapshot's `generatedTokens`.

### 3. Multiple async batched runs (`parallel >= 2`, micro-batch < parallel)

A "group" is the set of prompts of ONE `run(batchInput)` call: one JS call,
one native job id, one `QvacResponse`, one terminal stats payload. With
`parallel = 4` and two callers each batching 2 prompts:

```
caller X: run([promptA, promptB])   -> job id 11, group {A, B}
caller Y: run([promptC, promptD])   -> job id 12, group {C, D}
```

Inside the engine all 4 sequences may share the same fused decode steps —
the scheduler's batch mixes everyone. The group is the admission unit, not
the decode batch: at drain each prompt gets its own observed figures, then
the group collapses its OWN prompts into one figure set:

- `TTFT`, `TPS` — averaged over the group's prompts that produced them
  ("avg of active ones": a prompt cancelled before its first token does not
  drag the averages down). Averaged, not summed, because the group's prompts
  run simultaneously — summing rates would double-count wall-clock. The
  average answers "what did one of my prompts typically experience".
- `generatedTokens`, `promptTokens` — summed over the group (tokens are
  additive).

So `JobEnded(11)` reports only {A, B}; `JobEnded(12)` only {C, D} — two
concurrent groups never read each other's token counts, which the old
epoch-global snapshot could not guarantee.

Group X's payload (`generatedTokens` = A + B; `avgConcurrentSeq` = 3.4 says
the model actually interleaved ~3-4 sequences, i.e. Y's prompts ran too):

```json
{
  "TTFT": 110.3,
  "TPS": 31.8,
  "ppTPS": 1450.0,
  "CacheTokens": 840,
  "generatedTokens": 355,
  "promptTokens": 61,
  "contextSlides": 0,
  "thinkingBlockDiscards": 0,
  "avgConcurrentSeq": 3.4,
  "backendDevice": "gpu"
}
```

A single `run(batch)` call with nothing else in flight (legacy bundled batch,
untagged) keeps the generic aggregate snapshot unchanged.

### 4. One batched run of exactly `parallel` prompts (full width)

Same engine code as the legacy bundled batch — a batch run is admitted
through the same `processPromptBatch` machinery down to native
`llama_decode` / `common_sampler_*` regardless of size, and a full-width
group occupies every slot so nothing else can interleave. The group IS the
epoch: its summed counts equal the generic aggregate exactly, and its
averaged `TTFT`/`TPS` are the per-request view of the same run.

### avgConcurrentSeq

Plainly: this key describes the BACKEND, not your request. It answers "how
busy was the shared engine while my request ran?" — the mean number of
sequences the model decoded together, averaged over every `llama_decode`
step of the epoch (`concurrentSeqSum_ / decodeStepCount_`).

Your request contributes at most 1 to it (a batched group, up to its size);
the rest is other traffic sharing the same backend plus how the backend was
configured (`parallel` caps it). That is why it is never overridden per job:
there is no "my avgConcurrentSeq".

Reading it, even for a single request:

- `1.0` — the model was effectively yours alone; your observed `TPS` is the
  backend's full speed.
- `~N` — the backend interleaved ~N sequences per step; your tokens shared
  compute with N-1 others. Expect your observed `TPS` to be roughly the
  aggregate rate divided by N (`observed TPS * avgConcurrentSeq ~= aggregate
  TPS`).

So a "slow" per-request `TPS` next to a high `avgConcurrentSeq` means a busy
backend, not a slow model. Per-step accounting: see
[Stats and output aggregation](#stats-and-output-aggregation).

---

## Limitations

| Feature | Batch mode |
|---------|-----------|
| Text models | Supported |
| Multimodal / vision models | Supported (per-slot MTMD driver; batch prompts may include media messages) |
| Tools | Supported (per-slot `ToolsCompactController`) |
| `tools_compact` | Supported |
| Per-prompt `cacheKey` | Supported (read sharing allowed; write sharing rejected) |
| Context shifting (`n_discarded`) | Supported, against per-slot window |
| Multiple consecutive `run()` calls | Do not batch together; submit all prompts in one `run()` call |
| `parallel < 2` | Batch input throws `InvalidArgument` before admission |

For the JS-side cancellation contract, see [README — Cancelling a batch](../README.md#cancelling-a-batch). For the cache API, see [cache-api.md](cache-api.md).
