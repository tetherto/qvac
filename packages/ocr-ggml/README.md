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
| `opts.stats` | `boolean` | | `false` | emit timing stats on `finish` |
| `logger` | `Object` | | `null` | optional `{ info, warn, error, debug }` — receives C++ log lines |

### Methods

- `load(): Promise<void>` — loads both models, registers ggml backends, activates the addon
- `run(input): Promise<QvacResponse>` — serialised; one job at a time
- `unload(): Promise<void>` — frees the addon (destroys ggml contexts + backends)
- `destroy(): Promise<void>` — marks the instance as destroyed (no further use)
- `getState(): InferenceClientState`
- `OcrGgml.getModelKey(): string` — `"ocr-ggml"`, used by the inference manager

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
  numBoxes: number          // total boxes (aligned + unaligned)
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

CI sets these automatically; locally you can:

```bash
OCR_GGML_DETECTOR=$PWD/models/craft_mlt_25k.gguf \
OCR_GGML_RECOGNIZER=$PWD/models/latin_g2.gguf \
npm run test:integration
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
