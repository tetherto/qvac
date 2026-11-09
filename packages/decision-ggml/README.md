# decision-ggml

Decision models for QVAC: typed questions (`choice`, `score`, `noul`) about a
state, answered with probabilities. Two engines, chosen by the caller from the
model:

- **`LayaDecisions`** runs fabric-format [Laya](https://github.com/NandhaKishorM/laya)
  checkpoints (`general.architecture` `laya`). It moved here unchanged from
  `@qvac/embed-llamacpp`, which keeps a deprecated copy until this package is
  released.
- **`DecisionEngine`** runs upstream llama.cpp decision models (openjev, lev,
  kev, clef, upstream-format laya, ...), any GGUF with `<arch>.decision.*`
  metadata. Decision parsing, prompt rendering, scheduling and answer
  calculation are upstream's: the addon runs upstream's `server-context`
  in-process, without an HTTP server, linked statically from `@qvac/fabric`.

Both load models from a path and run on the shared `@qvac/fabric` runtime.

## Supported platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | Metal |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | Metal |
| Linux | arm64, x64 | Ubuntu-22+ | Tier 1 | CUDA (NVIDIA), Vulkan |
| Android | arm64 | 12+ | ✅ Tier 1 | Vulkan, OpenCL (Adreno 700+) |
| Windows | x64 | 10+ | Tier 1 | CUDA (NVIDIA), Vulkan |

## Installation

```bash
npm install @qvac/decision-ggml
```

Android and iOS apps also add `@qvac/fabric` and `@qvac/fabric-android-arm64`
or `@qvac/fabric-ios` as direct dependencies, at the same version.

## Upstream decision models

```js
const { DecisionEngine, DECISION_INVALID_REQUEST } = require('@qvac/decision-ggml')

const engine = new DecisionEngine({
  files: { model: ['/models/openjev-Q8_0.gguf'] },
  config: { device: 'gpu', mmproj: '/models/mmproj-openjev-Q8_0.gguf' }
})
await engine.load()

engine.info() // { decision_type: 'openjev', noul: 'probability', images: true, score_levels: { min: 2, max: 10 }, ... }

const response = await engine.run({
  state: 'My payment failed twice and I was charged both times.',
  questions: {
    route: {
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      criteria: { support: 'Account and delivery questions', billing: 'Payments and refunds' }
    },
    refund: { type: 'noul', instructions: 'Does the customer ask for a refund?' }
  }
})
const [result] = await response.await()
// result.answers.route.choice, result.answers.refund.noul, result.usage.input_tokens

await engine.unload()
```

Requests and results use upstream's `/v1/systemone` shapes, one state per run.
`info()` reports what the loaded model supports; check it before building
requests (for example, lev's `noul` is an expected rating, not a probability).

### Config

| Key | Meaning |
| --- | --- |
| `device` | Required: `gpu` or `cpu`. `cpu` keeps every layer and the projector on the CPU. |
| `gpu_layers` | Layers to offload on `gpu`. |
| `ctx_size`, `batch_size`, `ubatch_size`, `threads` | Context and batch sizes, threads. Unset values are left to upstream (the context fits free device memory). |
| `parallel` | Upstream slots, at least 1. Upstream schedules a request's questions and option variants over them; it does not change how many requests run at once. |
| `mmproj` | Projector GGUF, for models that take images or audio. |
| `verbosity` | Native log level, `0` (error) to `3` (debug). |
| `openclCacheDir` | Writable OpenCL kernel cache directory (Android). |

Any other key fails the load.

### Behavior

- **One request at a time.** A `run()` while another is in flight is rejected;
  queue in JS.
- **Cancellation.** `cancel()` stops the running request at upstream's next
  result poll, and reaches a request even before its run starts. The next
  request runs normally.
- **Errors.** A model without decision metadata fails `load()` from its GGUF
  header, before anything is loaded, with `[ Decision :: UnsupportedModel ]`. A request the model rejects (too many
  options, an unsupported question type, nesting deeper than 128 levels, ...)
  fails with `err.code === DECISION_INVALID_REQUEST`; other failures do not
  carry that code.

## Laya decision models

`LayaDecisions` answers typed questions about a text (the *state*) with [Laya](https://github.com/NandhaKishorM/laya) checkpoints: a ModernBERT or mmBERT encoder with a decision head. It does not generate text: every answer is a probability distribution over the question's options (yours for `choice` and `score`, true and false for `noul`), computed in one forward pass per question. The request and response are laya's own format (`Agent.predict` / `predict_batch`), and the answers match fabric's `llama-laya` tool for the same model.

It needs a fabric runtime that includes Laya (`qvac-fabric` 10549.5.1 or later). On an older runtime, `load()` fails with `model initialization returned a null model/context`.

### Usage

```js
const { LayaDecisions } = require('@qvac/decision-ggml')

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

`load()`, `run()`, `cancel()` and `unload()` behave as in `DecisionEngine`: one request at a time, and `cancel()` stops a running request.

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
| `main-gpu`, `split-mode`, `tensor-split` | | | GPU selection (`main-gpu`: an index or `integrated`/`dedicated`) and multi-GPU split (`split-mode` `none`/`layer`, `tensor-split`) |
| `verbosity`, `openclCacheDir` | | | Native log level `0`–`3`; writable OpenCL kernel cache directory (Android) |

With `opts: { stats: true }`, `response.stats` holds `total_tokens`, `total_time_ms`, `sequences` (one per question and state), `forward_passes`, `batch_size`, `context_size` and `backendDevice`.

### Errors

`load()` rejects with an error whose `code` names the cause:

| `code` | When |
|--------|------|
| `[ Decision :: InvalidArgument ]` | `device` is missing (`must specify a device`) |
| `[ Decision :: InvalidConfiguration ]` | A key outside the list above, a thread count that is not a whole number or exceeds the CPU count, or a `batch_size` too small for even a short sequence |
| `[ Decision :: UnsupportedModel ]` | The GGUF is not a Laya checkpoint (detected before its weights load), or its decision metadata is malformed |
| `[ Decision :: UnableToLoadMetadata ]`, `[ Decision :: UnableToLoadModel ]` | The file cannot be read or loaded, including a Laya model on a fabric runtime without Laya |

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

## Building from source

```bash
npm install
npm run build
```

The native build consumes `@qvac/fabric`'s runtime and the `server-context`
archive its platform package ships (`qvac_addon_link_fabric_server_context()`
in `cmake/qvac-addon`).

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
