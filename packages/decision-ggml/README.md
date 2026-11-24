# decision-ggml

Decision models for QVAC: typed questions (`choice`, `score`, `noul`) about a
state, answered with probabilities.

`DecisionEngine` runs upstream llama.cpp decision models (laya, openjev, lev,
kev, clef, ...): any GGUF with `<arch>.decision.*` metadata. Decision parsing,
prompt rendering, scheduling and answer calculation are upstream's: the addon
runs upstream's `server-context` in-process, without an HTTP server, linked
statically from its own build of the `qvac-fabric` port. Models load from a
path and run on the shared `@qvac/fabric` runtime.

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

Each release is built for one `qvac-fabric` port, and loading fails with an
error naming both ports when the `@qvac/fabric` runtime that loads is built
from another one. Install the `@qvac/decision-ggml` release built for that
`@qvac/fabric`.

## Usage

```js
const { DecisionEngine, DECISION_INVALID_REQUEST } = require('@qvac/decision-ggml')

const engine = new DecisionEngine({
  files: { model: ['/models/laya-Q8_0.gguf'] },
  config: { device: 'gpu' }
})
await engine.load()

engine.info() // { decision_type: 'laya', noul: 'probability', score_levels: { min: 2, max: 10 }, ... }

const response = await engine.run({
  state: 'My payment failed twice and I was charged both times.',
  questions: {
    route: {
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      criteria: { support: 'Account and delivery questions', billing: 'Payments and refunds' }
    },
    urgency: { type: 'score', instructions: 'How urgent is this?', criteria: ['not urgent', 'somewhat urgent', 'very urgent'] },
    refund: { type: 'noul', instructions: 'Does the customer ask for a refund?' }
  }
})
const [result] = await response.await()
// result.answers.route.choice, result.answers.urgency.score,
// result.answers.refund.noul, result.usage.input_tokens

await engine.unload()
```

Requests and results use upstream's `/v1/systemone` shapes. `info()` reports
what the loaded model supports; check it before building requests:

- `noul`: what a `noul` answer means: `probability` (of "true"),
  `expected_rating` (lev, normalized to 0..1), or `unknown` for a decision
  type this addon does not list. Treat an `unknown` one as neither.
- `max_input_tokens`: the longest input a request can have, a state with one
  question and its options. For a non-causal model (Laya) it is the batch
  size, and a longer input is rejected with `DECISION_INVALID_REQUEST`. For a
  causal model it is each slot's share of the context, since a request's
  questions and a batch's states run in slots that share one KV cache by
  default; a longer input may still fit when fewer slots are busy, but is not
  promised to.
- `score_levels`: the number of levels a score question may have on this
  model, `{ min, max }` (2 to 10 for most; from 1 for h2o-lightning), or `null`
  when it takes no score questions (openbmb-minicpm-ocr-jev). Upstream's own
  question parser is asked at load, so this follows the model type.
- `score`: what a score answer is, `expected_level` (the expected level,
  Σ i·p(i)) or `median_level` (lfm3-d1 and lfm3-d1-omni: the first level whose
  cumulative probability reaches one half). `null` with `score_levels`.
- `images`, `audio` and the other capabilities.

### Several states

`states` instead of `state` answers several states with the same questions in
one run. They go to upstream concurrently, at most one per slot (`parallel`),
so upstream batches them. `await()` resolves to `[results]`, one result per
state in input order:

```js
const [results] = await (await engine.run({ states: [ticketA, ticketB], questions })).await()
```

The first state that fails fails the run, and its error names it
(`states[1]: ...`). A cancel stops the whole batch.

See [`examples/decisionEngine.js`](./examples/decisionEngine.js) for a runnable
example.

### Config

| Key | Meaning |
| --- | --- |
| `device` | Required: `gpu` or `cpu`. `cpu` keeps every layer and the projector on the CPU. |
| `gpu_layers` | Layers to offload on `gpu`. |
| `ctx_size`, `batch_size`, `ubatch_size` | Context and batch sizes. Unset values are left to upstream (the context fits free device memory), except for a non-causal model (Laya): it reads each question's whole input in one pass, so its micro-batch follows `batch_size`, which is then the longest input (2048 tokens unless set). |
| `threads` | CPU threads, at most the device's CPU count; `0` uses every CPU. |
| `parallel` | Upstream slots, at least 1. Upstream runs a request's questions, option variants and a batch's states over them together; it does not change how many requests the engine accepts at once. Unset, it is llama-server's own default: 4 slots sharing one KV cache, so memory does not grow with them. Set, each slot has its own KV cache, as with llama-server's `-np`. |
| `mmproj` | Projector GGUF, for models that take images or audio. |
| `image_max_megapixels` | Largest image a request may carry, in megapixels (default 50). Checked from the file's header before it is decoded; a larger one is a rejected request. Needs `mmproj`. |
| `audio_max_seconds` | Longest audio a request may carry, in seconds (default 600). Checked against the length the decoder reads, before it allocates the samples; a longer one is a rejected request. Needs `mmproj`. |
| `verbosity` | Native log level, `0` (error) to `3` (debug). |
| `openclCacheDir` | Writable OpenCL kernel cache directory (Android). |

Any other key fails the load. Multi-word keys take either spelling
(`batch_size` or `batch-size`).

### Behavior

- **One request at a time.** A `run()` while another is in flight is rejected;
  queue in JS. A batch (`states`) is one request.
- **Cancellation.** `cancel()` stops the running request at upstream's next
  result poll, and reaches a request even before its run starts. The next
  request runs normally.

### Errors

`load()` rejects with an error whose `code` names the cause:

| `code` | When |
|--------|------|
| `[ Decision :: InvalidConfiguration ]` | A missing or unknown `device`, a key outside the list above, or a value out of range |
| `[ Decision :: UnsupportedModel ]` | The GGUF has no decision metadata, or names a decision type this build does not know (detected from its header, before loading) |
| `[ Decision :: UnableToLoadModel ]` | The file is missing or cannot be loaded |

`run()` rejects a request the model does not accept with
`err.code === DECISION_INVALID_REQUEST`; other failures do not carry that
code. A cancelled run fails with `Job cancelled`. Rejected requests include:

- bad JSON, too many options or an unsupported question type;
- a state, instructions or description nested deeper than 128 levels. Upstream
  counts its own 128 levels from the prompt input it builds, so it can reject
  a value a few levels sooner, depending on the model type and where the value
  sits;
- an input longer than a non-causal model's `max_input_tokens`;
- with a projector, an image or audio file over `image_max_megapixels` or
  `audio_max_seconds`, checked from its header before it is decoded.

## Laya models

[Laya](https://github.com/NandhaKishorM/laya) checkpoints run as upstream
decision models (`modern-bert` with `decision.type` `laya`):

| Checkpoint | Encoder | Use for |
|------------|---------|---------|
| `laya-multilingual` | mmBERT-base | Text in any language, including non-Latin scripts |
| `laya` | ModernBERT-large | English text |
| `laya-typed-decisions` | ModernBERT-large | English text in the workflows it was fine-tuned on (invoice processing, security incidents, customer service, agent traces) |

Pick the checkpoint for the language of the state: the addon does not choose
one for you. The English checkpoints give confident wrong answers on non-Latin
scripts.

GGUF files are converted from the Hugging Face checkpoints with the converter
in [qvac-fabric-llm.cpp](https://github.com/tetherto/qvac-fabric-llm.cpp):

```bash
hf download convaiinnovations/laya-multilingual --local-dir laya-multilingual
python convert_hf_to_gguf.py laya-multilingual --outtype q8_0 --outfile laya-multilingual-Q8_0.gguf
```

Fabric-format Laya files (`general.architecture` `laya`) do not load: convert
the Hugging Face checkpoint instead. Compared with them:

- The fitted temperatures apply as the checkpoint defines them. Fabric-format
  Laya clamps them to [0.5, 5], which flattens the probabilities of `choice`
  questions with 11 or more options.
- Answers have no `answer_confidence` or `action`: upstream's converter drops
  the checkpoint's action head. `confidence` is still reported.
- `laya-multilingual` ships without calibration temperatures, so its
  `confidence` is not calibrated. Choose any threshold you act on from
  measurements on your own data.

## Building from source

```bash
npm install
npm run build
```

The native build links the shared `@qvac/fabric` runtime and builds the
`qvac-fabric` vcpkg port with the `server-context` feature (no GPU backends),
taking only the `server-context` archive from it
(`qvac_addon_link_fabric_server_context()` in `cmake/qvac-addon`). Everything
else `server-context` references comes from the runtime.

The port and the runtime must be the same version: configure fails unless the
installed `@qvac/fabric` was built from the port version this build installs
(its CMake config records it). `package.json` records the port as
`qvac["qvac-fabric"]`, matching the `vcpkg.json` pin. Update the pin, the
record and the `@qvac/fabric` dependency together.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
