# embed-llamacpp

This native C++ addon, built using the `Bare` Runtime, simplifies running text embedding models to enable efficient generation of high-quality contextual text embeddings. It provides an easy interface to load, execute, and manage embedding model instances.

It also runs [Laya](https://github.com/NandhaKishorM/laya) decision models through `LayaDecisions`: typed questions (`choice`, `score`, `noul`) about a text, answered with probabilities in one forward pass per question. See [Laya decision models](#laya-decision-models).

## Table of Contents

- [Supported platforms](#supported-platforms)
- [Installation](#installation)
- [Building from Source](#building-from-source)
- [Usage](#usage)
  - [1. Import the Model Class](#1-import-the-model-class)
  - [2. Create the `args` obj](#2-create-the-args-obj)
  - [3. Create `config`](#3-create-config)
  - [4. Instanstiate the model](#4-instanstiate-the-model)
  - [5. Load the model](#5-load-the-model)
  - [6. Generate embeddings for input sequence](#6-generate-embeddings-for-input-sequence)
  - [7. Release Resources](#7-release-resources)
- [API behavior by state](#api-behavior-by-state)
- [Laya decision models](#laya-decision-models)
- [Rerankers](#rerankers)
- [Assessing fit](#assessing-fit)
- [Vector index](#vector-index)
- [Quickstart Example](#quickstart-example)
- [Other Examples](#other-examples)
- [Benchmarking](#benchmarking)
- [Tests](#tests)
- [Glossary](#glossary)
- [License](#license)

## Supported platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | Metal |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | Metal |
| Linux | arm64, x64 | Ubuntu-22+ | Tier 1 | CUDA (NVIDIA), Vulkan |
| Android | arm64 | 12+ | ✅ Tier 1 | Vulkan, OpenCL (Adreno 700+) |
| Windows | x64 | 10+ | Tier 1 | CUDA (NVIDIA), Vulkan |

**Note on CUDA (Linux and Windows, NVIDIA):**
The CUDA backend ships as a dynamically loaded module alongside Vulkan, and is preferred over
Vulkan when an NVIDIA device is present. On Windows it needs a CUDA 13 install: the runtime DLLs
are loaded from `%CUDA_PATH%\bin\x64`, not from `PATH`.

- If the CUDA module, driver, or required runtime DLL is missing, the device never registers and selection
  falls through to Vulkan, then CPU. Nothing needs configuring for that.
- `backend: "vulkan"` forces Vulkan on an NVIDIA machine. Setting `CUDA_VISIBLE_DEVICES=-1` in the
  environment has the same effect without touching the load config.
- `main-gpu` as an integer indexes ggml's full device list, so adding CUDA shifts the indices an
  existing config was written against.

**Dependencies:**
- inference-addon-cpp (≥1.1.2): C++ addon framework
- @qvac/fabric (^0.22.0): Shared llama.cpp/ggml inference engine. The desktop runtime ships in the `@qvac/fabric-<host>` platform package that `@qvac/fabric` installs as an optional dependency, so install without `--omit=optional` and keep both present before `bare-make generate`/`build`. Android and iOS apps add `@qvac/fabric` and `@qvac/fabric-android-arm64` or `@qvac/fabric-ios` as direct dependencies at the same exact version.
- Bare Runtime (≥1.24.0): JavaScript runtime
- Linux requires Clang/LLVM 22 with libc++


## Installation

### Prerequisites

Ensure that the `Bare` Runtime is installed globally on your system. If it's not already installed, you can install it using:

```bash
npm install -g bare@latest
```

### Installing the Package

```bash
npm install @qvac/embed-llamacpp@latest
```

## Building from Source

See [build.md](./build.md) for detailed instructions on how to build the addon from source.

## Usage

### 1. Import the Model Class

```js
const GGMLBert = require('@qvac/embed-llamacpp')
```

### 2. Create the `args` obj

```js
const path = require('bare-path')

const args = {
  files: { model: [path.join(dirPath, modelName)] },
  config: {
    device: 'gpu',
    gpu_layers: '99',
    batch_size: '1024',
    ctx_size: '512'
  },
  logger: console,
  opts: { stats: true }
}
```

The `args` obj contains the following properties:

* `files.model`: An array of absolute paths to the model file(s) on disk. For sharded models, provide all shard paths.
* `files.projectionModel` (optional): Absolute path to the projection model (mmproj) of a multimodal embedding model such as EmbeddingGemma 2. With it, `run()` also embeds images and audio (see [Embed images and audio](#embed-images-and-audio)).
* `config`: A dictionary of hyper-parameters used to tweak the behaviour of the model (see [Create `config`](#3-create-config) below).
* `logger`: This property is used to create a [`QvacLogger`](../logging) instance, which handles all logging functionality.
* `opts.stats`: This flag determines whether to calculate inference stats.

#### Sharded model usage

The addon does not discover companion files on disk — the caller MUST pass every file the model needs, in order, via `files.model`. For sharded GGUF models this includes the `.tensors.txt` companion file followed by each `.gguf` shard in numerical order.

```js
const path = require('bare-path')

const dir = '/path/to/models'
const model = new GGMLBert({
  files: {
    model: [
      path.join(dir, 'gte-large.Q2_K.tensors.txt'),
      path.join(dir, 'gte-large.Q2_K-00001-of-00005.gguf'),
      path.join(dir, 'gte-large.Q2_K-00002-of-00005.gguf'),
      path.join(dir, 'gte-large.Q2_K-00003-of-00005.gguf'),
      path.join(dir, 'gte-large.Q2_K-00004-of-00005.gguf'),
      path.join(dir, 'gte-large.Q2_K-00005-of-00005.gguf')
    ]
  },
  config: { device: 'gpu', gpu_layers: '99' },
  logger: console,
  opts: { stats: true }
})
```

Rules for the `files.model` array:

* **Order matters.** The `.tensors.txt` file must come first, then shards in ascending numerical order (`00001-of-00005`, `00002-of-00005`, ...).
* **All shards are required.** Missing any shard or the `.tensors.txt` companion will fail loading.
* **Non-sharded models** pass a single absolute path: `files: { model: [modelPath] }`.
* **Absolute paths only.** The addon reads each file directly via `bare-fs` during `load()`.

### 3. Create `config`

The `config` is a plain JS object whose keys are forwarded directly to the native backend. All values must be strings (the native layer parses them with `getSubmap`).

| Key              | Range / Type                                  | Default       | Description                                                                              |
|------------------|-----------------------------------------------|---------------|------------------------------------------------------------------------------------------|
| `device`         | `"gpu"` \| `"cpu"`                            | `"gpu"`       | Device to run inference on                                                               |
| `gpu_layers`     | string of integer                             | `"0"`         | Number of model layers to offload to GPU                                                 |
| `batch_size`     | string of integer                             | `"2048"`      | Tokens processed per batch (input throughput)                                            |
| `ctx_size`       | string of integer                             | model's trained context size (`n_ctx_train`) | Runtime context window in tokens (llama.cpp `n_ctx`); oversized values are capped to the model's trained context |
| `poll`           | string of integer `"0"`–`"100"`             | `"0"`         | Main GGML threadpool busy-wait level. `"0"` sleeps while idle; higher values can reduce wake latency but consume CPU during GPU work |
| `poll-batch`     | string of integer `"0"`–`"100"`             | `poll`          | Batch GGML threadpool busy-wait level                                                     |
| `pooling`        | `"none"` \| `"mean"` \| `"cls"` \| `"last"`         | model default | Pooling strategy used to collapse token embeddings into a single sequence vector. Rank pooling (rerankers) returns scores, not embeddings: the load fails with `UnsupportedEmbeddings`; use [`Reranker`](#rerankers) |
| `attention`      | `"causal"` \| `"non-causal"`                  | model default | Attention type                                                                            |
| `embd_normalize` | string of integer                             | `"2"`         | Embedding normalization (`-1` = none, `0` = max abs int16, `1` = taxicab, `2` = euclidean, `>2` = p-norm) |
| `flash_attn`     | `"on"` \| `"off"` \| `"auto"`                 | `"auto"`      | Enable / disable flash attention                                                         |
| `main-gpu`       | string of integer \| `"integrated"` \| `"dedicated"` | —      | GPU selection for multi-GPU systems                                                      |
| `backend`        | comma-separated list of `cuda`, `vulkan`, `metal`, `opencl`, or `auto` | N/A | Overrides which GPU backend is used, in priority order (e.g. `"cuda,vulkan"`). `auto` means no preference. An unrecognised name is rejected; a recognised one with no device present is skipped. Use `device: "cpu"` to run on CPU. Cannot be combined with `split-mode` |
| `verbosity`      | string of `"0"`–`"3"` (0=ERROR, 1=WARNING, 2=INFO, 3=DEBUG) | `"0"` | Native logging verbosity. The `addonLogging.setLogger` callback receives only messages at or above this threshold. Use `"2"` for llama.cpp INFO logs and `"3"` for DEBUG logs. The verbosity level is process-global and is updated each time a model is constructed, so the most recently constructed model's `config.verbosity` wins for all subsequent native log dispatch. |

These keys apply with [`files.projectionModel`](#embed-images-and-audio), with the names and spellings `@qvac/llm-llamacpp` uses (each also accepts its underscore form, e.g. `image_max_tokens`). Set without `files.projectionModel`, any of them fails the load with `InvalidConfiguration`:

| Key                    | Range / Type                         | Default | Description |
|------------------------|--------------------------------------|---------|-------------|
| `image-max-tokens`     | string of positive integer           | projector default (1120 for EmbeddingGemma 2) | Largest per-image token budget of a dynamic-resolution vision encoder. Lower it to embed larger or more images per input within `batch_size`, or to save compute on phones |
| `image-min-tokens`     | string of positive integer           | projector default (70 for EmbeddingGemma 2) | Smallest per-image token budget. Must not exceed `image-max-tokens` |
| `mmproj-no-audio`      | `"true"`/`"on"`/`"1"` or `"false"`/`"off"`/`"0"` | `"false"` | Skip loading the projector's audio encoder, for image-only use. Audio input is then rejected with `UnsupportedMedia` |
| `mmproj-use-gpu`       | `"true"`/`"on"`/`"1"` or `"false"`/`"off"`/`"0"` | auto | Run the projector on the GPU. Unset, it follows the model, except on Android GPUs below Adreno 800 (Mali, older Adreno), where it runs on the CPU, as in `@qvac/llm-llamacpp`. Ignored with a warning when the model runs on the CPU |
| `image-max-megapixels` | string of positive integer           | `"50"`  | Largest image accepted, read from its header before decoding. A larger one is rejected with `UnsupportedMedia` |
| `audio-max-seconds`    | string of positive integer           | `"600"` | Longest audio accepted, read from its headers (WAV, FLAC) or frames (MP3) before decoding, which bounds the decoded samples. Longer audio, or audio whose length cannot be read (e.g. FLAC without a sample count), is rejected with `UnsupportedMedia`. Not in `@qvac/llm-llamacpp` |

#### Native addon logging

`@qvac/embed-llamacpp/addonLogging` exposes the native C++ logger:

```js
const { setLogger, releaseLogger } = require('@qvac/embed-llamacpp/addonLogging')

setLogger((priority, message) => {
  console.log(priority, message)
})
```

The callback is wired before model load, but it still follows `config.verbosity`.
With the default `"0"` setting, only native `ERROR` messages are delivered. Set
`config.verbosity` to `"2"` to receive llama.cpp `INFO` diagnostics, or `"3"` for
`DEBUG` messages. The verbosity level is process-global and is updated each
time a model is constructed, so when multiple models are loaded the most
recently constructed model's `config.verbosity` wins for all subsequent
native log dispatch. Some startup diagnostics printed directly by llama.cpp
may still appear on `stderr` before the addon installs its callback.

#### IGPU/GPU  selection logic:

| Scenario                       | main-gpu not specified                | main-gpu: `"dedicated"`             | main-gpu: `"integrated"`           |
|---------------------------------|---------------------------------------|-------------------------------------|-------------------------------------|
| Devices considered              | All GPUs (dedicated + integrated)     | Only dedicated GPUs                 | Only integrated GPUs                |
| System with iGPU only           | ✅ Uses iGPU                          | ❌ Falls back to CPU                | ✅ Uses iGPU                        |
| System with dedicated GPU only  | ✅ Uses dedicated GPU                 | ✅ Uses dedicated GPU               | ❌ Falls back to CPU                |
| System with both                | ✅ Uses dedicated GPU (preferred)     | ✅ Uses dedicated GPU               | ✅ Uses integrated GPU              |


### 4. Instantiate the model

```js
const model = new GGMLBert(args)
```

### 5. Load the model

```js
await model.load()
```

`load()` takes no arguments. The addon streams each file listed in `files.model` directly from disk via `bare-fs` and then activates the model. There is no data loader, no progress callback, and no download step — the caller is responsible for ensuring the files already exist at the paths passed to the constructor.

### 6. Generate embeddings for input sequence

The model outputs a vector for the input sequence.

```js
const query = 'Hello, can you suggest a game I can play with my 1 year old daughter?'
const response = await model.run(query)
const embeddings = await response.await()
```

When `opts.stats` is enabled, `response.stats` includes runtime metrics such as `total_tokens`, `total_time_ms`, `tokens_per_second`, `context_size`, `trained_context_size`, and `backendDevice` (`"cpu"` or `"gpu"`). `context_size` is the active runtime llama context size, while `trained_context_size` is the model's trained context size. `backendDevice` reflects the resolved device used at runtime after backend selection/fallback logic, not only the requested config.

#### Embed images and audio

A multimodal embedding model, such as EmbeddingGemma 2, maps text, images and audio into one vector space. Load it with its projection model, then pass `{ inputs: [...] }`: each input is a string, or an array of parts in order, with strings for text and `{ media: Uint8Array }` for the bytes of an image (jpg, png, bmp, gif, ...) or of wav/mp3/flac audio.

```js
const model = new GGMLBert({
  files: { model: [modelPath], projectionModel: mmprojPath },
  config: { device: 'gpu', gpu_layers: '99' }
})
await model.load()

// One embedding per input
const response = await model.run({
  inputs: [
    'task: search result | query: waterproof trail running shoes',
    ['title: none | text: ', { media: imageBytes }],
    [{ media: audioBytes }]
  ]
})
const [embeddings] = await response.await()
```

`run()` takes:

| Input | Embeddings |
|-------|------------|
| `string` | one |
| `string[]` | one per string |
| `{ inputs: [...] }`, each a string or an array of parts | one per input |

Media goes only in `{ inputs }`. A bare array is always one embedding per string, so an array holding `{ media }` is rejected with a `TypeError` rather than read as a single input.

Notes:

* Inputs without media use the text path, so a model loaded with a projection model still embeds plain text as before.
* Media input without `files.projectionModel` is rejected.
* Each multimodal input is decoded in one pass, so its text and media tokens together must fit in `batch_size` (which is also the micro-batch size). With EmbeddingGemma 2 a large image takes up to 1120 tokens, so two of them in one input need a larger `batch_size` or a lower `image-max-tokens` (see the projector options under [Create `config`](#3-create-config)).
* Images: the formats stb_image reads (JPEG, PNG including 16-bit, grayscale and alpha, BMP, GIF's first frame, TGA, PSD, HDR, PNM). Audio: WAV, MP3 and FLAC, resampled to the model's rate. TIFF, HEIC, JPEG 2000, WebP, AAC/M4A, AIFF and Ogg are rejected with `UnsupportedMedia`.
* Task prompts such as `task: search result | query: ` are plain text. Add them as the model's documentation describes.
* Video input is not supported.

### 7. Release Resources

Unload the model when finished:

```javascript
try {
  await model.unload()
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

### API behavior by state

The following table describes the expected behavior of `run` and `cancel` depending on the current state (idle vs a job running). `cancel` can be called on the model (`model.cancel()`) or on the response (`response.cancel()`); both target the same underlying job.

| Current state | Action called | What happens |
|---------------|----------------|----------------------------------------------------------------|
| idle          | run            | **Allowed** — starts inference, returns `QvacResponse`        |
| idle          | cancel         | **Allowed** — no-op (no job to cancel); Promise resolves       |
| run           | run            | **Throw** — second `run()` throws `"Cannot set new job: a job is already set or being processed"` once it reaches the head of the queue; previous response must settle first. |
| run           | cancel         | **Allowed** — cancels current job; Promise resolves when job has stopped      |

A second `run()` while a job is active is serialized by `exclusiveRunQueue` — it waits in the queue until the previous `_runInternal` returns, then enters the busy guard. Because the busy flag (`_hasActiveResponse`) is only cleared when the previous `response.await()` settles, the second call rejects with `"Cannot set new job: a job is already set or being processed"`. The queue eliminates race conditions but does not retry or buffer results; callers must wait for the previous `response.await()` to settle (or call `model.cancel()`) before issuing the next request.

**Cancellation API:** Prefer cancelling from the model: `await model.cancel()`. This cancels the current job and the Promise resolves when the job has actually stopped (future-based in C++). You can also call `await response.cancel()` on the value returned by `run()`; it is equivalent and targets the same job. Both are no-op when idle.

## Laya decision models

`LayaDecisions` answers typed questions about a text (the *state*) with [Laya](https://github.com/NandhaKishorM/laya) checkpoints: a ModernBERT or mmBERT encoder with a decision head. It does not generate text: every answer is a probability distribution over the question's options (yours for `choice` and `score`, true and false for `noul`), computed in one forward pass per question. The request and response are laya's own format (`Agent.predict` / `predict_batch`), and the answers match fabric's `llama-laya` tool for the same model.

It needs a fabric runtime that includes Laya (`qvac-fabric` 10549.5.1 or later). On an older runtime, `load()` fails with `model initialization returned a null model/context`; embeddings are unaffected.

### Usage

```js
const { LayaDecisions } = require('@qvac/embed-llamacpp')

const laya = new LayaDecisions({
  files: { model: ['/models/laya-multilingual-Q8_0.gguf'] },
  config: { device: 'gpu', gpu_layers: '99' }
})
await laya.load()

const response = await laya.run({
  state: 'My payment failed twice and I was charged both times. Please refund the duplicate.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      criteria: { billing: 'payments, refunds, invoices', technical: 'bugs, outages, errors' }
    },
    urgency: { type: 'score', instructions: 'How urgent is this?', criteria: ['not urgent', 'somewhat urgent', 'very urgent'] },
    refund: { type: 'noul', instructions: 'The customer asks for a refund.' }
  }
})
const [result] = await response.await()

result.answers.department.choice // 'billing'
result.answers.urgency.score // about 1.5: the expected level on the 0-2 scale
result.answers.refund.noul // about 0.98: the probability that the statement holds

await laya.unload()
```

`load()`, `run()`, `cancel()` and `unload()` behave as in `GGMLBert`, including [API behavior by state](#api-behavior-by-state): one request at a time, and `cancel()` stops a running request.

### Request

| Field | Description |
|-------|-------------|
| `state` | The text to decide about: a string, a structured object (for example `{ customer, message }`), or a conversation as a list of turns. A conversation too long for the budget keeps its newest turns. |
| `states` | A list of states instead of `state`, answered in one call. The response is then one result per state. |
| `questions` | Question id → question. Each question is answered independently. |
| `max_len`, `head_max_len` | Optional overrides of the checkpoint's token budgets: the whole sequence, and the question with its options. |

Question types:

| `type` | `criteria` | Answer |
|--------|------------|--------|
| `choice` | A list of labels, or label → description | `choice`, plus `probabilities` per label |
| `score` | A list of level descriptions, lowest first | `score` (the expected level, Σ i·p(i)), `probabilities` per level and a `legend` |
| `noul` | Optional `{ true, false }` descriptions | `noul`, the probability that the statement holds |

Every question takes `instructions` (the question itself) and an optional `option_order`, a permutation of the option indices that changes the order the model sees the options in; answers still come back in your order. A `noul` question also takes `labels` (`{ false, true }`) to rename its two options.

### Response

`response.await()` resolves to `[result]` for `state`, and to `[[result, ...]]` for `states`. Each result is `{ model, answers, usage }`:

- `answers.<id>` holds the answer fields above, plus `confidence`, `answer_confidence` (the probability of the reported answer) and `action.act_probability`. For `choice` and `score`, `confidence` is 1 − the normalized entropy of the option distribution; for `noul` it is the probability of the more likely side.
- `usage` reports `input_tokens`, `state_tokens`, `state_tokens_dropped`, `truncated`, `truncated_questions`, and `options` for questions whose options collapsed under the token budget.

### Config

Only these keys are accepted, multi-word ones in either spelling (`batch_size` or `batch-size`); anything else fails at load with `InvalidConfiguration`, because pooling, context size and the other context settings are fixed by Laya's single-pass setup.

| Key | Values | Default | Description |
|-----|--------|---------|-------------|
| `device` | `"gpu"` \| `"cpu"` | — (required) | Device to run on |
| `gpu_layers` | string of integer | all layers, fewer if memory is short | Layers to offload to the GPU |
| `batch_size` | string of integer | `"2048"` | Tokens per forward pass. Every sequence (one question over one state) must fit, and the cost of a pass grows with the square of the batch size, so raise it only for longer states |
| `threads` | string of integer | one per physical core | CPU threads, at most the device's CPU count; `"0"` uses every CPU |
| `threads-batch` | string of integer | `threads` | CPU threads for batch processing, which is all of Laya's work; same limit as `threads` |
| `poll` | string of integer `"0"`–`"100"` | `"0"` | Main GGML threadpool busy-wait level |
| `poll-batch` | string of integer `"0"`–`"100"` | `poll` | Batch GGML threadpool busy-wait level |
| `flash_attn` | `"on"` \| `"off"` \| `"auto"` | `"auto"` | Flash attention |
| `main-gpu`, `split-mode`, `tensor-split` | | | GPU selection and multi-GPU split, as in [`config`](#3-create-config) |
| `verbosity`, `openclCacheDir` | | | As in [`config`](#3-create-config) |

With `opts: { stats: true }`, `response.stats` holds `total_tokens`, `total_time_ms`, `sequences` (one per question and state), `forward_passes`, `batch_size`, `context_size` and `backendDevice`.

### Errors

`load()` rejects with an error whose `code` names the cause:

| `code` | When |
|--------|------|
| `[ GTE :: InvalidArgument ]` | `device` is missing (`must specify a device`) |
| `[ GTE :: InvalidConfiguration ]` | A key outside the list above, a thread count that is not a whole number or exceeds the CPU count, or a `batch_size` too small for even a short sequence |
| `[ GTE :: UnsupportedModel ]` | The GGUF is not a Laya checkpoint (detected before its weights load), or its decision metadata is malformed |
| `[ GTE :: UnableToLoadMetadata ]`, `[ GTE :: UnableToLoadModel ]` | The file cannot be read or loaded, including a Laya model on a fabric runtime without Laya |

`run()` rejects with an error that carries only a `message`, naming the problem: an invalid request (`predict: question 'q': unknown type "pick"; use one of choice, noul, score`), a sequence longer than `batch_size` (`predict: a sequence of 928 tokens does not fit the batch size 512`), a failed forward pass (`predict: llama_decode failed`), or `Job cancelled` after `cancel()`.

### Choosing a checkpoint

| Checkpoint | Encoder | Use for |
|------------|---------|---------|
| `laya-multilingual` | mmBERT-base | Text in any language, including non-Latin scripts |
| `laya` | ModernBERT-large | English text |
| `laya-typed-decisions` | ModernBERT-large | English text in the workflows it was fine-tuned on (invoice processing, security incidents, customer service, agent traces) |

Pick the checkpoint for the language of the state: the addon does not choose one for you. The English checkpoints give confident wrong answers on non-Latin scripts. Both f16 and Q8_0 files are supported.

GGUF files are converted from the Hugging Face checkpoints with the converter and quantizer in [qvac-fabric-llm.cpp](https://github.com/tetherto/qvac-fabric-llm.cpp):

```bash
hf download convaiinnovations/laya-multilingual --local-dir laya-multilingual
python convert_hf_to_gguf.py laya-multilingual --outtype f16 --outfile laya-multilingual-f16.gguf
llama-quantize laya-multilingual-f16.gguf laya-multilingual-Q8_0.gguf Q8_0
```

### Limits

- Questions with many options (more than about 20) lose accuracy at the default token budgets, since the options share `head_max_len`.
- `confidence` and `answer_confidence` are not calibrated for `laya-multilingual`, which ships without calibration temperatures. Choose any threshold you act on from measurements on your own data.
- laya's Python-only features are not part of this class: automatic checkpoint routing (`Router`), long documents (`predict_long`), `predict_shortlist`, schema-driven `decide`, hooks and per-language temperatures.

## Rerankers

`Reranker` scores documents by how relevant each is to a query, with a reranker (cross-encoder) GGUF such as bge-reranker, jina-reranker or Qwen3-Reranker. Each document is read together with the query, which makes the scores more accurate than comparing embeddings, and slower: a typical use is to retrieve candidates with embeddings and a vector index (such as `IdMapIndex` from `@qvac/turbovec-ggml`), then rerank the top few. It pairs the query with each document as llama-server's `/rerank` does, using the model's `rerank` chat template when it has one, and the scores match fabric's `llama-embedding --pooling rank`.

An embedding model cannot rerank: `GGMLBert` rejects rank pooling, and `Reranker` rejects a GGUF that declares another pooling or has no classifier head.

### Usage

```js
const { Reranker } = require('@qvac/embed-llamacpp')

const reranker = new Reranker({
  files: { model: ['/models/jina-reranker-v1-tiny-en-f16.gguf'] },
  config: { device: 'gpu', gpu_layers: '99' }
})
await reranker.load()

const response = await reranker.run({
  query: 'Machine learning is',
  documents: [
    'A machine is a physical system that uses power to apply forces.',
    'Machine learning is a field of study in artificial intelligence.',
    'Paris est la capitale de la France.'
  ]
})
const [scores] = await response.await()
// One score per document, in the order given; higher is more relevant.
const ranked = scores.map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score)

await reranker.unload()
```

`load()`, `run()`, `cancel()` and `unload()` behave as in `GGMLBert`, including [API behavior by state](#api-behavior-by-state).

A score is the model's raw classifier output: a logit for most rerankers, a probability for Qwen3-Reranker. Compare scores from one model; they are not on a common scale across models. All documents of a request are scored in as few forward passes as `batch_size` allows.

### Config

Only these keys are accepted, multi-word ones in either spelling; anything else fails at load with `InvalidConfiguration`, because pooling, context size and the other context settings are fixed by the scoring setup.

| Key | Values | Default | Description |
|-----|--------|---------|-------------|
| `device` | `"gpu"` \| `"cpu"` | — (required) | Device to run on |
| `gpu_layers` | string of integer | all layers, fewer if memory is short | Layers to offload to the GPU |
| `batch_size` | string of integer | `"2048"` | Tokens per forward pass. Each document, together with the query, must fit |
| `threads`, `threads-batch` | string of integer | one per physical core | CPU threads, at most the device's CPU count; `"0"` uses every CPU |
| `poll`, `poll-batch` | string of integer `"0"`–`"100"` | `"0"`, `poll` | GGML threadpool busy-wait levels, as in [`config`](#3-create-config) |
| `flash_attn` | `"on"` \| `"off"` \| `"auto"` | `"auto"` | Flash attention |
| `backend`, `main-gpu`, `split-mode`, `tensor-split` | | | GPU selection and multi-GPU split, as in [`config`](#3-create-config) |
| `verbosity`, `openclCacheDir` | | | As in [`config`](#3-create-config) |

With `opts: { stats: true }`, `response.stats` holds `total_tokens`, `total_time_ms`, `documents`, `forward_passes`, `batch_size`, `context_size` and `backendDevice`.

### Errors

`load()` rejects with an error whose `code` names the cause:

| `code` | When |
|--------|------|
| `[ GTE :: InvalidArgument ]` | `device` is missing |
| `[ GTE :: InvalidConfiguration ]` | A key outside the list above, or a thread count that is not a whole number or exceeds the CPU count |
| `[ GTE :: UnsupportedModel ]` | The GGUF is not a reranker: it declares a pooling other than rank (an embedding model), or has no classifier head (for example a chat model). Detected before its weights load |
| `[ GTE :: UnableToLoadMetadata ]`, `[ GTE :: UnableToLoadModel ]` | The file cannot be read or loaded |

A reranker GGUF that declares no pooling at all, as many converted cross-encoders do, is accepted. The classifier-head check reads the GGUF files from disk, so a model streamed in shards is not checked.

`run()` throws a `TypeError` when the request is not `{ query: string, documents: string[] }`, and otherwise rejects with an error that carries only a `message`: a document that with the query is longer than `batch_size` (`increase batch_size`) or than the model's trained context, a failed forward pass (`llama_decode failed`), or `Job cancelled` after `cancel()`.

## Assessing fit

`assessFit` projects a load against the memory free right now. It reads GGUF metadata and never weight data, so the registry's weightless copy of a model answers the same as the model itself and the projection can run before anything is downloaded.

```js
const EmbedLlamacpp = require('@qvac/embed-llamacpp')

const fit = await EmbedLlamacpp.assessFit({
  modelPath: '/models/embed.gguf',
  config: { device: 'gpu', 'batch-size': '1024' }
})

fit.status // 'fits' | 'does-not-fit' | 'error'
fit.reason // 'fits', 'does-not-fit', 'model-unreadable', 'no-backend-device' or 'unsupported-config'
fit.message // with status 'error': what caused it, e.g. the refused config key
fit.gpuLayers // what fits, which is not always what the request asked for
fit.ctxSize
fit.devices // one row per device the model was assigned to, then a `host` row
fit.deviceBytes // model, context and compute summed across the devices, host excluded
fit.hostBytes // the same, for the trailing host row
```

A multimodal load is refused with `unsupported-config`: pass its `projectionModel` (or projector options in `config`), and the projection does not count the projector's weights and buffers, so it would otherwise answer for the text model alone.

`config` is the load, exactly as `loadModel` takes it. The projection resolves it with the same code that load runs, so every setting reaches the fitter the way it would reach the engine, and a load the engine would refuse is refused here as `status: "error"` with `unsupported-config`, and `message` names the setting and why. A setting left out takes llama's default.

Pinning `gpu-layers` fixes the placement: the fitter refuses to move layers off a device the load claimed, so the answer is whether that exact placement fits, never a reduced one. Leave it unset for a projection that can place the model itself.

The projection applies the embedding load's own normalization: the micro-batch follows `batch-size`, a single sequence uses a unified KV cache, and the context is pinned to the model's trained context, or capped at it.

`minCtxSize` sets a floor the fitter may not reduce the context below, defaulting to llama's own `fit-ctx` of 4096. `marginBytes` is the memory to leave free on every device, defaulting to llama's `fit-target` of 1 GiB per device. `backendsDir` is where the dynamically-loaded ggml backends live.

`assessFit` returns a Promise. Concurrent calls run one at a time within this addon.

A model the fitter cannot read resolves to `status: "error"`; only a broken request rejects.

## Vector index

The `IdMapIndex` vector index, including TurboVec storage, lives in
[`@qvac/turbovec-ggml`](https://github.com/tetherto/qvac/tree/main/packages/turbovec-ggml). Pair it with `GGMLBert`
embeddings for retrieval.

## Quickstart Example

Clone the repository and navigate to it:
```bash
cd embed-llamacpp
```

Install dependencies:
```bash
npm install
```

Run the quickstart example (uses examples/quickstart.js):
```bash
npm run quickstart
```

## Other Examples

- [Batch Inference](./examples/batchInference.js) – Demonstrates running multiple prompts at once using batch inference.
- [Native Logging](./examples/nativelog.js) – Demonstrates C++ addon logging integration.
- [Rerank](./examples/rerank.js) – Ranks documents by relevance to a query with a reranker GGUF: `bare examples/rerank.js /path/to/reranker.gguf`.
- [Laya Decisions](./examples/layaDecisions.js) – Answers `choice`, `score` and `noul` questions about a support ticket, then about several tickets in one call. Takes the path to a Laya GGUF: `bare examples/layaDecisions.js /path/to/laya-multilingual-Q8_0.gguf`.

## Benchmarking

We conduct rigorous benchmarking of our embedding models to evaluate their retrieval effectiveness and computational efficiency across diverse tasks and datasets. Our evaluation framework incorporates standard information retrieval metrics and system performance indicators to provide a holistic view of model quality.

### Running Benchmarks

For instructions on running benchmarks yourself, see the [Benchmark Runner Documentation](./benchmarks/README.md).

The benchmarking covers:

* **Retrieval Quality**:

  * **nDCG\@k**: Quality of ranked results based on relevance and position
  * **MRR\@k**: Position of the first relevant result per query
  * **Recall\@k**: Coverage of relevant results in the top *k*
  * **Precision\@k**: Proportion of top *k* results that are relevant

Results are continuously updated with new releases to ensure up-to-date performance insights.

## Tests

Integration tests are located in [`test/integration/`](./test/integration/) and cover core embed functionality: single-file model load → embed → unload, multi-instance concurrency (two embed instances running simultaneously, repeated load/unload cycles, unloading one instance while another processes), and the public `run()` / `cancel()` lifecycle. `laya.test.js` covers `LayaDecisions` end to end: every question type, batches, CPU and GPU, request errors, cancel, and load errors. It runs when `LAYA_TEST_MODEL` points at a Laya GGUF and is skipped otherwise, since no Laya GGUF is pinned in `models.manifest.json` yet. `rerank.test.js` covers `Reranker` with the pinned jina-reranker-v1-tiny-en: ranking, batching, CPU and GPU, request errors, cancel, and load errors. These tests help prevent regressions and ensure the library remains stable as contributions are made to the project.

C++ unit tests live under [`test/unit/`](./test/unit/) and exercise the native components at a lower level, including backend selection, single-step inference, end-to-end embedding generation, pooling, Laya decisions and reranking. These tests validate the native implementation and help catch issues early in development. The Laya tests that run a model need a Laya GGUF, from `LAYA_TEST_MODEL` or at `models/unit-test/laya-test.gguf`, and are skipped without one. The rerank tests need a reranker GGUF, from `RERANK_TEST_MODEL` or at `models/unit-test/rerank-test.gguf` ([jina-reranker-v1-tiny-en](https://huggingface.co/ggml-org/models/tree/main/jina-reranker-v1-tiny-en), as CI downloads it).

> **Note:** This package covers embeddings, rerankers and Laya decision models. There is no text generation, tool-calling, multimodal, KV-cache, or chat-template support — those features belong to the LLM addon ([`@qvac/llm-llamacpp`](../llm-llamacpp/)).

## Glossary

* **Bare Runtime** - Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/reference/bare-overview).

## License

This project is licensed under the Apache-2.0 [License](./LICENSE) – see the LICENSE file for details.

_For questions or issues, please open an issue on the GitHub repository._
