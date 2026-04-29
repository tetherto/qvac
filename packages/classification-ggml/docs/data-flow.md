# Data flow — `@qvac/classification-ggml`

End-to-end trace of a single `classifier.classify(buffer)` call.

```
+-------------------------+
|  Caller                 |
|  classifier.classify(   |
|    imageBuffer, opts)   |
+-----------+-------------+
            |  JPEG/PNG/raw RGB bytes + {topK?, width?, height?, channels?}
            v
+-------------------------+
|  ImageClassifier (JS)   |
|  - assertBuffer         |
|  - normaliseDimensionOpts|
|  - magic-byte sniff     |
|  - builds native job    |
|    { type: 'image',     |
|      content: buf, … }  |
+-----------+-------------+
            |
            v
+-------------------------+
|  ClassificationInterface|
|  (addon.js)             |
|  - binding.runJob(…)    |
|  - stores pending {}    |
+-----------+-------------+
            |
            v
+-------------------------+
|  Native binding.cpp     |
|  - resolves addon handle|
|  - calls js::runJob     |
+-----------+-------------+
            |
            v
+-------------------------+
|  AddonJs::runJob        |
|  - packs ClassifyInput  |
|    (vector<uint8_t> +   |
|    raw dims + topK)     |
|  - AddonCpp.runJob(any) |
+-----------+-------------+
            |
            |  ClassifyInput
            v
+-------------------------+
|  JobRunner worker thread|
|  - pops job             |
|  - model->process(any)  |
+-----------+-------------+
            |
            v
+-------------------------+
|  ClassificationModel::  |
|  process()              |
|                         |
|  1) preprocessToTensor  |
|     (stb_image decode + |
|      bilinear resize +  |
|      ImageNet normalize)|
|                         |
|  2) ggml_backend_tensor_|
|     set(input, fp32buf) |
|                         |
|  3) ggml_backend_graph_ |
|     compute(backend, g) |
|                         |
|  4) ggml_backend_tensor_|
|     get(output, logits) |
|                         |
|  5) softmax (C++)       |
|                         |
|  6) build sorted result |
+-----------+-------------+
            |
            |  ClassifyOutput (std::any)
            v
+-------------------------+
|  OutputQueue → Output   |
|  CallbackJs → JS        |
|  _outputCallback(event, |
|   data, error)          |
+-----------+-------------+
            |
            v
+-------------------------+
|  JsClassifyOutputHandler|
|  ClassifyOutput → JS    |
|  Array<{label, confid.}>|
+-----------+-------------+
            |
            v
+-------------------------+
|  ClassificationInterface|
|  resolves pending.      |
+-----------+-------------+
            |
            v
+-------------------------+
|  Caller awaits result   |
|  [{label, confidence}]  |
+-------------------------+
```

## Error paths

| Failure                                  | Where                                         | Surface behaviour |
|------------------------------------------|-----------------------------------------------|-------------------|
| `null` / non-Buffer input                | `assertBuffer` (JS)                           | `TypeError` before native call |
| Empty buffer                             | `assertBuffer` (JS)                           | `Error("Image input buffer is empty")` |
| Unsupported format (BMP, text, …)        | `ImageClassifier.classify` magic-byte check   | `Error("Unsupported image format …")` |
| Corrupted JPEG / PNG                     | `ImagePreprocessor::decodeToRgb` (native)     | `StatusError(InvalidArgument)` surfaced as JS `Error` |
| Raw bytes + bad `width`/`height`/`channels` | `ImagePreprocessor::validateRawRgb`         | `StatusError(InvalidArgument)` |
| Buffer size mismatch (raw input)         | `ImagePreprocessor::validateRawRgb`           | `StatusError(InvalidArgument)` |
| `classify` before `load`                 | `ImageClassifier.classify` (JS)               | `Error("Classifier not loaded…")` |
| `classify` after `unload`                | `ImageClassifier.classify` (JS)               | `Error("Classifier not loaded…")` |
| `ggml_backend_graph_compute` non-success | `ClassificationModel::process`                | `StatusError(Unknown)` |

All errors are wrapped by the existing `qvac-lib-inference-addon-cpp`
error infrastructure and reach the caller as structured JS Errors. Native
code never aborts on bad input — this is validated by the error-case
integration tests in `test/integration/error-cases.test.js`.

## Lifecycle

```
new ImageClassifier()
        │
        │ .load()
        ▼
┌───────────────────────┐
│ ClassificationModel   │
│   backend = cpu_init()│
│   weights = loadWeights(gguf, backend)
│   graph   = buildGraph(weights, backend)
│   loaded  = true      │
└────────┬──────────────┘
         │  many .classify(…) calls — pixel data only per-call
         │
         │ .unload()
         ▼
┌───────────────────────┐
│ destroyInstance()     │
│   ~AddonJs → ~AddonCpp│
│   ~ClassificationModel│
│   ggml_backend_free   │
└───────────────────────┘
```

Repeated load/unload cycles do not leak native handles — validated by
`error-cases.test.js: load -> unload -> load cycles do not leak handles`.
