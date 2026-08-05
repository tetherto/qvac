# Continuous Batching

`@qvac/llm-llamacpp` supports continuous batching: submitting multiple prompts in a single `run()` call so the GPU decodes tokens from all of them in one forward pass per step. This document describes the architecture and explains each component.

---

## Table of contents

- [What it does](#what-it-does)
- [Enabling it](#enabling-it)
- [JS API](#js-api)
  - [Admission, job ids and `rejectWhenBusy`](#admission-job-ids-and-rejectwhenbusy)
  - [Prefill rules (persistable vs live-only)](#prefill-rules-persistable-vs-live-only)
- [How a batch flows from JS to native slots](#how-a-batch-flows-from-js-to-native-slots)
- [Components](#components)
  - [ContinuousBatchScheduler](#continuousbatchscheduler)
  - [MultiRequestBatcher](#multirequestbatcher)
  - [SequenceDriver and TextLlmContext](#sequencedriver-and-textllmcontext)
- [Queued vs active requests](#queued-vs-active-requests)
- [Per-sequence context caps](#per-sequence-context-caps)
- [Sequence ids and streaming](#sequence-ids-and-streaming)
- [Cache per slot](#cache-per-slot)
- [KV reuse: single-prompt vs batch](#kv-reuse-single-prompt-vs-batch)
- [Cancellation semantics](#cancellation-semantics)
- [Stats and output aggregation](#stats-and-output-aggregation)
- [Runtime stats: JSON shapes per request mode](#runtime-stats-json-shapes-per-request-mode)
- [Limitations](#limitations)

---

## What it does

In the default single-prompt path, the GPU sits idle between generation steps while sampling and I/O run on the CPU. Concurrent callers each get their own sequential decode loop, so there is no GPU work sharing between them.

With continuous batching enabled, a single worker thread runs a shared decode loop. On every step it collects one token from each active sequence into one `llama_batch`, calls `llama_decode` once, then samples a token per sequence. A new sequence can join at any step as soon as a slot frees up.

Sequences reach that loop two ways, and they share it freely:

- **One batch-array call** — `run([promptA, promptB, ...])` submits several prompts as one group.
- **Separate concurrent `run()` calls** — each top-level call (single prompt or batch) is admitted as its own job by the multi-job scheduler and decodes alongside whatever else is in flight, so multiple responses can be active at once.

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

The accepted range is `1..256`. The ceiling is the engine's own sequence limit (`LLAMA_MAX_SEQ`), so anything above it is rejected when the instance is constructed — otherwise it would spawn the full thread pool and only then fail the model load, where llama.cpp swallows the real reason into a log line. `ctx_size / parallel` must also leave at least one token per slot, so a `parallel` too large for the context (or a `batch_size` smaller than `parallel`) is refused as an `InvalidArgument` naming the knobs involved.

`parallel` also sizes the native multi-job scheduler's worker pool one-to-one: that many OS threads are created eagerly at load and held for the model's lifetime, whether or not requests are in flight. This is deliberate — a serving deployment pays the whole cost upfront and is then ready to serve at full concurrency with no warm-up — but it makes a large `parallel` a real resource commitment (threads and stack address space, plus the smaller per-slot KV window) even while idle. Size it to the concurrency you actually intend to serve.

Continuous batching works on both text and multimodal (vision) models. A batch prompt may include media messages; each sequence runs its own per-slot MTMD driver that loads its media, sharing the model's mmproj weights.

---

## JS API

### Input shapes

`run()` accepts two shapes:

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

### Admission, job ids and `rejectWhenBusy`

Every `run()` call is admitted by the native multi-job scheduler before it resolves. Admission mints a native job id — the group id for a batch run — which routes that call's streamed output and terminal stats to its own response, and is what `response.cancel()` targets. The JS-facing per-prompt `ids` (`batch-N` mints or caller-supplied) are separate; see [Sequence ids and streaming](#sequence-ids-and-streaming).

Whether a call at capacity is rejected or queued is the `rejectWhenBusy` policy:

- `true` — fail fast: throw an `Error` with `code === 'RUN_BUSY'` the moment the slot pool is full, i.e. as soon as the requests occupying or waiting for a slot reach `parallel`.
- `false` — queue: the job waits in the scheduler's nearly unbounded queue and starts as slots free.

A running finetune is outside that choice: finetuning is an *exclusive* job, so
neither policy queues behind it. With `rejectWhenBusy: true` the JS gate refuses
the call; with `false` the native scheduler refuses admission outright and the
rejection surfaces as the same `RUN_BUSY` error. Either way, wait for the
finetune to finish rather than expecting a queued run to start after it.

Capacity is measured in slots rather than jobs because a batch run of N prompts is a single job that consumes up to N slots: with `parallel: 4`, one in-flight `run([p, p, p, p])` fills the pool, so a following `run(p, { rejectWhenBusy: true })` is refused even though only one job is active. At `parallel: 1` there are no scheduler slots and the job count is the measure, which keeps the sequential fail-fast behaviour unchanged. Either way this is a fast-fail hint evaluated just before submission — the native scheduler remains the authority.

The instance default follows `parallel` (`true` at `1`, `false` at `>= 2`); `opts.rejectWhenBusy` overrides it per instance and `runOptions.rejectWhenBusy` per call. A batch run derives ONE group policy from its items' `runOptions` — a batch is one native job, so items that disagree are refused with a `TypeError` before admission.

### Prefill rules (persistable vs live-only)

A prefill-only item (`runOptions.prefill: true`) earns a scheduler lane exactly when its product survives the slot teardown: `saveCacheToDisk: true` plus a `cacheKey` (*persistable* prefill). A *live-only* prefill's product is warm state in a context that concurrent jobs can never reach, so on a parallel model it is rejected with `InvalidArgument` — both as a single `run()` and per batch item. Load with `parallel: 1` for live-only cache warming. See [cache-api.md](cache-api.md).

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
  response = await this._batchHandler.run(batchInput)
        |
        v
BatchHandler.run():
  items = _unwrapItems(batchInput)
  result = await this._runJob(items)   // calls addon.runJob(items) via LlamaInterface
  jobId = result.id                    // native group id, minted at admission
  this._groups.set(jobId, { ids: result.ids, response, pendingResult: null })
  for (id of result.ids) this._chunkRoutes.set(id, jobId)
        |
        v
AddonJs.hpp: runJob() [C++ binding]
  getLlamaModel(instance)->supportsBatching() check
  parseBatchInputs(items) -> vector<Prompt>, per-item ids
  addonCpp->runJob(prompts) -> optional<JobId>   // scheduler mints the group id
  returns { accepted, ids, id }                  // returns HERE, at admission
        |
        | ---- thread boundary: the call above is done; everything below
        |      runs later on a MultiJobScheduler worker thread ----
        v
MultiJobScheduler:
  hand the job to a free pool worker, or hold it in the outer queue until one
  frees (native back-pressure; the JS rejectWhenBusy gate ran before this)
        |
        v
LlamaModel::process(input, JobId) -> processConcurrentBatch():
  arm the job's cancel action, then processPromptBatchImpl():
    validateBitnetQuantization()
    reserve saveCacheToDisk keys in inflightSaveKeys_ (InvalidArgument on clash)
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

1. The thread starts on the first `processBatch` call (`ensureWorkerStartedLocked`).
2. It waits on `workCv_` until there is something to do — queued requests, active sequences, a recorded cancel (`hasPendingCancels()`), a cancel-all, a clear request, or shutdown.
3. On wake it first applies any deferred cancel teardown (`applyDeferredTeardownLocked`), since cancels recorded from a streaming callback are only *recorded* there and applied here.
4. Then it calls `admitPendingIntoFreeSlotsLocked()` to move requests from `pending_` into free slots.
5. It runs `stepLocked()` in a loop until no active sequences remain.
6. Each step: fill batch, decode, sample, advance, drain finished sequences (`drainFinishedLocked`), refill slots.
7. A cancel-all raised while slots were active is consumed *after* the step — `stepLocked` finished the active slots, and this loop then drains `pending_` instead of admitting from it, so active and queued prompts are covered atomically. With nothing active it is drained at the top of the loop instead. A throw mid-step is unrecoverable for slot state, so the catch-all fails every live group, drains `pending_`, and clears.

**SlotState** holds, per slot:
- `driver` — a `SequenceDriver`: `TextLlmContext`, or `MtmdLlmContext` when the model loaded an mmproj (the model layer's `buildDriverFactory` picks per slot, so the scheduler stays driver-agnostic)
- `group` + `outputIndex` — back-pointer to the `BatchGroup` this slot belongs to
- `streams` — per-sequence `onToken` / `onDone` callbacks wired to the JS streaming path
- `cacheKey`, `saveCacheToDisk`, `prefillOnly`
- `tools` — `ToolsCompactController` instance (when tools support is enabled)

**BatchGroup** is shared by all sequences admitted in one `processBatch` call. It accumulates outputs and stats, and carries three fields the rest of the machinery keys off:

- `completedCount` — reaching `totalCount` marks the group done and `processBatch` returns.
- `admittedCount` — how many of the group's requests have been given a slot. While it is below `totalCount` part of the group is still queued, which is what lets a cancel settle the group without waiting for a slot (see [Cancellation semantics](#cancellation-semantics)).
- `tag` — the native job id of the `run()` call that created the group, so `cancelGroupQueued(tag)` can find it.

Completion is not the only terminal: `failGroupLocked` also settles a group, with an error instead of outputs. Its callers include a cancel of a partly-queued group, a cancel-all draining the queue, an admission failure, a decode failure, a drain-time cache-save failure, and an unexpected mid-step throw.

**Per-sequence context cap:**

```
perSeqMaxTokens_ = ctxTotalTokens / batchSize
```

This is enforced at admission — every check throws `InvalidArgument` before any state is mutated — and there are four of them, not one:

- **KV cells** — `getKvCellsUsed() + plan.totalKvTokens()` must not exceed the cap. Cells, not positions: M-RoPE media occupies more KV cells than it advances positions, so a multimodal prompt can trip this while its token count still fits.
- **A generating request** is refused at `promptSize >= cap`, where `promptSize` is `getNPast() + plan.totalPositions()` — exactly filling the window leaves no room for even one generated token.
- **A prefill-only request** is refused only at `promptSize > cap`; it never generates, so filling the window exactly is legitimate.
- **The budget check** adds `n_predict` to whichever of the two prompt measures is larger, and applies **only when `n_predict` is positive** — with `predict: -1` (no caller cap) there is no budget to check, so the request is admitted and, absent EOS or sliding, runs to the slot ceiling and stops with `sequenceLimit` instead of throwing.

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

`SequenceDriver` is the interface the scheduler calls for per-sequence decisions. `TextLlmContext` implements it, as does `MtmdLlmContext` for vision — each independently, since neither derives from the other; both also implement the older `LlmContext` interface used by the single-prompt path.

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
| `saveCache` | Before KV clear | Persists KV cache to disk if `saveCacheToDisk` is set. `drainFinishedLocked` calls `saveCacheForSlot` and only then `clearSeqKv` — the order matters, since saving after the clear would serialise an empty sequence. This is what makes a persistable prefill's product survive the slot teardown. |

Each driver carries its own `perSeqCtxCeiling_` (set to `perSeqMaxTokens_` by the scheduler, or `-1` for single-sequence). Prefill sliding and generation overflow checks use this ceiling rather than the full `llama_n_ctx()`. `n_discarded` is clamped to the per-slot window when the scheduler is constructed, before any driver sees it.

---

## Queued vs active requests

Every request goes through `pending_` (a `moodycamel::ConcurrentQueue`) — `processBatch` pushes the whole batch there unconditionally and the worker admits from it into free slots. Overflow is not a special case: when a batch has more prompts than there are free slots, the surplus simply stays queued and is admitted as generation completes.

`pending_` is lock-free for writes (push path from `processBatch`) and drained under `mutex_` (pop path from `admitPendingIntoFreeSlotsLocked`). This keeps admission off the hot decode path.

State diagram for one sequence. Note the two queues: a run waits first in the
outer `MultiJobScheduler` queue (as a whole job, if no pool worker is free),
and only once a worker picks it up do its requests reach the scheduler's
`pending_`. Which of the two a cancel finds it in decides the terminal the
caller sees — see [Cancellation semantics](#cancellation-semantics).

```
MultiJobScheduler queue      (the whole run waits here for a pool worker)
    |
    v  (a worker picks the job up; processBatch pushes its requests)
pending_ queue
    |
    v  (slot frees up)
active slot (prefill phase)
    |
    v  (prefill finishes)
active slot (generation phase)
    |
    v  (EOG / budget / cancel)
drainFinishedLocked()
    |
    v
slot freed, BatchGroup updated
```

---

## Per-sequence context caps

With `parallel = N` and `ctx_size = C`, each slot gets `C / N` tokens. This affects:

- **Admission** — a generating prompt must leave room to generate, so it is rejected once it *reaches* `C / N`; a prefill-only prompt may fill it exactly and is rejected only above it. Either way the rejection is `InvalidArgument` before any tokens are staged.
- **KV cells** — the physical cell span (`getKvCellsUsed()` plus the plan's KV tokens) is checked against `C / N` independently of the token count, because M-RoPE media consumes more cells than positions.
- **Budget check** — when `n_predict > 0`, `max(prompt_tokens, prompt_kv_cells) + n_predict` must fit within `C / N`; requests that exceed it are rejected at admission rather than truncated silently. A non-positive `n_predict` (e.g. `predict: -1`) has no budget to check and is admitted, then stops at the slot ceiling with `sequenceLimit`.
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

Caller-supplied ids must be unique across everything currently in flight, not
just within one batch: chunks are routed by JS-facing id, so reusing an id that
another live group already holds would deliver its tokens to the wrong response.
Three rules protect that, and all three reject before admission:

- `BatchHandler.run` refuses an id another live group already holds, throwing
  `Batch prompt id already in flight: <id>`. The id frees up as soon as the
  group holding it settles.
- natively, `JsBatchIds` reserves the `batch-` prefix for its own mints — a
  caller id starting with it is `InvalidArgument`, because it could otherwise
  collide with an auto-minted id in a group the JS layer cannot see.
- also natively, an id repeated *within* one batch is `InvalidArgument`
  (`Duplicate batch prompt id`), as is an empty one.

Streaming works as follows:

1. The batch `runJob` binding returns `{accepted: true, id, ids: ["batch-1","batch-2","batch-3"]}` for plain `Message[]` inputs, or caller-provided ids such as `["fruit","country"]` for `BatchPrompt` inputs. `id` is the native group id minted at admission; `ids` are the JS-facing per-prompt ids.
2. `BatchHandler` stores these as `response.ids` on the `BatchResponse`.
3. Each token from the native side delivers `{type: 'batch_output', id, output}`, where `id` is the JS-facing id rather than the native slot index; `mapAddonEvent` recognizes that `type` discriminator and normalizes it to the `BatchOutput` event name used below. The payload object is allocated once per sequence with `type`/`id` baked in and only its `output` is rewritten per token (`PayloadHandler`), which is why the routing step copies the fields out rather than handing that object to the consumer.
4. `index.js` routes this to `batchHandler.onOutput(data)`, which looks the JS-facing id up in `_chunkRoutes` to find the owning group and calls that group's `response.updateOutput({ id: data.id, chunk: data.output })`. The lookup is what keeps concurrent groups' chunks apart — there is no single "current job" to emit on.
5. The response emits an `output` event with a `BatchOutputChunk`.
6. Terminating a group takes two native events. The first is a bare array of the group's outputs in input order — there is no native event *name* for it; `mapAddonEvent` classifies any array payload as `BatchResult` — which `onResult` stashes as the group's `pendingResult`; the group's `JobEnded` then lands and `onJobEnded` maps `group.ids` onto that array to build the `{id, output}` pairs in input order, attaches the group's stats, and settles the response. Stats and outputs therefore reach the caller together.

---

## Cache per slot

Each `BatchPrompt` may carry its own `cacheKey` and `saveCacheToDisk`. The scheduler creates one driver per slot, so KV caches are isolated by slot index.

Two restrictions apply in batch mode:

1. **Read sharing is allowed.** Multiple prompts in the same batch may use the same `cacheKey` without `saveCacheToDisk`. This is a valid cache-warming pattern.
2. **Write sharing is rejected.** Two prompts with the same `cacheKey` and `saveCacheToDisk: true` would clobber each other (last writer wins, no ordering guarantee). `processPromptBatchImpl` detects this before any admission and throws `InvalidArgument`.

The write-sharing rule spans jobs, not just one batch. Each saving item reserves its `cacheKey` in a model-wide `inflightSaveKeys_` set for the length of the run, so a concurrent `run()` that tries to save a key another in-flight job already reserved is refused the same way — the error reads "already being saved by an in-flight request". This matters for cache-warming loops: give each save a distinct key, or await the previous run before reusing one. The reservation is released on every exit path, including cancellation and failure.

---

## KV reuse: single-prompt vs batch

The single-prompt path keeps one long-lived context (`TextLlmContext`, or `MtmdLlmContext` for a multimodal model) for the model's lifetime, so its KV survives across `run()` calls and a follow-up only evaluates the new tokens. The batch path is the reverse: each `submit` gets a fresh `SequenceDriver` on a recycled slot (`nPast_ = 0`, empty KV) because slots serve unrelated requests, so a cache miss costs a full prefill. That is also why a rejected `loadCache` must clear the cells it restored: otherwise they strand under the slot's `seqId`, contaminating an empty batch slot or following the single-prompt sequence for the rest of the session.

---

## Cancellation semantics

Two cancel scopes exist:

- **Targeted** — `response.cancel()` calls the native `cancelJob(id)` with the job id minted at admission (the group id for a batch run). Only that job/group's in-flight slots and queued prompts are cancelled; concurrent jobs from other `run()` calls keep decoding. A stale targeted cancel can never land on a slot's next occupant: cancels are validated against the slot's admission id.
- **Global** — `model.cancel()` cancels a snapshot of the jobs live at the moment of the call (in-flight and queued), plus any finetuning in progress. Jobs admitted after the snapshot proceed normally.

Within a cancelled job/group, the effect depends on where each prompt is when the cancel fires:

| Prompt state | What happens |
|--------------|--------------|
| In a slot (decoding) | Cancelled gracefully. The slot runs `onCancel`, flushes its UTF-8 buffer, and the batch call resolves normally with whatever was generated so far. |
| In `pending_` (never admitted) | Never runs. The associated `BatchGroup` is failed with a `Cancelled` `StatusError` as soon as the cancel is applied. |

If a batch had overflow prompts still in `pending_`, the batch call rejects rather than resolving. Callers should handle that rejection rather than expecting empty strings for the prompts that never ran — see [what the caller actually receives](#what-a-cancellation-rejection-looks-like) for the error's shape.

A single (non-batch) run resolves with an empty string rather than rejecting **once it has reached the batch scheduler** — whether it is waiting in `pending_` or already prefilling. That is the single-job contract: a caller cannot distinguish those two cases, and a cancel during prefill must not throw, so the queued case matches it rather than the batch rule above.

There is one earlier state that does reject, and it is worth knowing because it is not the scheduler's doing. Admission happens in two stages: the outer `MultiJobScheduler` queue, then the batch scheduler's slots. A run cancelled while it is still in the **outer** queue is dropped before it ever starts, and its terminal is an error, not an empty success:

| Where the run is when cancelled | Terminal |
|---|---|
| Queued in `MultiJobScheduler` (never started) | **Rejects** — the job never reached the model |
| Queued in the batch scheduler's `pending_`, or prefilling, or generating | Resolves with whatever was produced (empty string if nothing was) |

### What a cancellation rejection looks like

The caller gets an `Error` whose `message` is the native text and which has **no `code` property** (`QvacResponse.failed` wraps the incoming string, so `err.message` is reliable — `err.code` is simply absent). The batch scheduler does build a structured `Cancelled` `StatusError`, but a job's asynchronous terminal travels through addon-cpp's `Output::Error`, which is constructed from `what()` alone — the descriptive text — so the code is dropped before JS sees it. The outer-queue drop does not build a structured error at all: it publishes `std::runtime_error("Job cancelled")` (the scheduler-destroyed path appends a reason). Only *synchronous* binding throws — admission-time validation — carry a code, because that path goes through `js_throw_error(env, codeString(), what())`.

So treat a cancelled single run as "either an empty result or a rejection whose text says it was cancelled" unless you know the job had already started, and do not branch on `err.code` for it. (`RUN_BUSY` is different: that error is constructed in JS, so it does carry a code.) Delivering the code on the async path needs an addon-cpp change — `Output::Error` would have to carry it — so it is a framework-level follow-up, not a knob in this package.

Natively the two halves of a targeted cancel are separate, because a queued request has no slot to stop. Slot teardown is keyed by admission id, so it can only reach requests that were admitted. For the rest, the job's cancel action is armed *before* submission and calls `cancelGroupQueued(tag)`, which settles the group the moment the cancel is applied — and critically without waiting for a slot. That matters when an unrelated job holds the whole pool: the group's queued requests cannot be admitted until that foreign work finishes, so a cancel that relied on admission would resolve only then, hanging the caller's `cancel()` promise for the length of someone else's generation.

`cancelGroupQueued` deliberately does nothing once every request of the group holds a slot: teardown covers the whole group then, and that path keeps the graceful partial-output cancel above. It also preserves each shape's documented terminal — a lone request is settled done-without-error (empty output), only a multi-prompt group is failed with `Cancelled` — so settling early changes *when* a cancel resolves, never *what* the caller sees. The stale `pending_` entries are not removed from the queue (it is FIFO across groups with no selective removal); the group is marked done, and `admitPendingIntoFreeSlotsLocked` discards them when it next dequeues, so none of them can run.

The global path instead sets `cancelRequested_` atomically via `requestCancelAll()`. The worker loop detects the flag after each step: it drains `pending_` (failing pending groups) before the flag is cleared, so active and queued prompts are both covered.

Both targeted forms honour the same threading rule as `cancel(seqId, admissionId)`: issued from the scheduler's own streaming callbacks (which run on the worker thread with the scheduler mutex held) they only record the cancel, which the worker applies at its next reconciliation; issued from any other thread they are applied under the lock, or synchronously when no worker is running.

---

## Stats and output aggregation

Stats are collected in two places and merged at the end:

- **Per-step** — `RuntimeStatsSnapshot::recordDecodeStep` accumulates prefill vs decode tokens and their wall-clock duration. A pure step lands wholly in its own bucket. A **mixed** step — a newcomer's prompt tokens riding along with other sequences' generation, which is the normal case under continuous batching — is split **proportionally by token count**: 1 prefill token beside 3 decode tokens sends a quarter of the step's elapsed time to the prefill bucket and three quarters to the decode bucket, with the tokens counted in their own buckets. That split is what keeps `ppTPS` and batch `TTFT` (which reads `prefillTimeMs()`) honest; charging a mixed step wholly to decode would silently drop the piggybacked prompt tokens and their time, under-reporting both. Compactor replay decode is excluded because `onGenerationFinished` runs outside the timed block, not by any special case here.
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
JSON below — reaching the caller as `response.stats` only when the instance was
constructed with `opts.stats` enabled; otherwise the event still fires and the
payload is dropped. The keys are the same across modes with two documented
exceptions:

- `stopReason` — present only when it can be attributed to a single request:
  always on the single-prompt path, and for a concurrent job whose requests
  agree (a one-prompt job trivially does). A group whose prompts stopped for
  different reasons drops it.
- the `visionEncode*` counters — the single-prompt path always includes them,
  a text model included (its base implementation returns zero); every batch or
  concurrent job omits them deliberately, because concurrent prompts share one
  per-context accumulator and a per-job value would be misattributed. So they
  mark the *mode*, not the model: non-zero means a multimodal single-prompt run.

What otherwise changes per mode is where the values come from:

Every job is tagged — the model is always driven through the multi-job
scheduler, so even at `parallel: 1` admission mints a job id. What differs is
whether a per-job stats source exists for that id:

- Generic snapshot (`runtimeStats()`): whole-model aggregate over everything
  in flight, including `avgConcurrentSeq`. This is what a job's `JobEnded`
  carries when nothing recorded per-job figures for it — the single-prompt
  path (`parallel: 1`) never does.

  The aggregate covers an **epoch**, the unit the sections below refer to: it
  starts when a job is submitted to a fully idle scheduler (`processBatch`
  resets the snapshot only when `pending_` is empty and no slot is active) and
  runs until the scheduler drains again. Every job that overlaps that window
  contributes to the same aggregate, which is why a job's own figures can
  differ from it while the sum over the epoch's jobs matches.
- Per-job override (the job ran through the batch engine): the job's terminal
  snapshot starts from that same aggregate, then `TTFT`, `TPS`,
  `generatedTokens` and `promptTokens` are overridden with the job's OWN
  observed figures. All other keys (`ppTPS`, `CacheTokens`, `contextSlides`,
  `thinkingBlockDiscards`, `avgConcurrentSeq`, `backendDevice`) stay
  model-level.

Four variants:

1. `parallel = 1` single → tagged, but the single-prompt path records no
   per-job figures, so the payload is the generic snapshot
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
  "stopReason": "eos",
  "visionEncodeMs": 0,
  "visionEncodeTiles": 0,
  "avgConcurrentSeq": 1.0,
  "backendDevice": "gpu"
}
```

(A text model on this path still reports the two `visionEncode*` keys as zero;
a multimodal one fills them in.)

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
  "stopReason": "eos",
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
- `stopReason` — kept only if every prompt of the group stopped for the same
  reason; otherwise the key is absent rather than guessed. The sample below
  shows the mixed case (A hit EOS, B hit its prediction limit).

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

A single `run(batch)` call with nothing else in flight is still tagged with
its own native group id, registered in `BatchHandler._groups` like any other
job; it just has no concurrent traffic to diverge from, so its own figures
happen to equal the generic aggregate snapshot.

### 4. One batched run of exactly `parallel` prompts (full width)

Same engine code as the legacy bundled batch — a batch run is admitted
through the same `processPromptBatchImpl` machinery down to native
`llama_decode` / `common_sampler_*` regardless of size, and a full-width
group occupies every slot so nothing else can interleave once it is admitted.
Submitted to an idle model, the group IS the epoch: its summed counts equal
the generic aggregate exactly, and its averaged `TTFT`/`TPS` are the
per-request view of the same run. Submitted while peers are still decoding, it
joins their epoch instead — its prompts trickle in as slots free, and the
aggregate covers that other traffic too, so only the per-job figures stay
its own.

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
| Concurrent top-level `run()` calls | Supported — each call is its own scheduler job and decodes alongside the others (see [Admission](#admission-job-ids-and-rejectwhenbusy)) |
| Live-only prefill (`prefill: true` without `saveCacheToDisk` + `cacheKey`) | Rejected with `InvalidArgument`; persistable prefill is supported (see [Prefill rules](#prefill-rules-persistable-vs-live-only)) |
| `parallel < 2` | Batch input throws `InvalidArgument` before admission |

For the JS-side cancellation contract, see [README — Cancelling a batch](../README.md#cancelling-a-batch). For the cache API, see [cache-api.md](cache-api.md).
