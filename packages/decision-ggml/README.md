# decision-ggml

Decision models for QVAC: typed questions (`choice`, `score`, `noul`) about a
state, answered with probabilities.

`DecisionEngine` runs upstream llama.cpp decision models (laya, openjev, lev,
kev, clef, ...): any GGUF with `<arch>.decision.*` metadata. Decision parsing,
prompt rendering, scheduling and answer calculation are upstream's: the addon
runs upstream's `server-context` in-process, without an HTTP server, linked
statically from `@qvac/fabric`. Models load from a path and run on the shared
`@qvac/fabric` runtime.

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

Requests and results use upstream's `/v1/systemone` shapes, one state per run.
`info()` reports what the loaded model supports; check it before building
requests (for example, lev's `noul` is an expected rating, not a probability).

See [`examples/decisionEngine.js`](./examples/decisionEngine.js) for a runnable
example.

### Config

| Key | Meaning |
| --- | --- |
| `device` | Required: `gpu` or `cpu`. `cpu` keeps every layer and the projector on the CPU. |
| `gpu_layers` | Layers to offload on `gpu`. |
| `ctx_size`, `batch_size`, `ubatch_size` | Context and batch sizes. Unset values are left to upstream (the context fits free device memory). |
| `threads` | CPU threads, at most the device's CPU count; `0` uses every CPU. |
| `parallel` | Upstream slots, at least 1. Upstream schedules a request's questions and option variants over them; it does not change how many requests run at once. |
| `mmproj` | Projector GGUF, for models that take images or audio. |
| `verbosity` | Native log level, `0` (error) to `3` (debug). |
| `openclCacheDir` | Writable OpenCL kernel cache directory (Android). |

Any other key fails the load. Multi-word keys take either spelling
(`batch_size` or `batch-size`).

### Behavior

- **One request at a time.** A `run()` while another is in flight is rejected;
  queue in JS.
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

`run()` rejects a request the model does not accept (bad JSON, too many
options, an unsupported question type, nesting deeper than 128 levels, ...)
with `err.code === DECISION_INVALID_REQUEST`; other failures do not carry that
code. A cancelled run fails with `Job cancelled`.

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

The native build consumes `@qvac/fabric`'s runtime and the `server-context`
archive its platform package ships (`qvac_addon_link_fabric_server_context()`
in `cmake/qvac-addon`).

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
