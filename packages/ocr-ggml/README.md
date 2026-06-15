# @qvac/ocr-ggml

GGML-backed OCR addon for [QVAC](https://github.com/tetherto/qvac).
Provides two inference pipelines on **`ggml` / `.gguf`** — no Python, no
PyTorch, and no ONNX Runtime at runtime:

| Pipeline | Detector | Recognizer | Notes |
|---|---|---|---|
| `easyocr` (default) | CRAFT | CRNN gen-2 (English / Latin) | Port of [EasyOCR](https://github.com/JaidedAI/EasyOCR) |
| `doctr` | DBNet (MobileNetV3-Large) | CRNN (MobileNetV3-Small) | Port of [doctr](https://github.com/mindee/doctr) |

Select the pipeline at construction time via `params.pipelineType`
(default `'easyocr'`). Both pipelines emit the same output shape.

Sibling of [`@qvac/ocr-onnx`](../ocr-onnx). Same input/output shape, same
public surface — only the inference engine differs.

| | `@qvac/ocr-onnx` | `@qvac/ocr-ggml` |
|---|---|---|
| Inference backend | ONNX Runtime | GGML |
| Weight format | `.onnx` | `.gguf` |
| Pre/post-processing | C++ + OpenCV (EasyOCR) | C++ + OpenCV (EasyOCR + doctr, lifted) |
| Quantization | per-EP (limited) | block-quantized (Q8_0, Q4_K, …) out of the box |
| Pipelines | EasyOCR | EasyOCR + Doctr |

The C++ implementation is lifted from
[`EasyOcr-ggml`](https://github.com/tetherto/easy-ocr-ggml); GGML is pulled
from `qvac-fabric` (instead of the upstream submodule), matching how the
sibling `translation-nmtcpp` addon consumes ggml.

## Install

```bash
npm install @qvac/ocr-ggml
```

The package ships a Bare addon. Build prerequisites (clang-22, libc++,
vcpkg, bare-make) match the rest of the QVAC monorepo — see the
[root README](../../README.md) for the canonical setup.

```bash
cd packages/ocr-ggml
npm install
bare-make generate
bare-make build
bare-make install   # produces prebuilds/
```

## Usage

```js
const { OcrGgml } = require('@qvac/ocr-ggml')

const ocr = new OcrGgml({
  params: {
    pathDetector: '/abs/path/craft_mlt_25k.gguf',
    pathRecognizer: '/abs/path/english_g2.gguf',
    langList: ['en'],
    magRatio: 1.5
  },
  opts: { stats: true }
})

await ocr.load()

const response = await ocr.run({
  path: '/abs/path/photo.jpg',
  options: { paragraph: false }
})

response.onUpdate(rows => {
  for (const [box, text, conf] of rows) {
    console.log(`[${conf.toFixed(2)}] ${text}`, box)
  }
})

const stats = await response.await()
console.log(stats)

await ocr.unload()
```

### Quickstart example

```bash
bare examples/quickstart.js \
  --image samples/english.png \
  --detector models/craft_mlt_25k.gguf \
  --recognizer models/english_g2.gguf \
  --lang en
```

## API

### `new OcrGgml({ params, opts?, logger? })`

| Field | Type | Required | Default | Description |
|---|---|:-:|---|---|
| `params.pathDetector` | `string` | ✓ | — | detector `.gguf` (CRAFT for `easyocr`, DBNet for `doctr`) |
| `params.pathRecognizer` | `string` | ✓ | — | recognizer `.gguf` (`english_g2`/`latin_g2` for `easyocr`, doctr CRNN for `doctr`) |
| `params.langList` | `string[]` | ✓ | — | language codes (`['en']`, `['en','fr']`, …) — used by `easyocr`, ignored by `doctr` |
| `params.pipelineType` | `'easyocr'` \| `'doctr'` | | `'easyocr'` | which pipeline backs the addon |
| `params.magRatio` | `number` | | `1.5` | CRAFT input-image magnification (`easyocr` only) |
| `params.defaultRotationAngles` | `number[]` | | `[90, 270]` | rotations tried on low-confidence boxes (`easyocr` only) |
| `params.contrastRetry` | `boolean` | | `false` | retry low-confidence boxes with contrast adjustment (`easyocr` only) |
| `params.lowConfidenceThreshold` | `number` | | `0.4` | retry threshold (`easyocr` only) |
| `params.recognizerBatchSize` | `number` | | `32` | recognizer batch size (`easyocr` only) |
| `params.nThreads` | `number` | | `0` (auto) | CPU thread count for GGML; `<0` leaves the GGML default |
| `params.backendsDir` | `string` | | `<package>/prebuilds` | directory holding `libggml-*.so` backend shared libs |
| `params.backendDevice` | `'cpu'` \| `'vulkan'` \| `'metal'` | | `'cpu'` | ggml backend device. `'vulkan'` (Linux/Windows/Android) and `'metal'` (Apple) opt in to GPU inference with transparent CPU fallback — see [Backend device](#backend-device-cpu--vulkan--metal) |
| `params.gpuDevice` | `number` | | _prefer discrete_ | 0-based index into the matching GPU/iGPU devices for `'vulkan'`/`'metal'`; out-of-range → CPU fallback — see [Selecting a specific GPU](#selecting-a-specific-gpu-gpudevice) |
| `opts.stats` | `boolean` | | `false` | emit timing stats on `finish` |
| `logger` | `Object` | | `null` | optional `{ info, warn, error, debug }` — receives C++ log lines |

### Methods

- `load(): Promise<void>` — loads both models, registers ggml backends, activates the addon
- `run(input): Promise<QvacResponse>` — serialised; one job at a time
- `unload(): Promise<void>` — frees the addon (destroys ggml contexts + backends)
- `destroy(): Promise<void>` — marks the instance as destroyed (no further use)
- `getState(): InferenceClientState`
- `getBackendInfo(): BackendInfo | null` — backend device resolved at `load()` (`{ requested, backendDevice, backendName, deviceIndex, backendDescription, fallbackReason }`); `null` before `load()` / after `unload()`. `deviceIndex` is the ggml device index of the selected device (or `-1` on CPU); `backendDescription` is the human-readable model (e.g. `'NVIDIA GeForce RTX 4090'`, `'Apple M3'`)
- `OcrGgml.getModelKey(): string` — `"ocr-ggml"`, used by the inference manager

### Backend device (CPU / Vulkan / Metal)

By default inference runs on the **CPU** ggml backend, which is always
available. Set `params.backendDevice` to `'vulkan'` (Linux/Windows/Android) or
`'metal'` (Apple) to opt in to GPU inference:

```js
const ocr = new OcrGgml({
  params: {
    pathDetector: '/abs/path/craft_mlt_25k.gguf',
    pathRecognizer: '/abs/path/english_g2.gguf',
    langList: ['en'],
    backendDevice: 'metal'   // 'cpu' (default) | 'vulkan' | 'metal'
  }
})
await ocr.load()
console.log(ocr.getBackendInfo())
// Vulkan available → { requested: 'vulkan', backendDevice: 'GPU', backendName: 'Vulkan0', deviceIndex: 1, backendDescription: 'NVIDIA GeForce RTX 4090', fallbackReason: '' }
// no Vulkan device → { requested: 'vulkan', backendDevice: 'CPU', backendName: 'CPU', deviceIndex: -1, backendDescription: '…', fallbackReason: 'Vulkan backend requested but no Vulkan-capable GPU device was found; falling back to CPU' }
// Metal available  → { requested: 'metal',  backendDevice: 'GPU', backendName: 'MTL0', deviceIndex: 1, backendDescription: 'Apple M3 Ultra', fallbackReason: '' }  // device name; 'MTL1'… on a multi-GPU host
// no Metal device  → { requested: 'metal',  backendDevice: 'CPU', backendName: 'CPU', deviceIndex: -1, backendDescription: '…', fallbackReason: 'Metal backend requested but no Metal-capable GPU device was found; falling back to CPU' }
```

Behaviour and expectations:

- **Transparent CPU fallback.** When `'vulkan'` / `'metal'` is requested but no
  matching GPU device is registered, the pipeline falls back to CPU and
  records a non-empty `fallbackReason` (also reflected by the numeric
  `backendIsGpu` stat). It never silently does the wrong thing.
- **Required backend libs.** Vulkan execution needs the `libggml-vulkan`
  backend shared library (`libggml-vulkan.so` / `.dll` / `.dylib`) present in
  `backendsDir` (default `<package>/prebuilds/<target>/`), plus a working
  Vulkan driver/ICD and a Vulkan-capable GPU on the host. **Metal** is compiled
  into the addon (no extra shared library), and is available whenever ggml was
  built with the qvac-fabric `gpu-backends` feature (the default on Apple).
  These GPU backends are only produced on platforms/feature sets where the
  upstream ggml port builds them; on other hosts the request quietly falls back
  to CPU.
- **DocTR recognizer.** Only the MobileNetV3 feature-extractor graph runs on
  the selected ggml device; the recognizer's downstream LSTM + linear
  classifier always run on CPU (plain C++, no ggml graph), regardless of
  `backendDevice`.
- **Threads.** `nThreads` only affects the CPU backend; it is ignored when a
  Vulkan or Metal device is selected.
- **Performance guidance (Metal).** The win depends on the detector. The
  EasyOCR pipeline's CRAFT detector is dense-convolution and benefits strongly
  from the GPU (≈4.5× faster on Metal on an Apple M3 Ultra vs CPU). The DocTR
  detector is MobileNetV3 (depthwise-separable convolutions) — a low-arithmetic
  -intensity, GPU-unfriendly workload that runs *slower* on Metal than on CPU;
  output is identical either way. Recommended default: **EasyOCR → `'metal'`,
  DocTR → `'cpu'`** on Apple. Since `backendDevice` is per-instance, you can mix
  both. (Numbers are workload/hardware dependent — measure for your case.)

### Selecting a specific GPU (`gpuDevice`)

On a host with more than one GPU (e.g. a discrete GPU plus an integrated GPU,
or two discrete GPUs) the backend resolves which device to use as follows:

- **Default (no `gpuDevice`): prefer discrete.** Selection enumerates every
  GPU/iGPU device that matches the requested backend (Vulkan or Metal) and
  picks the first **discrete** GPU (`GGML_BACKEND_DEVICE_TYPE_GPU`); if none is
  discrete it uses the first **integrated** GPU. This avoids accidentally
  pinning inference to a weaker iGPU on laptops/APUs.
- **Explicit `gpuDevice: N`.** Pass a 0-based index to pin a specific device.
  The index counts only the **matching** devices, in ggml enumeration order
  (so `gpuDevice: 0` is the first matching device, `gpuDevice: 1` the second,
  …). An **out-of-range** index transparently falls back to CPU and records a
  `fallbackReason` naming the requested index and how many matching devices
  were found. The resolved ggml device index is reported as
  `getBackendInfo().deviceIndex` (and `-1` on CPU).

```js
const ocr = new OcrGgml({
  params: {
    pathDetector: '/abs/path/craft_mlt_25k.gguf',
    pathRecognizer: '/abs/path/english_g2.gguf',
    langList: ['en'],
    backendDevice: 'vulkan',
    gpuDevice: 1            // pin the 2nd matching Vulkan device
  }
})
await ocr.load()
console.log(ocr.getBackendInfo())
// → { requested: 'vulkan', backendDevice: 'GPU', backendName: 'Vulkan1',
//     deviceIndex: 1, backendDescription: 'NVIDIA GeForce RTX 4090', fallbackReason: '' }
// out-of-range gpuDevice (e.g. 99) →
//   { requested: 'vulkan', backendDevice: 'CPU', backendName: 'CPU', deviceIndex: -1,
//     backendDescription: '…',
//     fallbackReason: 'Vulkan backend requested with gpuDevice index 99 but only N matching device(s) were found; falling back to CPU' }
```

`gpuDevice` applies to **both** Vulkan and Metal (the prefer-discrete default
and the index selection share one code path).

- **Interim env lever (`GGML_VK_VISIBLE_DEVICES`).** For pinning or reordering
  Vulkan devices *without code*, ggml's Vulkan backend honours the
  `GGML_VK_VISIBLE_DEVICES` environment variable — a comma-separated list of
  device indices (e.g. `GGML_VK_VISIBLE_DEVICES=1,0`) that restricts and
  reorders the Vulkan devices ggml exposes. Because this is applied by ggml
  *before* the addon enumerates devices, it composes with `gpuDevice`: the
  addon's index counts the (already filtered/reordered) visible devices. Use it
  as an interim lever (e.g. in CI or a launcher script) when you cannot pass
  `gpuDevice` through the API. It does not affect Metal.

### Kernel precision (`OCR_GGML_CRAFT_KERNEL_F32/F16` / `OCR_GGML_CRNN_KERNEL_F32/F16`)

The EasyOCR pipeline can store its convolution kernels as **F16** in the
weights buffer, which lets ggml take the faster F16 im2col→GEMM conv path (and
run on GPU backends). Kernels are cast F32→F16 at model-load time from the F32
GGUF — no separate F16 model file is needed, and biases plus the
BatchNorm-fold math stay F32 (the recognizer's LSTM / linear / Prediction
weights also stay F32).

F16 only helps where the **resolved backend** has a fast F16 GEMM, so the
default is **backend-aware** (decided at model-load time from the selected ggml
device):

| Resolved backend / device | Default |
|---|---|
| GPU / iGPU with fast F16 (NVIDIA, Apple Metal, Intel, AMD…) | **F16** |
| Mali GPU (Vulkan) | **F32** (its F16 GEMM is ~4× slower) |
| Apple-Silicon CPU (native FP16) | **F16** |
| Other CPUs — x86, non-Apple ARM (F16 emulated) | **F32** |

> Adreno Vulkan is already skipped by backend selection (it runs on CPU), so it
> follows the CPU rule above.

Per-pipeline env vars override the backend-aware default (read once when the
model is loaded; only the exact value `1` applies; `_F32` wins if both are set):

| Env var | Affects | Effect |
|---|---|---|
| `OCR_GGML_CRAFT_KERNEL_F32=1` | CRAFT **detector** conv kernels | force F32 |
| `OCR_GGML_CRAFT_KERNEL_F16=1` | CRAFT **detector** conv kernels | force F16 |
| `OCR_GGML_CRNN_KERNEL_F32=1` | CRNN gen-2 **recognizer** feature-extractor conv kernels | force F32 |
| `OCR_GGML_CRNN_KERNEL_F16=1` | CRNN gen-2 **recognizer** feature-extractor conv kernels | force F16 |

These are useful for A/B-benchmarking the F16 fast path or bisecting an accuracy
regression. None of them affect the DocTR pipeline.

### 1×1 conv path (backend-aware; `OCR_GGML_CONV1X1_MULMAT` / `OCR_GGML_CONV1X1_CONV2D`)

A 1×1 convolution is a per-pixel linear map over channels — i.e. a plain matrix
multiply. The EasyOCR pipeline can run a **1×1, stride-1, no-padding** conv
either through `ggml_conv_2d` (im2col → GEMM) or a direct `ggml_mul_mat` that
skips the im2col lowering and its materialised buffer. This mainly affects the
CRAFT detector's 1×1 convs (the `upconv*.conv.0` legs, `basenet.slice5.2`, and
`conv_cls.6/.8`).

Skipping im2col helps GPU GEMM backends but adds permute/cont overhead that does
not pay off on CPU, so the default is **backend-aware**, resolved once at
model-load time (mirrors the F16 kernel decision):

| Resolved backend | 1×1 conv default |
|---|---|
| GPU / accelerator (NVIDIA Vulkan, Apple Metal, Mali Vulkan) | **`mul_mat`** (~−19% total / −43% detection on NVIDIA, ~−10% on Metal, ~neutral on Mali — output verified identical) |
| **Adreno** on **Vulkan** | **`conv_2d`** — Adreno's Vulkan compute is numerically fragile (and is already auto-skipped to CPU). Keyed on the backend API, so a future Adreno-OpenCL backend is not affected. |
| Any CPU (x86, Apple-Silicon, non-Apple ARM) | **`conv_2d`** (`mul_mat` is neutral-to-slower there) |

Two env vars override the default (read once at model load; only the exact value
`1` applies; `CONV2D` wins if both are set):

| Env var | Effect |
|---|---|
| `OCR_GGML_CONV1X1_MULMAT=1` | force the `mul_mat` path on every backend |
| `OCR_GGML_CONV1X1_CONV2D=1` | force the `ggml_conv_2d` path on every backend |

These are useful for A/B-benchmarking the two paths or as an escape hatch if a
backend's `mul_mat` path ever misbehaves. They do not affect the DocTR pipeline.

### Conv bias broadcast (`OCR_GGML_CRAFT_BIAS_REPEAT`)

Each convolution adds a per-output-channel bias. By default the EasyOCR
pipeline adds the `[OC]` bias via `ggml_add`'s implicit broadcast
(`ggml_add(x, bias_reshaped[1,1,OC,1])`), so the `[W,H,OC,N]` activation never
has to materialise a full repeated copy of the bias — a small memory/op saving
on every conv. This is numerically identical to the older `ggml_repeat` path
(`ggml_add` broadcasts its second operand on CPU/Vulkan/Metal; verified equal on
all three and ~8-15% faster on CPU).

Set `OCR_GGML_CRAFT_BIAS_REPEAT=1` to fall back to the legacy `ggml_repeat`
broadcast — an escape hatch to recover without a code change if a backend's
broadcast-add ever misbehaves (read once at graph-build time; only the exact
value `1` enables it). It does not affect the DocTR pipeline.

### `run(input)` shape

```ts
{
  path: string,                    // JPEG / PNG / BMP file
  options?: {
    paragraph?: boolean,           // merge nearby boxes
    boxMarginMultiplier?: number,  // padding around boxes
    rotationAngles?: number[]      // override defaults for this call
  }
}
```

Output rows (delivered via `response.onUpdate`):

```ts
type InferredText = [
  [[number, number], [number, number], [number, number], [number, number]],  // 4-point box
  string,                                                                    // text
  number                                                                     // confidence [0..1]
]
```

This is byte-for-byte the same shape `@qvac/ocr-onnx` returns.

### Stats (when `opts.stats=true`)

```ts
{
  totalTime: number,        // seconds
  detectionTime: number,    // seconds (CRAFT inference)
  recognitionTime: number,  // seconds (CRNN inference)
  numBoxes: number,         // total boxes (aligned + unaligned)
  backendIsGpu: number      // 1 if inference ran on a GPU (Vulkan/Metal) device, else 0
}
```

## Models

The addon consumes GGUF weight files. Each pipeline expects its own
detector + recognizer pair:

### EasyOCR pipeline (`pipelineType: 'easyocr'`)

| GGUF | Role |
|---|---|
| `craft_mlt_25k.gguf` / `*_q8_0.gguf` / `*_q4_k.gguf` | CRAFT detector |
| `english_g2.gguf` / `*_q8_0.gguf` / `*_q4_k.gguf` | English recognizer (gen-2) |
| `latin_g2.gguf` | Latin-script recognizer (gen-2; fr/de/it/es/pt/…) |

Use the converter in the upstream
[`tetherto/easy-ocr-ggml`](https://github.com/tetherto/easy-ocr-ggml/blob/main/scripts/pth_to_gguf.py)
repo (`scripts/pth_to_gguf.py`) to produce these from EasyOCR PyTorch
`.pth` checkpoints.

This first release ships the **gen-2 recognizer family only** (English /
Latin). Other language groups (Arabic, Bengali, Cyrillic, Devanagari, CJK)
will land as GGUFs are produced.

### Doctr pipeline (`pipelineType: 'doctr'`)

| GGUF | Role |
|---|---|
| `db_mobilenet_v3_large.gguf` | DBNet detector (MobileNetV3-Large backbone) |
| `crnn_mobilenet_v3_small.gguf` | doctr recognizer (MobileNetV3-Small backbone) |

Doctr is language-agnostic: it recognises any Latin-script text the
underlying CRNN was trained on, so it ignores `langList`, `magRatio` and
the contrast-retry / rotation knobs.

### CI distribution

CI pulls pinned snapshots of both the EasyOCR and Doctr GGUFs from S3
(see [`.github/workflows/integration-test-ocr-ggml.yml`](../../.github/workflows/integration-test-ocr-ggml.yml))
and exposes them to the integration suite via the
`OCR_GGML_DETECTOR` + `OCR_GGML_RECOGNIZER` env vars (EasyOCR) and
`OCR_GGML_DOCTR_DETECTOR` + `OCR_GGML_DOCTR_RECOGNIZER` env vars
(Doctr). Both pipelines are exercised end-to-end on every PR.

## CLI

A development-time CLI ships at the package root, `ocr-ggml-cli`, modelled
on `@qvac/translation-nmtcpp`'s `nmt-cli`. It is **not** included in the
npm artifact (same convention as `nmt-cli`); run it directly from the
repository checkout:

```bash
# Default: OCR samples/english.png with bundled English weights (easyocr)
bare ocr-ggml-cli

# Doctr pipeline (DBNet detector + doctr recognizer)
bare ocr-ggml-cli --pipeline-type doctr \
                  --detector models/db_mobilenet_v3_large.gguf \
                  --recognizer models/crnn_mobilenet_v3_small.gguf \
                  --image /tmp/photo.jpg

# Detail mode (index + confidence + box per recognised line)
bare ocr-ggml-cli --detail 1

# JSON output (matches EasyOCR Python's readtext shape)
bare ocr-ggml-cli --output-format json | jq .

# Custom image + Q8_0 quantized EasyOCR models
bare ocr-ggml-cli --image /tmp/photo.jpg \
                  --detector models/craft_mlt_25k_q8_0.gguf \
                  --recognizer models/english_g2_q8_0.gguf

# Force a specific CPU thread count, with verbose C++ logs
bare ocr-ggml-cli --n-threads 8 --verbose

# Show help / version
bare ocr-ggml-cli --help
bare ocr-ggml-cli --version
```

The CLI is functionally equivalent to upstream `EasyOcr-ggml`'s `ocr-cli`
binary — same flag surface (`--image`, `--detector`, `--recognizer`,
`--lang`, `--paragraph`, `--mag-ratio`, `--detail`, `--output-format`,
`--n-threads`) plus `--pipeline-type {easyocr,doctr}` for the second
pipeline, and the `nmt-cli` ergonomics (env-var fallbacks
`OCR_GGML_{IMAGE,DETECTOR,RECOGNIZER,PIPELINE_TYPE}`, `-h/--help`,
`-v/--version`, `--verbose` for C++ log forwarding). One deliberate
omission for v1: `--debug-png` (annotated overlay) — print boxes via
`--detail 1` or `--output-format json` and render externally instead.

## Scripts

| Script | Purpose |
|---|---|
| [`scripts/check_ggml_backends.sh`](./scripts/check_ggml_backends.sh) | Probe shipped ggml backends + BLAS/Vulkan/OpenCL paths in `prebuilds/` |

Full usage in [`scripts/README.md`](./scripts/README.md). For weight
conversion (PyTorch `.pth` → GGUF), use the upstream converter in
[`tetherto/easy-ocr-ggml`](https://github.com/tetherto/easy-ocr-ggml/blob/main/scripts/pth_to_gguf.py).

## Testing

```bash
npm run lint
npm run test:unit          # JS unit tests (no models required)
npm run test:integration   # end-to-end smoke; soft-skips when models absent
npm run test:cpp           # C++ GoogleTest (BUILD_TESTING=ON)
```

The integration smoke test reads the following env vars and runs each
case only when the corresponding GGUFs are present on disk:

| Env var | Pipeline | Required for which test |
|---|---|---|
| `OCR_GGML_DETECTOR` | EasyOCR | EasyOCR case |
| `OCR_GGML_RECOGNIZER` | EasyOCR | EasyOCR case (CI uses `latin_g2.gguf`) |
| `OCR_GGML_DOCTR_DETECTOR` | Doctr | Doctr case |
| `OCR_GGML_DOCTR_RECOGNIZER` | Doctr | Doctr case |
| `OCR_GGML_IMAGE` | — | overrides the default sample image |
| `OCR_GGML_BACKEND` | — | manual ggml backend override for the whole suite: `cpu` or `vulkan` (otherwise auto-detected, see below) |

CI sets these automatically; locally you can:

```bash
OCR_GGML_DETECTOR=$PWD/models/craft_mlt_25k.gguf \
OCR_GGML_RECOGNIZER=$PWD/models/latin_g2.gguf \
npm run test:integration
```

### Running the suite on Vulkan (GPU)

The harness **auto-detects** the backend. When the package ships a
`ggml-vulkan` backend lib in `prebuilds/` (as the merged desktop CI prebuilds
do), the whole integration suite — every EasyOCR + DocTR case, with the same
expected-text / quality assertions as CPU — automatically runs through the
ggml Vulkan backend. This means the existing desktop `test-<platform>-<arch>`
integration job exercises Vulkan on the Vulkan-capable GPU runner (e.g.
`qvac-ubuntu2404-x64-gpu`) with no separate CI job.

On a host without a Vulkan-capable GPU (or without the `ggml-vulkan` backend
lib — e.g. local dev with unmerged prebuilds), the suite stays on CPU: when no
lib is present it never requests Vulkan, and when the lib is present but no GPU
is available the request transparently falls back to CPU. Either way the suite
still passes, and the recorded `execution_provider` reflects the backend
actually used (driven by the `backendIsGpu` stat), not the request.

`OCR_GGML_BACKEND` remains a manual override that takes precedence over
auto-detection — force the GPU path (or force CPU) with:

```bash
OCR_GGML_BACKEND=vulkan \
OCR_GGML_DETECTOR=$PWD/models/craft_mlt_25k.gguf \
OCR_GGML_RECOGNIZER=$PWD/models/latin_g2.gguf \
npm run test:integration
```

### Android Vulkan (mobile suite)

Android is the primary mobile Vulkan target, and the `android-arm64` prebuild
ships the Vulkan backend lib (`libqvac-ggml-vulkan.so`). The mobile suite runs
on AWS Device Farm (see `test/mobile/test-groups.json`), where the harness
defaults to **CPU** — so a dedicated test,
[`test/integration/android-vulkan.test.js`](./test/integration/android-vulkan.test.js)
(`runAndroidVulkanTest`, in the `android` → `regularB` shard), explicitly
requests `backendDevice: 'vulkan'`. It asserts the addon either runs on a
Vulkan device or reports an explicit CPU fallback, **and** — whichever backend
is resolved — that the OCR output is correct (an accuracy gate, not just an
"it executed" check). The test runs only on Android and is a clean skip on
desktop and iOS (iOS has no Vulkan).

> **Adreno caveat.** Adreno Vulkan is numerically broken (cos-sim ~0.73 vs
> reference on Adreno 830 / Galaxy S25, while Mali / Metal / NVIDIA sit above
> 0.999 — see `vla-ggml`). `OcrBackendSelection` therefore **auto-skips Adreno
> GPUs for Vulkan** and falls back to CPU (an explicit `gpuDevice` index still
> overrides this to force an Adreno device on purpose). The accuracy gate above
> is the backstop that catches a numerically-broken Vulkan device that slips
> through.

### CPU-vs-Vulkan benchmark

The `Benchmark Performance (OCR-GGML)` workflow reuses the integration suites,
which already record **both** a Vulkan (`[GPU]`) and a forced-CPU (`[CPU]`) pass
for each test on a GPU host (`runOcrComparison` / `runDoctrComparison`, tagged
via the `backendIsGpu` stat). The shared perf-report aggregator
(`scripts/perf-report/aggregate.js`) pairs those rows per device + test and
renders a **"CPU → Vulkan Speedup"** section (markdown + HTML) showing
`speedup = CPU mean / Vulkan mean` for total / detection / recognition time.
The section only appears when a test ran on both backends, so non-GPU runs are
unaffected.

On mobile, Android also attempts Vulkan (see below); Mali devices (e.g. Pixel)
fill the GPU column, while Adreno devices auto-fall-back to CPU. To compare
**output quality** (not just speed) across backends, the Python quality
benchmark takes a `--backend` flag:

```bash
python benchmarks/quality_eval/benchmark_100.py \
  --pipeline easyocr \
  --detector models/craft_mlt_25k.gguf \
  --recognizer models/latin_g2.gguf \
  --backend vulkan   # cpu (default) | vulkan — falls back to CPU when unavailable
```

## Repository layout

```
packages/ocr-ggml/
├── package.json             # @qvac/ocr-ggml (bare addon)
├── CMakeLists.txt           # bare_module(ocr-ggml), links ggml + opencv4
├── vcpkg.json               # ggml from qvac-fabric, opencv4, inference-addon-cpp
├── vcpkg-configuration.json
├── vcpkg/                   # custom triplets + toolchains
├── ocr-ggml-cli             # dev-time CLI (mirrors nmt-cli), not shipped to npm
├── binding.js               # require.addon() entry
├── index.js, index.d.ts     # public JS surface (OcrGgml class)
├── ocr-ggml.js              # thin wrapper over the bare binding
├── addonLogging.{js,d.ts}   # setLogger / releaseLogger surface
├── lib/error.js             # QvacErrorAddonOcrGgml + ERR_CODES
├── examples/quickstart.js   # JS code example
├── samples/                 # sample fixture images (english.png, …)
├── scripts/                 # check_ggml_backends.sh diagnostic
├── test/{unit,integration}
└── addon/src/
    ├── js-interface/binding.cpp                  # BARE_MODULE entry
    ├── addon/AddonJs.hpp                         # createInstance / runJob / output handler
    ├── model-interface/
    │   ├── OcrTypes.hpp                          # shared OcrInput/OcrConfig + PipelineMode enum
    │   └── Pipeline.{hpp,cpp}                    # unified IModel adapter (EasyOCR + DocTR via mode)
    ├── ggml/                                     # gguf_loader, ops, craft, crnn, weights (lifted)
    ├── pipeline/                                 # lang, steps, step_* (EasyOCR; lifted)
    ├── easyocr-ggml/                             # headers for the EasyOCR lifted code
    └── doctr-ggml/                               # MobileNetGraph + DBNet/CRNN steps
```

## Provenance

- **C++ pipeline + GGML graph code** lifted from
  [`tetherto/easy-ocr-ggml`](https://github.com/tetherto/easy-ocr-ggml)
  (Apache-2.0).
- **Build / addon plumbing** modelled on
  [`@qvac/translation-nmtcpp`](../translation-nmtcpp) (ggml from
  `qvac-fabric`, `cmake-bare` + `cmake-vcpkg`, `inference-addon-cpp` base
  classes).
- **Public JS surface** modelled on
  [`@qvac/ocr-onnx`](../ocr-onnx) so callers can swap engines transparently.

## License

Apache-2.0 (matches upstream EasyOCR, `EasyOcr-ggml`, `@qvac/ocr-onnx`, and
`@qvac/translation-nmtcpp`).
