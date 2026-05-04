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
|  - lifecycle gates      |
|    (load / classify /   |
|    unload all serialised|
|    via exclusiveRunQueue)|
|  - threads validation   |
|    fail-fast in ctor    |
|  - thin pass-through:   |
|    builds native job    |
|    { type: 'image',     |
|      content: buf,      |
|      width?, height?,   |
|      channels?, topK? } |
+-----------+-------------+
            |
            v
+-------------------------+
|  ClassificationInterface|
|  (addon.js)             |
|  - createInstance once  |
|  - binding.runJob(...)  |
|  - native events fan    |
|    out via mapAddonEvent|
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
|  AddonJs::runJob (C++)  |
|  Single source of truth |
|  for argument validation|
|  - type === 'image'     |
|  - content is TypedArray|
|  - width/height/channels|
|    all-or-nothing trio  |
|  - topK > 0 if provided |
|  - bare-runtime int32   |
|    range checks         |
|  Throws StatusError     |
|  (InvalidArgument) on   |
|  any violation.         |
|  - packs ClassifyInput  |
|    (vector<uint8_t> +   |
|    optional<RawRgbDims> |
|    + topK)              |
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
|  ImageClassifier (JS)   |
|  _job.end() on terminal |
|  → response.await()     |
|    resolves with        |
|    collected[0]         |
+-----------+-------------+
            |
            v
+-------------------------+
|  Caller awaits result   |
|  [{label, confidence}]  |
+-------------------------+
```

## Error paths

| Failure                                     | Where                                         | Surface behaviour |
|---------------------------------------------|-----------------------------------------------|-------------------|
| `null` / non-Buffer / non-Uint8Array input  | `AddonJs::runJob` (C++)                       | `StatusError(InvalidArgument)` — "Image 'content' is required and must be a Uint8Array / Buffer …" |
| Empty buffer                                | `AddonJs::runJob` (C++)                       | `StatusError(InvalidArgument)` — "Image 'content' buffer is empty" |
| Unsupported format (BMP, text, …)           | `ImagePreprocessor::isEncodedImage` (C++)     | `StatusError(InvalidArgument)` — "Unsupported image format: expected JPEG or PNG …" |
| Corrupted JPEG / PNG                        | `ImagePreprocessor::decodeToRgb` (C++)        | `StatusError(InvalidArgument)` surfaced as JS `Error` |
| Raw bytes + missing one of width/height/channels | `AddonJs::runJob` (C++)                  | `StatusError(InvalidArgument)` — "Raw RGB input requires all of 'width', 'height', and 'channels' …" |
| Raw bytes + non-positive width / height     | `AddonJs::runJob` (C++)                       | `StatusError(InvalidArgument)` — "must be a positive integer when passing raw RGB bytes" |
| Raw bytes + channels ≠ 3                    | `AddonJs::runJob` (C++)                       | `StatusError(InvalidArgument)` — "must be exactly 3 (RGB) when passing raw RGB bytes" |
| Buffer size mismatch (raw input)            | `ImagePreprocessor::validateRawRgb` (C++)     | `StatusError(InvalidArgument)` |
| `topK ≤ 0` when provided                    | `AddonJs::runJob` (C++)                       | `StatusError(InvalidArgument)` — "must be a positive integer when provided" |
| Constructor `threads` not a positive int    | `ImageClassifier` constructor (JS)            | `TypeError("'threads' must be a positive integer when provided …")` |
| `classify` before `load`                    | `ImageClassifier._classifyInternal` (JS)      | `Error("Classifier not loaded. Call load() first.")` |
| `classify` after `unload`                   | `ImageClassifier._classifyInternal` (JS)      | same |
| `unload` mid-classify                       | `ImageClassifier.unload` (JS)                 | the in-flight `classify()` promise rejects with `Error("Model was unloaded")` |
| GGUF weights file missing                   | `ImageClassifier._load` (JS)                  | `Error("MobileNet GGUF weights not found at: …")` |
| GGUF `mobilenet.num_classes` mismatch       | `MobileNetGraph::loadWeights` (C++)           | `StatusError(InvalidArgument)` — "does not match the addon's compiled-in class count" |
| Compute graph output shape mismatch         | `MobileNetGraph::buildGraph` (C++)            | `StatusError(InternalError)` — defence-in-depth, never seen in practice |
| `ggml_backend_graph_compute` non-success    | `ClassificationModel::process` (C++)          | `StatusError(InternalError)` |

All errors are wrapped by the existing `qvac-lib-inference-addon-cpp`
error infrastructure and reach the caller as structured JS Errors. Native
code never aborts on bad input — this is validated by the error-case
integration tests in `test/integration/error-cases.test.js` and by the
preprocessor / model unit tests in `test/unit/*.cpp`.

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
