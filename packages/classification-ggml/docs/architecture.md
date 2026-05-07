# Architecture — `@qvac/classification-ggml`

This document describes the architecture of the MobileNetV3-Small 3-class
image classification addon, the GGML compute graph it constructs, and the
rationale for the key implementation choices.

## Component layout

```
+----------------------------------------------+
|  JS: ImageClassifier (index.js)              |
|   - lifecycle (load / classify / unload)     |
|     all serialised via exclusiveRunQueue     |
|   - threads validation fail-fast in ctor     |
|   - createJobHandler + QvacResponse plumbing |
|   - thin pass-through to native validation   |
+----------------------------------------------+
|  JS: ClassificationInterface (addon.js)      |
|   - thin native bridge: createInstance,      |
|     activate, runJob, cancel, unload         |
|   - exports mapAddonEvent for index.js       |
|     (shape-keyed Output / JobEnded routing)  |
+----------------------------------------------+
|  Native: BARE_MODULE (binding.cpp)           |
|   - exports createInstance/runJob/activate… |
+----------------------------------------------+
|  Native: AddonJs (addon/AddonJs.hpp)         |
|   - js <-> C++ bridge                        |
|   - single source of truth for argument      |
|     validation (type / range / shape)        |
|   - packs ClassifyInput (vector<uint8_t> +   |
|     optional<RawRgbDims> + topK)             |
|   - JsClassifyOutputHandler → JS array       |
+----------------------------------------------+
|  Native: AddonCpp  (from @qvac/…-addon-cpp)  |
|   - JobRunner (dedicated worker thread)      |
|   - OutputQueue + OutputCallback plumbing    |
+----------------------------------------------+
|  Native: ClassificationModel (IModel)        |
|   - load(): backend init + weights + graph   |
|     + full-pipeline warmup pass              |
|     desktop/iOS: ggml_backend_cpu_init()     |
|     android   : load_all_from_path(<dir>) +  |
|                 dev_by_type(CPU) + dev_init  |
|   - process(): preprocess → compute → softmax|
+----------------------------------------------+
|  Native: MobileNetGraph                      |
|   - loadWeights(): GGUF → folded BN + FC F32 |
|     (validates mobilenet.num_classes)        |
|   - buildGraph(): static forward compute     |
|     graph wired to pre-allocated buffers     |
|     (asserts ggml_nelements(output) ==       |
|     kNumClasses before allocation)           |
+----------------------------------------------+
|  libggml (CPU backend only, via qvac-fabric) |
|   - desktop/iOS: CPU statically linked into  |
|     the .bare                                |
|   - android: per-microarch CPU MODULE .so    |
|     ships next to the .bare under            |
|     prebuilds/android-arm64/qvac__…/         |
+----------------------------------------------+
```

## MobileNetV3-Small layer list

The graph matches `torchvision.models.mobilenet_v3_small` with the bundled
3-class classifier head. Spatial dimensions start at `224×224` and halve
at each stride-2 layer.

| Stage          | Op                                    | In    | Out   | Spatial |
|----------------|---------------------------------------|-------|-------|---------|
| `features.0`   | Conv2dBN + HardSwish (3×3, s=2)       | 3     | 16    | 112     |
| `features.1`   | InvertedResidual (DW 3×3 s=2, SE, ReLU) | 16 | 16    | 56      |
| `features.2`   | InvertedResidual (exp→72, DW 3×3 s=2, ReLU) | 16 | 24 | 28      |
| `features.3`   | InvertedResidual (exp→88, DW 3×3 s=1, ReLU, +) | 24 | 24 | 28    |
| `features.4`   | InvertedResidual (exp→96, DW 5×5 s=2, SE, HS)  | 24 | 40 | 14     |
| `features.5`   | InvertedResidual (exp→240, DW 5×5 s=1, SE, HS, +) | 40 | 40 | 14  |
| `features.6`   | InvertedResidual (exp→240, DW 5×5 s=1, SE, HS, +) | 40 | 40 | 14  |
| `features.7`   | InvertedResidual (exp→120, DW 5×5 s=1, SE, HS)    | 40 | 48 | 14  |
| `features.8`   | InvertedResidual (exp→144, DW 5×5 s=1, SE, HS, +) | 48 | 48 | 14  |
| `features.9`   | InvertedResidual (exp→288, DW 5×5 s=2, SE, HS)    | 48 | 96 | 7   |
| `features.10`  | InvertedResidual (exp→576, DW 5×5 s=1, SE, HS, +) | 96 | 96 | 7   |
| `features.11`  | InvertedResidual (exp→576, DW 5×5 s=1, SE, HS, +) | 96 | 96 | 7   |
| `features.12`  | Conv2dBN + HardSwish (1×1)            | 96    | 576   | 7       |
| avg-pool       | GlobalAveragePool                     | 576   | 576   | 1       |
| `classifier.0` | Linear + HardSwish                    | 576   | 1024  | 1       |
| `classifier.3` | Linear                                | 1024  | 3     | 1       |

Totals: **34 conv layers** (1 stem + 11 × {1 or 2 1×1 + 1 DW} + 1 tail)
and **2 linear layers** in the classifier. `+` marks the residual add
(applied when `stride == 1` and `inputChannels == outputChannels`).

## GGML graph construction

### Weight loading

`MobileNetGraph::loadWeights()` opens the GGUF file via
`gguf_init_from_file()` and clones every required tensor into a freshly
allocated `ggml_context` that is backed by a CPU backend buffer (allocated
with `ggml_backend_alloc_ctx_tensors`).

Weights are transformed at load time into two layouts:

1. **Raw FP16** (`cloneRaw`) for conv kernels and SE FC kernels — the
   native `ggml_conv_2d` / `ggml_conv_2d_dw` paths accept F16 kernels
   against an F32 input on the CPU backend.
2. **Folded FP32 BN scale/shift** (`cloneAsFp32` + second pass) for every
   BatchNorm layer. At load time we compute:

   ```
   scale_c = weight_c / sqrt(running_var_c + 0.001)
   shift_c = bias_c - running_mean_c * scale_c
   ```

   and store `scale[1,1,C,1]` and `shift[1,1,C,1]` tensors. The forward
   graph then applies BN as a single `ggml_mul` + `ggml_add` broadcast.

This fold avoids 34 × 4 ops (`sub`, `div`, `mul`, `add`) per inference and
sidesteps the classic `eps = 1e-5` mistake by computing the division
exactly once against the GGUF-supplied `0.001`.

Classifier FC weights and biases are promoted to FP32 on load for
numerical stability of the tiny 3-element logits tail.

### Forward graph

`MobileNetGraph::buildGraph()` builds a static graph in a second
`ggml_context` with `no_alloc = true`. The graph is allocated on the
backend once, wiring up:

- `input` tensor `[W=224, H=224, C=3, N=1] F32`
- Stem conv + BN + HardSwish
- 11 `InvertedResidual` blocks (`GraphBuilder::invertedResidual`)
- Tail conv + BN + HardSwish
- Global average pool (`ggml_pool_2d` with kernel == spatial extent)
- Reshape to 1-D (576)
- `classifier.0.weight` linear + bias + HardSwish
- `classifier.3.weight` linear + bias → logits

The graph is captured via `ggml_new_graph_custom` + `ggml_build_forward_expand`.

### Per-inference path

`ClassificationModel::process()`:

1. Preprocess the image buffer to a 224×224×3 FP32 WHCN tensor.
2. `ggml_backend_tensor_set(input, fp32Buffer)` — copies pixels only.
3. `ggml_backend_graph_compute(backend, graph)`.
4. `ggml_backend_tensor_get(output, logits)`.
5. Numerically stable softmax over 3 logits in C++.
6. Build sorted `ClassifyResult` list, apply `topK`, return.

Nothing allocates tensors in the hot path; the only per-call work is the
pixel copy, the compute itself, the 3-element softmax, and label lookup.

## Threading model

- Each `ClassificationModel` instance owns its own `JobRunner` worker
  thread (inherited from `qvac-lib-inference-addon-cpp`), so concurrent
  `classify()` calls are serialized per instance but independent across
  instances — supporting acceptance criterion N6.
- The JS-side `exclusiveRunQueue()` (mirroring `LlmLlamacpp`) further
  serialises `load`, `classify`, and `unload` per `ImageClassifier`
  instance, so a `unload()` racing an in-flight `classify()` queues
  cleanly behind it (and explicitly cancels then fails the in-flight
  request with `Model was unloaded`).
- Per-inference mutex (`ClassificationModel::mutex_`) guards against a
  torn state if a future user bypasses `JobRunner`.
- `ggml_backend_cpu_set_n_threads()` lets the caller tune the CPU compute
  threads on desktop / iOS; default is libggml's
  `std::thread::hardware_concurrency`. **On Android the call is
  `#if !defined(__ANDROID__)`-gated** — the symbol lives inside the
  per-microarch CPU variant `.so` (loaded via `dlopen` per
  `GGML_CPU_ALL_VARIANTS=ON`) rather than in `libggml-base.a`, so the
  `.bare` cannot statically link it. Android falls back to libggml's
  default thread pool. Invalid `threads` values (non-positive integers,
  NaN, wrong type) are still rejected fail-fast at
  `new ImageClassifier(...)` construction on every platform; on Android
  the value is simply ignored at runtime.

## Memory footprint

- Weights on the CPU backend: ≈ `2.94 MB` + ≈ `60 KB` of folded BN scale/
  shift + FP32 classifier FC (≈ `2.5 MB`) ≈ **5.5 MB total** in memory.
- Compute buffer (intermediate activations): single-digit MB for a
  224×224 input — allocated once at `load()` time.
- No heap allocation inside the hot path.

## References

- Howard et al., *Searching for MobileNetV3*, arXiv:1905.02244, 2019.
- `torchvision.models.mobilenet_v3_small` — reference architecture.
- GGML public API: `ggml.h`, `ggml-backend.h`, `ggml-alloc.h`, `gguf.h`.
