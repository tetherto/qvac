# Finetuning Guide

This document describes how to use the LoRA (Low-Rank Adaptation) finetuning feature in `@qvac/llm-llamacpp`. It covers the JavaScript API, dataset formats, parameters, and usage examples.

**Backend:** Finetuning uses the `fabric-llm-finetune` branch of [tetherto/qvac-fabric-llm.cpp](https://github.com/tetherto/qvac-fabric-llm.cpp) (a llama.cpp fork), pulled in via vcpkg.

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [JavaScript API](#javascript-api)
- [Finetuning Parameters](#finetuning-parameters)
- [Implementation Notes](#implementation-notes)
  - [Fresh run vs resume](#fresh-run-vs-resume)
  - [UML: finetune and cancel flow (JS → C++)](#uml-finetune-and-cancel-flow-js--c)
  - [C++ Backend Overview](#cpp-backend-overview)
- [Dataset Format](#dataset-format)
- [Examples](#examples)
- [Checkpoints and Output](#checkpoints-and-output)
- [Requirements and Limitations](#requirements-and-limitations)

---

## Overview

The library supports **LoRA finetuning** of GGUF models. LoRA trains small adapter weights that can be applied on top of a base model, making finetuning memory-efficient and fast. The finetuned adapter is saved as a `.gguf` file and can be loaded at inference time via the `lora` config option.

**Key capabilities:**
- LoRA finetuning with configurable target modules
- Chat-format (SFT) or causal (next-token) training
- Validation: none, percentage of training data, or separate eval dataset; `val_loss` logged each epoch when enabled
- Pause and resume from checkpoints
- Periodic checkpoint saving during training
- Run inference while finetuning is paused (see [examples/simple-lora-finetune-pause-inference-resume.js](../examples/simple-lora-finetune-pause-inference-resume.js))

---

## How It Works

### Architecture

Finetune and inference use the same job queue (JobRunner): both submit a job via `runJob()` and a single processing thread runs one job at a time (either inference or finetune). In JS, both `run()` and `finetune()` go through the same `exclusiveRunQueue` (`_run`) and share a `createJobHandler`-managed `_hasActiveResponse` flag; JobRunner enforces serialization on the native side.

1. **Model loading**: Load a base GGUF model (e.g., Qwen3-0.6B-Q8_0.gguf) with `model.load()`.
2. **Dataset preparation**: Training data is read from JSONL (chat format) or plain text files. Validation uses either a fraction of that data (when `validation.type` is `'split'`), a separate eval file (`'dataset'`), or none (`'none'`).
3. **LoRA adapter**: A LoRA adapter is initialized and attached to the model. Only the specified modules (e.g., attention, FFN) are trained.
4. **Training loop**: The optimizer runs for the configured number of epochs. Per-iteration progress is emitted as stats events on the finetune handle. When validation is enabled, `val_loss` is computed each epoch.
5. **Output**: The trained LoRA adapter is saved to `outputParametersDir` (e.g., `./finetuned-model-direct/trained-lora-adapter.gguf`).

### Training Modes

| Mode | `assistantLossOnly` | Dataset Format | Use Case |
|------|---------------------|----------------|----------|
| **SFT (Supervised Fine-Tuning)** | `true` | JSONL with `messages` | Chat/instruction tuning |
| **Causal** | `false` | Plain text | Next-token prediction |

### LoRA Target Modules

You can specify which model layers to adapt via `loraModules`. Available modules:

- `attn_q`, `attn_k`, `attn_v`, `attn_o` — attention layers
- `ffn_gate`, `ffn_up`, `ffn_down` — feed-forward layers
- `output` — output projection
- `all` — all applicable modules

Default (when `loraModules` is empty): attention Q, K, V, O only.

---

## JavaScript API

### `finetune(finetuningOptions)`

Starts or resumes finetuning. The model **must** already be loaded (call `load()` first); `finetune()` does not auto-load. `finetuningOptions` is required on every call — there is no in-process "stored params" state. Finetuning runs exclusively (no concurrent inference). Returns a handle immediately (like `run()`); use `handle.await()` to wait for completion. If a pause checkpoint exists in `checkpointSaveDir`, training resumes from it automatically; otherwise a fresh run starts.

```js
await model.load()
const handle = await model.finetune(finetuneOptions)
handle.on('stats', stats => {
  console.log(`epoch=${stats.current_epoch + 1} step=${stats.global_steps} loss=${stats.loss?.toFixed(4)} acc=${(stats.accuracy * 100)?.toFixed(1)}%`)
})
const result = await handle.await()

// After pause: call finetune() again with the same params; backend resumes if checkpoint exists
const resumeHandle = await model.finetune(finetuneOptions)
const resumeResult = await resumeHandle.await()
```

- **Parameters**
  - `finetuningOptions` — Object with [finetuning parameters](#finetuning-parameters). **Always required**, including on resume — pass the same params object that was used for the original run. The backend resumes from a pause checkpoint if one exists in `checkpointSaveDir`. **Resume contract:** call `finetune(finetuningOptions)` only after you have **awaited** `pause()`. There is no status API; await the previous command to know something is done.
- **Returns** — `Promise<FinetuneHandle>`. The handle has `await()` — returns `Promise<{ op: 'finetune', status: 'COMPLETED' | 'PAUSED', stats?: object }>` when training completes or pauses. `stats` may include terminal metrics such as `train_loss`, `val_loss`, `learning_rate`, `global_steps`, and `epochs_completed`. Runtime failures reject `await()` (same failure path as inference) instead of resolving with an error status.
- **Progress events** — if `opts.stats` is enabled, finetuning emits `stats` events on the handle with per-iteration metrics (`loss`, `accuracy`, `global_steps`, `current_epoch`, `current_batch`, `total_batches`). `global_steps` is the canonical monotonic step counter; `current_batch`/`total_batches` reflect backend ubatch indexing and may have non-sequential jumps depending on batch/microbatch configuration.

**Related example:** [examples/simple-lora-finetune.js](../examples/simple-lora-finetune.js) — Run with: `bare examples/simple-lora-finetune.js`

### Pause for resume: `pause()`

Pauses finetuning and keeps pause checkpoints so the next `finetune()` call can resume.

- **Behavior** — Calls addon cancel on the finetune path and waits until the pause path completes.
- **Resolution** — The Promise resolves when the backend pause path has completed.

```js
await model.pause()
```

**Returns** — `Promise<void>`. Once resolved, you can call `finetune(finetuningOptions)` again — pass the same params object — and the backend will resume from the pause checkpoint in `checkpointSaveDir`.

### Stop and start fresh: `cancel()`

Cancels finetuning and removes pause checkpoints from `checkpointSaveDir` so the next `finetune()` starts fresh.

```js
await model.cancel()
```

**Returns** — `Promise<void>`. Calls addon cancel and then removes `pause_checkpoint_step_*` directories (if configured).

**Related example:** [examples/simple-lora-finetune-pause-resume.js](../examples/simple-lora-finetune-pause-resume.js) — Run with: `bare examples/simple-lora-finetune-pause-resume.js`

---

## Finetuning Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `trainDatasetDir` | string | Yes | — | Path to training dataset file (e.g. `.jsonl` for SFT, `.txt` for causal) |
| `validation` | object | Yes | — | How to run validation. When `type` is `'dataset'`, include `path` with the eval dataset file path. See [Validation](#validation) below. |
| `outputParametersDir` | string | Yes | — | Directory (or file path) for the final LoRA adapter |
| `numberOfEpochs` | number | No | 1 | Number of training epochs |
| `learningRate` | number | No | 1e-4 | Initial learning rate |
| `contextLength` | number | No | 128 | Training sequence length |
| `batchSize` | number | No | 128 | Sets the backend `n_batch` (number of tokens processed per batch). Must be >= `microBatchSize` and divisible by it when both are set. |
| `microBatchSize` | number | No | 128 | Sets the backend `n_ubatch` (micro-batch size). Controls how many tokens are processed per optimizer step. Adjusted to gcd(datasetSampleCount, requested) if needed. Must be <= `batchSize` when both are set. |
| `assistantLossOnly` | boolean | No | false | Use SFT (chat) mode; if false, causal mode |
| `loraModules` | string | No | attn_q,k,v,o | Comma-separated target modules |
| `loraRank` | number | No | 8 | LoRA rank |
| `loraAlpha` | number | No | 16.0 | LoRA alpha (scaling) |
| `loraInitStd` | number | No | 0.02 | LoRA init std |
| `loraSeed` | number | No | 42 | Seed for LoRA weight initialization (0 = non-deterministic) |
| `checkpointSaveDir` | string | No | `./checkpoints` | Directory for checkpoints |
| `checkpointSaveSteps` | number | No | 0 | Save checkpoint every N steps (0 = only pause) |
| `chatTemplatePath` | string | No | `""` | Path to chat template (for SFT) |
| `lrScheduler` | string | No | `"cosine"` | `"constant"`, `"cosine"`, or `"linear"` |
| `lrMin` | number | No | 0 | Minimum learning rate (for cosine/linear) |
| `warmupRatio` | number | No | 0.1 | Warmup ratio (0–1). Requires `warmupRatioSet: true` to take effect. |
| `warmupRatioSet` | boolean | No | false | When true, warmup steps = `warmupRatio × totalSteps`. |
| `warmupStepsSet` | boolean | No | false | When true, use `warmupSteps` directly instead of ratio. |
| `warmupSteps` | number | No | 0 | Explicit warmup steps (used when `warmupStepsSet: true`). |
| `weightDecay` | number | No | 0.01 | Weight decay |

### Validation

You **must** provide a `validation` object. It is required and there is no default.
Top-level `evalDatasetPath` is not accepted by the JS API.

**Shape:**

```js
validation: {
  type: 'none' | 'split' | 'dataset',
  fraction?: number,   // only when type === 'split'; default 0.05
  path?: string        // required when type === 'dataset'; path to eval dataset file
}
```

| `type` | Behavior |
|--------|----------|
| **`'none'`** | No validation. All data is used for training; no `val_loss` is computed. |
| **`'split'`** | Reserve a fraction of the training data for validation (holdout). Use `fraction` (0–1); default `0.05` (5%). Logs `val_loss` each epoch. |
| **`'dataset'`** | Use a separate eval file for validation. Set `validation.path` to the eval dataset file path (must differ from `trainDatasetDir`). Same format as train. The eval dataset is loaded and validated after each epoch; logs `val_loss`. |

**Validation contract enforced by `normalizeFinetuneParams`:**

- `validation` must be an object with `type`.
- `validation.type` must be one of `'none' | 'split' | 'dataset'`.
- If `validation.type` is `'dataset'`, `validation.path` must be a non-empty string.
- `validation.path` must differ from `trainDatasetDir`.
- Passing top-level `evalDatasetPath` throws.

**Examples:**

```js
// No validation
validation: { type: 'none' }

// 5% of train data for validation (default)
validation: { type: 'split' }

// 10% of train data for validation
validation: { type: 'split', fraction: 0.1 }

// Separate eval file for validation
validation: { type: 'dataset', path: './eval.jsonl' }
```

---

## Implementation Notes

### Atomic Flags and Event-Driven Flow

The finetuning and pause/resume flow uses **wait conditions** and **events** only. There is **no status API**: to know something is completed, **await the previous command** (e.g. `handle.await()`, `pause()`, `cancel()`). No polling or status checks in the binding.

| Flow | Mechanism |
|------|------------|
| **Completion** | `handle.await()` resolves on finetune terminal payloads (`status: COMPLETED` or `PAUSED`) and rejects on runtime errors (`Error` event path). |
| **Training started** | Event `FinetuningStarted` emitted when the first batch is processed. |
| **Request pause** | Calling `pause()` during finetuning invokes `requestPause()` (sets `pauseRequested` and `llama_opt_request_stop()`). The binding runs `waitUntilFinetuningPauseComplete()` on a background task, blocking on a condition variable until the JobRunner thread (running the finetune job) signals pause done (checkpoint saved or save failed); the Promise resolves when that wait returns. There is a 5-minute timeout if the checkpoint save never completes. |
| **Resume** | When you call `finetune(params)` again after `pause()`, the JS calls `addon.finetune(params)`. The C++ `finetune()` checks for a pause checkpoint in `params.checkpointSaveDir`; if one exists, it calls `clearPauseRequest()` and resumes from that checkpoint. **Contract:** call `finetune(params)` only after you have **awaited** `pause()`. JS does not retain stored params — you must pass the same params object on resume. No status check in the binding. |

**Wait conditions in C++:** `pauseDoneCv` / `pauseWaitDone` signal when pause has completed. `waitUntilFinetuningPauseComplete()` uses a 5-minute timeout so the caller is not blocked indefinitely if the JobRunner thread never signals. The C++ decides “resume from checkpoint” solely by checking the filesystem: at the start of `finetune(params, logCallback)` it calls `pauseCheckpointExists(params.checkpointSaveDir)`. If true, it calls `clearPauseRequest()` and then loads the latest `pause_checkpoint_step_*` directory and metadata to resume; otherwise it starts fresh. Atomic flags in `TrainingCheckpointState`: `pauseRequested`, `shouldExit`, `pauseCheckpointSaved`, `pauseWaitDone`; the pointer `currentCheckpointState_` in `LlamaModel` is also atomic. Together with `pauseDoneMutex` and `pauseDoneCv`, these provide thread-safe coordination between the thread waiting in `waitUntilFinetuningPauseComplete()` (from `pause()`) and the JobRunner thread running the finetune job (which checks flags, saves the checkpoint, and signals completion).

### How the JS API Calls the Backend

| API | Backend behavior |
|-----|------------------|
| **`finetune(opts)`** | Normalizes opts (required `validation` object → `validationSplit`, `useEvalDatasetForValidation`), then calls `addon.finetune(params)`. `opts` is required on every call — JS does not retain stored params. C++ auto-detects resume when a pause checkpoint exists in `checkpointSaveDir`. Returns a handle; `handle.await()` resolves with terminal payload `status: COMPLETED | PAUSED`, and rejects on runtime errors. |
| **`pause()`** | During finetuning, calls C++ pause flow (`requestPause()` + `waitUntilFinetuningPauseComplete()`), which writes a pause checkpoint and resolves when the pause path completes. |
| **`cancel()`** | Calls addon cancel, then removes local `pause_checkpoint_step_*` directories from `checkpointSaveDir` so the next `finetune()` starts fresh. |

### Fresh run vs resume

The choice between a **fresh run** and **resume from pause** is made in C++ inside `LlamaModel::finetune()`. The JS API exposes a single `finetune(opts)`; resume is determined by the backend from the presence of a pause checkpoint on disk. There is no in-process "we were paused" or "stored params" state in JS: if you restart the script and call `finetune(opts)` with the same `checkpointSaveDir`, the backend will resume from any existing pause checkpoint in that directory.

- **How it’s decided:** After validating params, C++ sets `checkpointDir = params.checkpointSaveDir` (or `"./checkpoints"`) and calls `pauseCheckpointExists(checkpointDir)`. If that returns true, it calls `clearPauseRequest()` and then uses `findLatestPauseCheckpoint()` and `parseCheckpointMetadata()` to set `resumingFromPause` and load resume metadata; the rest of the function branches on `resumingFromPause` (load adapter from checkpoint vs init from params, restore step/epoch, etc.).
- **Params on resume:** The `params` you pass on the resume call are used for dataset paths, `numberOfEpochs`, learning rate, scheduler, checkpoint dir, and so on — pass the same object you used for the original run. The checkpoint supplies the **position** (epoch, globalStep, currentStep, resumeEpoch, resumeBatch, pausedDuringValidation) and saved LoRA layout (targetModules, loraRank, loraAlpha); `loraInitStd` comes from `params`.

### UML: finetune and pause flow (JS → C++)

The following sequence diagrams show how `finetune()` and `pause()` call from JavaScript into the native addon and back.

#### finetune() flow

```mermaid
sequenceDiagram
    participant User
    participant LlamaModel as index.js LlmLlamacpp
    participant Addon as addon.js LlamaInterface
    participant Binding as binding.cpp (BARE)
    participant AddonJs as AddonJs.hpp
    participant AddonCpp as AddonCpp
    participant JobRunner as JobRunner
    participant LlamaModelCpp as LlamaModel.cpp
    participant Helpers as LlamaFinetuningHelpers
    participant Queue as outputQueue

    User->>LlamaModel: finetune(opts) (opts always required, including on resume)
    LlamaModel->>LlamaModel: enqueue via exclusiveRunQueue and normalize opts (validation object required, dataset needs validation.path, emits flat validationSplit/useEvalDatasetForValidation/evalDatasetPath)
    LlamaModel->>Addon: finetune(params)

    Addon->>Binding: _binding.finetune(handle, params)
    Binding->>AddonJs: finetune(env, info)
    AddonJs->>AddonJs: JsInterface.getInstance, getLlamaModel(instance), tryGetObject for params, build Prompt with finetuningParams and outputCallback
    AddonJs->>AddonCpp: runJob(any(prompt))
    AddonCpp->>JobRunner: runJob(any)
    JobRunner->>LlamaModelCpp: process(job) → branch on finetuningParams → finetune(params, outputCallback)
    AddonJs-->>Binding: return
    Binding-->>Addon: return
    Addon-->>LlamaModel: return
    LlamaModel-->>User: handle { await() }

    Note over JobRunner,LlamaModelCpp: Finetune runs in JobRunner thread (same as inference)
    LlamaModelCpp->>LlamaModelCpp: pauseCheckpointExists(checkpointDir)? clearPauseRequest() — resume or fresh path
    LlamaModelCpp->>Helpers: prepareTrainingDataset, training loop
    loop each batch / completion
        Helpers->>LlamaModelCpp: logCallback(msg) for progress
        LlamaModelCpp->>Queue: enqueueLog(msg) → queueResult(any(message))
    end
    LlamaModelCpp->>Queue: queueJobEnded({ op:'finetune', status, stats? })
    Queue->>LlamaModel: _addonOutputCallback(...) -> _outputCallback(..., 'JobEnded', 'OnlyOneJob', data)
    LlamaModel->>LlamaModel: _handleAddonOutputEvent routes JobEnded to active QvacResponse via createJobHandler
    LlamaModel->>User: handle.await() resolves with { op:'finetune', status:'COMPLETED'|'PAUSED', stats? } (errors reject)
```

#### pause() flow

```mermaid
sequenceDiagram
    participant User
    participant LlamaModel as index.js LlmLlamacpp
    participant Addon as addon.js LlamaInterface
    participant Binding as binding.cpp (BARE)
    participant AddonJs as AddonJs.hpp
    participant LlamaModelCpp as LlamaModel.cpp
    participant Helpers as LlamaFinetuningHelpers
    participant Queue as outputQueue

    User->>LlamaModel: pause()
    LlamaModel->>Addon: addon.cancel()
    Addon->>Binding: _binding.cancel(handle)
    Binding->>AddonJs: qvac_lib_inference_addon_llama::cancel(env, info)

    AddonJs->>AddonJs: JsInterface.getInstance, getLlamaModel(instance), isFinetuneRunning check
    AddonJs->>LlamaModelCpp: llamaModel->requestPause()
    LlamaModelCpp->>LlamaModelCpp: currentCheckpointState_->pauseRequested.store(true)
    LlamaModelCpp->>LlamaModelCpp: llama_opt_request_stop(ctx)

    Note over AddonJs: Always returns Promise (JsAsyncTask::run). If requestPause() was false, runs empty task so Promise resolves immediately.

    AddonJs->>AddonJs: JsAsyncTask::run(env, [llamaModel]() { ... } or []() {})
    AddonJs->>LlamaModelCpp: llamaModel->waitUntilFinetuningPauseComplete() (when didPause)
    Note over LlamaModelCpp: waits on pauseDoneCv until pause done

    par JobRunner thread (finetune job) reacts to stop when finetuning was running
        LlamaModelCpp->>Helpers: training loop sees pauseRequested / stop
        Helpers->>Helpers: save checkpoint, mark pause done, notify pause waiter
        Helpers->>Helpers: pauseWaitDone=true, pauseDoneCv.notify_all()
        LlamaModelCpp->>Queue: queueJobEnded({ op:'finetune', status:'PAUSED', stats? })
        Queue->>LlamaModel: _addonOutputCallback(...) -> _outputCallback(..., 'JobEnded', ...)
        LlamaModel->>LlamaModel: QvacResponse.ended(data)
    and waitUntilFinetuningPauseComplete unblocks
        LlamaModelCpp-->>AddonJs: waitUntilFinetuningPauseComplete() returns
    end

    AddonJs-->>Binding: JsAsyncTask resolves
    Binding-->>Addon: Promise resolves
    Addon-->>LlamaModel: pause() resolves
    LlamaModel-->>User: pause() resolves
```

#### Component overview (JS ↔ C++)

| Layer | Component | Role |
|-------|-----------|------|
| JS | `index.js` → `LlmLlamacpp` | Public API: `finetune()`, `pause()`, `cancel()`. `pause()` requests a resumable stop; `cancel()` stops and removes `pause_checkpoint_step_*` directories for a fresh next run. Normalizes opts: requires `validation`, rejects top-level `evalDatasetPath`, maps dataset validation to `evalDatasetPath`, and emits `validationSplit` / `useEvalDatasetForValidation` before calling addon. Serializes public API via `exclusiveRunQueue` (`_run`) and tracks the active job via `createJobHandler` (`_job`) plus `_hasActiveResponse`; `_addonOutputCallback` maps terminal finetune payloads to `JobEnded` on the active `QvacResponse`. |
| JS | `addon.js` → `LlamaInterface` | Thin wrapper: `finetune(params)` → `_binding.finetune(handle, params)`, `cancel()` → `_binding.cancel(handle)` (used by both `pause()` and `cancel()` in JS). |
| C++ | `binding.cpp` | BARE exports: `finetune`, `cancel` → `qvac_lib_inference_addon_llama::*`. |
| C++ | `AddonJs.hpp` | Parses JS args, gets `LlamaModel*` via `getLlamaModel(instance)`; `tryGetObject()` for params; builds `Prompt` with `finetuningParams` and `outputCallback`, calls `addonCpp->runJob(any(prompt))` (same path as inference). C++ auto-detects resume via `pauseCheckpointExists(checkpointSaveDir)`. `cancel()`: if `isFinetuneRunning()` then `requestPause()` + `JsAsyncTask::run(waitUntilFinetuningPauseComplete)`, else `cancelJob()`; always returns Promise via `JsAsyncTask::run`. |
| C++ | `LlamaModel.cpp` | `process(any)` branches on `prompt.finetuningParams`; when set, calls `finetune(params, logCallback)` which runs training and returns `"COMPLETED"`/`"PAUSED"` for terminal success/pause states. At start, checks `pauseCheckpointExists(checkpointSaveDir)` to choose resume vs fresh. Uses `params.validationSplit` and `params.useEvalDatasetForValidation` to split train/eval or load a separate eval dataset; logs `val_loss` each epoch when validation is enabled. `requestPause()`, `waitUntilFinetuningPauseComplete()`, `clearPauseRequest()`. Runtime failures throw and are routed to JS as errors. |
| C++ | `LlamaFinetuningHelpers.cpp` | Training loop; on pause writes checkpoint and signals `pauseDoneCv`; per-batch progress is emitted as finetune progress payloads. |
| C++ → JS | `outputQueue` + `OutputCallBackJs` | Per-iteration progress is delivered as `FinetuneProgress` and mapped to `handle.on('stats', ...)`; terminal finetune completion is delivered as `JobEnded` payload `{ op: 'finetune', status, stats? }`. JS resolves via `QvacResponse.ended(data)` (or rejects on `Error`). |

### Parameter Notes

| Parameter | Note |
|-----------|------|
| `batchSize` | Sets backend `n_batch`. When both `batchSize` and `microBatchSize` are set, `microBatchSize` must be <= `batchSize` and `batchSize` must be divisible by `microBatchSize`. |
| `warmupRatio` | Warmup steps = `warmupRatio × totalSteps` when `warmupRatioSet: true`. |
| `validation.path` | Required when `validation.type` is `'dataset'`; must differ from `trainDatasetDir`. The JS layer forwards this as addon `evalDatasetPath`. |
| `evalDatasetPath` (top-level JS param) | Not supported in `finetune(opts)` and throws. Use `validation: { type: 'dataset', path: '...' }`. |

### C++ Backend Overview

The finetuning backend lives in `addon/src/` and uses the llama.cpp optimizer API (`ggml_opt_*`, `llama_opt_*`). Key components:

| Component | Location | Role |
|-----------|----------|------|
| **Addon bindings** | `addon/src/addon/AddonJs.hpp` | `finetune()` parses JS args, builds `Prompt` with `finetuningParams` and `outputCallback`, calls `addonCpp->runJob(any(prompt))` (same path as inference). `cancel()`: if finetune running then `requestPause()` + `waitUntilFinetuningPauseComplete()`, else `cancelJob()`. |
| **LlamaModel** | `addon/src/model-interface/LlamaModel.cpp` | Main orchestrator: `finetune()`, `requestPause()`, `prepareTrainingDataset()`, `executeTrainingLoop()`, `saveLoraAdapter()` |
| **LlamaFinetuningHelpers** | `addon/src/model-interface/LlamaFinetuningHelpers.cpp/.hpp` | Dataset prep, checkpoint I/O, per-batch callback, LoRA config |

**Training flow**

1. **Dataset** — `prepareTrainingDataset()`: SFT mode reads JSONL and builds chat-formatted samples; causal mode tokenizes plain text and builds next-token pairs via `buildNextTokenDataset()`. Validation: when `validationSplit` > 0 the same dataset is split (first N samples train, rest eval); when `useEvalDatasetForValidation` is true, `prepareEvalDataset()` loads a separate file and validation runs on it after each epoch.
2. **Checkpoint state** — `initializeCheckpointing()` creates `TrainingCheckpointState` (ctx, model, adapter, checkpoint dir, atomic flags). Stored in `LlamaModel`; the per-batch callback receives the current state via a thread-local pointer (`setCurrentCheckpointState` / `tlsCurrentCheckpointState`) so the JobRunner thread running the finetune job sees its state.
3. **Resume** — At the start of `finetune()`, C++ calls `pauseCheckpointExists(params.checkpointSaveDir)`. If true: `clearPauseRequest()`; then `findLatestPauseCheckpoint()` locates the latest `pause_checkpoint_step_*` dir; `parseCheckpointMetadata()` loads epoch/step, LoRA config, and explicit resume cursor fields (`resume_epoch`, `resume_batch`, `paused_during_validation`); adapter and optimizer state are restored from the checkpoint. The resume cursor is passed directly to `llama_opt_epoch_resume()` so training continues from the exact saved position. Session params (dataset paths, `numberOfEpochs`, learning rate, validation settings, etc.) come from the current `params`. Only the resume **position** and saved LoRA layout (rank, alpha, target modules) come from the checkpoint. Old checkpoints without the new resume fields fall back to starting from the beginning of the saved epoch.
4. **Optimizer** — `configureOptimizer()` sets up `llama_opt_params` (AdamW, LoRA param filter, LR scheduler). `schedulerOptimizerParams` provides per-step learning rate.
5. **Training loop** — `executeTrainingLoop()` calls `llama_opt_epoch()` for each epoch (train split, optional eval split or separate eval dataset). When validation is enabled, `val_loss` is computed and logged after each epoch. The per-batch callback is `optEpochCallbackWrapper` → `optEpochCallback()`.
6. **Per-batch callback** — `optEpochCallback()`: increments `globalStep`; on first batch, emits `FinetuningStarted` and sets `isFinetuning=true`; if `pauseRequested` is set, calls `savePauseCheckpoint()` (model.gguf, optimizer.gguf, metadata.txt with explicit resume cursor: `resume_epoch`, `resume_batch`, `paused_during_validation`), sets `shouldExit`, `pauseCheckpointSaved`, `isPaused` (and clears `isFinetuning`), and notifies the pause waiter; otherwise, saves periodic checkpoints when `checkpointInterval` is reached.
7. **Pause request path** — `requestPause()`: if `currentCheckpointState_` (atomic, per instance) is non-null, sets `pauseRequested.store(true)` and `llama_opt_request_stop(ctx)`; returns immediately. Returns `false` if no checkpoint state exists (e.g. training not started yet).
8. **Completion** — On normal finish: `saveLoraAdapter()` writes the final LoRA to `outputParametersDir` and finetune ends as `COMPLETED`. On pause: terminal status is `PAUSED`. On runtime error: C++ throws; JS receives an `Error` event and `handle.await()` rejects.

**Wait conditions and internal state** — `TrainingCheckpointState` holds atomic flags `pauseRequested`, `shouldExit`, `pauseCheckpointSaved`, `pauseWaitDone` and the wait condition `pauseDoneCv` / `pauseDoneMutex`. When `pause()` is called during finetuning, `requestPause()` sets `pauseRequested` and a background task runs `waitUntilFinetuningPauseComplete()`, which blocks on `pauseDoneCv` until the JobRunner thread (running the finetune job) saves the checkpoint and sets `pauseWaitDone`; this gives thread-safe coordination between the two. The binding does not read status (e.g. `isPaused`); resume is driven by calling `finetune(params)` again after awaiting `pause()` — JS does not retain stored params, so the same params object must be passed on resume. C++ auto-detects a pause checkpoint in `checkpointSaveDir` and resumes. Multiple model instances work correctly (per-instance state, thread-local callback state). Calling `cancel()` uses the same addon cancel entrypoint, then clears pause checkpoints on the JS side to force a fresh subsequent run.

---

## Dataset Format

### Chat Format (SFT) — `assistantLossOnly: true`

Use JSONL where each line is a JSON object with a `messages` array. Each message has `role` and `content`:

```json
{"messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"What is 2+2?"},{"role":"assistant","content":"2+2 equals 4."}]}
{"messages":[{"role":"user","content":"What is the capital of France?"},{"role":"assistant","content":"The capital of France is Paris."}]}
```

- **Roles**: `system`, `user`, `assistant` (and optionally `tool`).
- **File**: Single `.jsonl` file path (e.g., `./examples/input/small_train_HF.jsonl`).

### Plain Text (Causal) — `assistantLossOnly: false`

Plain text file. The model learns next-token prediction over the entire text. Useful for domain adaptation or completion-style training.

```
This is sample training text.
Another paragraph of content.
```

**Related example:** The examples use chat format. For dataset creation in code, see [test/integration/utils.js](../test/integration/utils.js) `createTestDataset()`.

---

## Examples

### 1. Basic Finetuning

Minimal example: load model, run finetuning, wait for completion.

**Run:** `bare examples/simple-lora-finetune.js`

```js
'use strict'

const LlmLlamacpp = require('@qvac/llm-llamacpp')
const path = require('bare-path')

async function main() {
  const modelDir = path.resolve('./models')

  const model = new LlmLlamacpp({
    files: {
      model: [path.join(modelDir, 'Qwen3-0.6B-Q8_0.gguf')]
    },
    config: {
      gpu_layers: '999',
      ctx_size: '512',
      device: 'gpu',
      flash_attn: 'off'
    },
    opts: { stats: true },
    logger: console
  })

  await model.load()

  const finetuneOptions = {
    trainDatasetDir: './examples/input/small_train_HF.jsonl',
    validation: { type: 'dataset', path: './examples/input/eval_HF.jsonl' },
    numberOfEpochs: 8,
    learningRate: 1e-5,
    lrMin: 1e-8,
    warmupRatioSet: true,
    loraModules: 'attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down',
    assistantLossOnly: true,
    checkpointSaveSteps: 2,
    checkpointSaveDir: './lora_checkpoints',
    outputParametersDir: './finetuned-model-direct'
  }

  const handle = await model.finetune(finetuneOptions)
  const result = await handle.await()
  console.log('Finetune completed:', result)

  await model.unload()
}

main().catch(console.error)
```

### 2. Pause and Resume

Start finetuning, wait for training to begin (e.g. fixed sleep), call `pause()`, then resume by calling `finetune(finetuneOptions)` again with the same params object and wait for completion.

**Run:** `bare examples/simple-lora-finetune-pause-resume.js`

For multiple pause/resume cycles, see [examples/simple-lora-finetune-multiple-pause-resume.js](../examples/simple-lora-finetune-multiple-pause-resume.js).

```js
const finetuneHandle = await model.finetune(finetuneOptions)
await sleep(90000)
await model.pause()
const resumeHandle = await model.finetune(finetuneOptions)
const result = await resumeHandle.await()
console.log('Finetune completed:', result)
```

The [simple-lora-finetune-pause-resume.js](../examples/simple-lora-finetune-pause-resume.js) example uses a fixed sleep (`sleep(90000)`) to allow training to start before pausing.

**Note — resume when you run the script again:** Resume only happens if a pause checkpoint still exists in `checkpointSaveDir`. With a **static path**: if you **pause then close the script** (without resuming), the next run will resume; if you pause, resume, and complete in the same run, the checkpoint is cleared and the next run starts fresh. To always start fresh on the next run, use a **new tmp dir per run** (e.g. `path.join(os.tmpdir(), 'finetune-' + Date.now())`) for `checkpointSaveDir`.

### 3. Inference with Finetuned LoRA

After finetuning, the LoRA adapter is saved to `outputParametersDir`. Use the `lora` config option to load it for inference.

**Run:** `bare examples/simple-lora-inference.js`

```js
const config = {
  device: 'gpu',
  gpu_layers: '999',
  ctx_size: '4096',
  temp: '0.0',
  n_predict: '256',
  lora: './finetuned-model-direct/trained-lora-adapter.gguf'
}

const model = new LlmLlamacpp({
  files: {
    model: [path.join(modelDir, 'Qwen3-0.6B-Q8_0.gguf')]
  },
  config,
  logger: console
})
await model.load()

const messages = [
  { role: 'system', content: 'You are a helpful healthcare assistant.' },
  { role: 'user', content: "Do nurses' involvement in patient education improve outcomes?" }
]

const response = await model.run(messages)
await response.onUpdate(token => process.stdout.write(token)).await()
```

### 3b. Pause, Run Inference, Then Resume

You can pause finetuning, run inference with the current LoRA checkpoint, then resume training. This workflow is useful for evaluating the model mid-training.

**Run:** `bare examples/simple-lora-finetune-pause-inference-resume.js`

### 4. Creating a Chat Dataset

Example of writing a minimal JSONL training file. The test utilities in [test/integration/utils.js](../test/integration/utils.js) use a similar pattern via `createTestDataset()`.

```js
const fs = require('bare-fs')
const path = require('bare-path')

const samples = [
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '2+2 equals 4.' }
    ]
  },
  {
    messages: [
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', content: 'The capital of France is Paris.' }
    ]
  }
]

const filePath = path.join('./models', 'train.jsonl')
fs.mkdirSync(path.dirname(filePath), { recursive: true })
fs.writeFileSync(filePath, samples.map(s => JSON.stringify(s)).join('\n'))
```

---

## Checkpoints and Output

### Output Structure

- **Final adapter**: `{outputParametersDir}/trained-lora-adapter.gguf` (or the path you specify if it ends in `.gguf`).
- **Periodic checkpoints**: `{checkpointSaveDir}/checkpoint_step_0000000N/` (when `checkpointSaveSteps > 0`).
- **Pause checkpoints**: `{checkpointSaveDir}/pause_checkpoint_step_0000000N/` (when you call `pause()` during finetuning).

Each checkpoint directory typically contains:
- `model.gguf` — LoRA adapter weights
- `optimizer.gguf` — optimizer state (for resume)
- `metadata.txt` — epoch, step, LoRA params

### Resume from Pause

Call `finetune(finetuningOptions)` again with the same params object to resume. The addon finds the latest `pause_checkpoint_step_*` in `checkpointSaveDir` and continues training from there. JS does not retain a stored params object, so the caller must pass the same params on every call (including resume). The pause checkpoint metadata includes explicit resume cursor fields (`resume_epoch`, `resume_batch`) which are passed directly to the backend's `llama_opt_epoch_resume()`, so training resumes at the exact saved position without deriving it from step counters. If paused during validation, resume starts at the next epoch. **Checkpoint lifecycle:** After loading a pause checkpoint to resume, the backend removes that checkpoint directory so the same run does not resume from it again. When training completes successfully (COMPLETED), any remaining pause checkpoint in `checkpointSaveDir` is also cleared. Pause checkpoints remain on disk only while training is paused (after `pause()` and before the next `finetune()`), unless `cancel()` is called, which clears them.

---

## Requirements and Limitations

- **Flash Attention**: Disabled during finetuning (`flash_attn: 'off'` is enforced when finetuning params are provided).
- **Exclusive access**: Finetuning and inference cannot run concurrently. Use `pause()` to pause finetuning if you need to run inference, then `finetune()` to continue. Use `cancel()` to stop and clear pause checkpoints for a fresh next run.
- **Dataset size**: For SFT, ensure enough samples. For causal mode, the text must have more tokens than `contextLength + 1`.
- **Model format**: Base model must be a supported GGUF (e.g., LLaMA, Qwen architecture).
- **Platform**: Same platforms as inference (macOS, Linux, Windows, iOS, Android).

---

## See Also

| Example | Description | Run command |
|---------|-------------|-------------|
| [simple-lora-finetune.js](../examples/simple-lora-finetune.js) | Basic finetuning | `bare examples/simple-lora-finetune.js` |
| [simple-lora-finetune-pause-resume.js](../examples/simple-lora-finetune-pause-resume.js) | Pause and resume | `bare examples/simple-lora-finetune-pause-resume.js` |
| [simple-lora-finetune-pause-inference-resume.js](../examples/simple-lora-finetune-pause-inference-resume.js) | Pause, run inference, resume | `bare examples/simple-lora-finetune-pause-inference-resume.js` |
| [simple-lora-finetune-multiple-pause-resume.js](../examples/simple-lora-finetune-multiple-pause-resume.js) | Multiple pause/resume cycles | `bare examples/simple-lora-finetune-multiple-pause-resume.js` |
| [simple-lora-inference.js](../examples/simple-lora-inference.js) | Inference with LoRA adapter | `bare examples/simple-lora-inference.js` |

Run commands assume you are in the package root directory.

**Prerequisites:** Finetuning examples download the model automatically. Training datasets are in `./examples/input/` (`small_train_HF.jsonl`, `eval_HF.jsonl`). To create your own, use the [Creating a Chat Dataset](#4-creating-a-chat-dataset) pattern or [test/integration/utils.js](../test/integration/utils.js) `createTestDataset()`. The inference example expects a LoRA checkpoint from a prior finetuning run.
