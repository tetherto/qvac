# Data flow — `@qvac/classification-ggml`

The addon exposes classification through `ImageClassifier.classify()` and image
embeddings through `MegaLoc.embed()`. Their graphs and outputs are separate.
See [MegaLoc](megaloc.md) for complete usage, GGUF conversion and backend details.

## MegaLoc embedding path

1. `MegaLoc.load()` creates the native instance with `modelType: "megaloc"`,
   then awaits `activate()`. `JsAsyncTask` loads the weights and builds the graph
   on a native worker, so the JS event loop remains responsive.
2. `embed()` serializes an embedding job through the instance queue. The native
   bridge validates JPEG/PNG bytes or packed RGB dimensions and submits it to
   `JobRunner`.
3. `MegaLocModel::process()` decodes, resizes to 322 × 322 and applies ImageNet
   normalization, then runs the transformer and aggregation graph through
   Fabric on the selected CPU/GPU backends.
4. The output is L2-normalized and returned through the typed output handler as
   `Float32Array(8448)`, without labels, softmax or `topK` selection.

`load`, `embed` and `unload` are serialized per instance. `unload()` releases
native resources and permits a later `load()`; `destroy()` is permanent.

## MobileNet classification path

End-to-end trace of a single `classifier.classify(buffer)` call:

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

## MobileNet error paths

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
| GGML CPU backend variant init failure       | `ClassificationModel::load` (C++, Android)    | `StatusError(InternalError)` — "Failed to find/init CPU backend device"; raised when `ggml_backend_load_all_from_path` couldn't enumerate any per-microarch variant in `backendsDir`, or in the directory `@qvac/fabric` ships its backends in when that is omitted |
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

## MegaLoc error paths

| Failure | Where | Surface behaviour |
| --- | --- | --- |
| Missing or invalid GGUF, wrong `general.architecture` | MegaLoc weight loader | `load()` rejects; the architecture must be `megaloc` |
| Unsupported tensor type, shape or truncated data | MegaLoc weight loader | `load()` rejects; supported formats are F16 or F16 body + Q6_K projection |
| Explicit backend unavailable | Fabric backend selection | `load()` rejects rather than selecting another device |
| `topK` on a native embedding job | `AddonJs::runJob` | `InvalidArgument`: `topK is not supported for image embeddings` |
| Invalid image bytes or incomplete raw RGB dimensions | Native input validation/preprocessing | `embed()` rejects; packed RGB requires width, height and three channels |
| Embedding before loading, after unloading or after destruction | MegaLoc JS lifecycle | The returned promise rejects |

These cases are covered by `test/integration/megaloc.test.js` and the MegaLoc
C++ tests. See [model selection and activation](architecture.md#model-selection-and-activation)
for the shared binding and async loading path.

## MobileNet lifecycle

```
new ImageClassifier()
        │
        │ .load()
        ▼
┌──────────────────────────────────────────────┐
│ ClassificationModel::load                    │
│   backend init:                              │
│     desktop  : ggml_backend_cpu_init()       │
│     android  : ggml_backend_load_all_from_   │
│                  path(<backendsDir>/<sub>) → │
│                ggml_backend_dev_by_type(CPU) │
│                  → ggml_backend_dev_init     │
│   weights = loadWeights(gguf, backend)       │
│   graph   = buildGraph(weights, backend)     │
│   loaded  = true                             │
└────────┬─────────────────────────────────────┘
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
