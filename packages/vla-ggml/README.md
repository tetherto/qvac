# @qvac/vla-ggml

**Technology Stack:** C++20, CMake, vcpkg, Bare Runtime, ggml
**Package Type:** Native Bare addon

A vision-language-action (VLA) inference addon for the Bare runtime, running
the [SmolVLA](https://huggingface.co/HuggingFaceVLA/smolvla_libero) model on
ggml. Given a pair of camera frames and a natural-language instruction, it
produces a chunk of robot actions ready to dispatch to a manipulator.

## Key Features

- **SmolVLA inference on ggml** — full pipeline: SigLIP-B/16 vision encoder,
  SmolLM2 language tower, action expert, and 10-step flow-matching ODE.
- **Cross-platform GPU acceleration** — Vulkan on Linux/Windows/Android-Mali,
  Metal on Apple, OpenCL on Adreno 800+, CPU fallback everywhere else. On
  Adreno the backend selector picks OpenCL (the path Qualcomm/qvac-fabric
  actively maintain) and skips Vulkan because the Adreno Vulkan driver
  produces numerically incorrect ggml output; older Adreno (< 800) falls
  back to CPU. See `addon/src/utils/BackendSelection.cpp`.
- **Q8_0-quantized vision encoder** — vision-tower linear weights ship as Q8_0
  (~4× smaller than F32) with no measurable task-accuracy loss on LIBERO
  closed-loop eval. Other towers stay F32.
- **Bare async API** — model loading and inference run off the JS event loop.

## Model

Default-tested fixture: SmolVLA fine-tuned on LIBERO
(`HuggingFaceVLA/smolvla_libero`), packaged as a single ~1.9 GB GGUF. The
GGUF carries SmolVLA's vision tower, SmolLM2 language model, action expert,
and flow-matching projections in a unified file.

## Installation

```bash
npm install @qvac/vla-ggml
```

The package ships prebuilt native binaries for linux-x64, linux-arm64,
darwin-arm64, darwin-x64, ios-arm64 (+ simulator), android-arm64, and
win32-x64. No build step required for consumers.

## Usage

```js
const { VlaModel, preprocessImage, padState } = require('@qvac/vla-ggml')

const model = new VlaModel({
  files: { model: ['/path/to/smolvla-libero-vision-q8.gguf'] },
  opts: { stats: true } // populate per-stage timings on the response
})
await model.load() // backend defaults to 'auto' (GPU when available, CPU otherwise)

const { hparams } = model
const size = hparams.visionImageSize // 512

// Note: `imgWidth` and `imgHeight` passed to `model.run` MUST equal
// `hparams.visionImageSize`. Resize / letterbox up front with
// `preprocessImage(..., { size })`; the addon rejects mismatches.
const front = preprocessImage(frontPixels, frontW, frontH, { size })
const wrist = preprocessImage(wristPixels, wristW, wristH, { size })

const tokens = new Int32Array(hparams.tokenizerMaxLength)
const mask = new Uint8Array(hparams.tokenizerMaxLength)
// ... tokenize the instruction with SmolVLM2 tokenizer (consumer-side) ...

const state = padState(robotEefAndGripperState, hparams.maxStateDim)
const noise = new Float32Array(hparams.chunkSize * hparams.maxActionDim)
crypto.getRandomValues(new Uint8Array(noise.buffer)) // or your seeded prior

const response = await model.run({
  images: [front, wrist],
  imgWidth: size,
  imgHeight: size,
  state,
  tokens,
  mask,
  noise
})
const { actions, stats } = await response.await()
// actions: Float32Array, length = chunkSize * actionDim (50 × 7 by default)
```

## JavaScript API

| Export | What |
|---|---|
| `VlaModel` | Async model wrapper. Constructor takes `{ files, config?, logger?, opts? }`. Call `await model.load({ backend? })` then `await (await model.run(input)).await()`. |
| `preprocessImage(pixels, w, h, { size, layout, scale })` | Resize + letterbox + normalize a camera frame to `(3, size, size)` Float32 in `[-1, 1]`. `scale` accepts `1` (already 0..1), `1/255` (input is 0..255), or `'auto'` (default heuristic). |
| `padState(state, targetDim)` | Zero-pad a robot-state vector to the model's `maxStateDim`. |
Full TypeScript types in [`index.d.ts`](./index.d.ts).

## Backend Selection

The addon picks a GPU at load time when `backend: 'auto'` (the default).
Non-Adreno GPUs are accepted. On Adreno hardware:

- **Adreno >= 800 + OpenCL** is accepted (Qualcomm/qvac-fabric actively
  maintain this path; integration test asserts cos sim > 0.99 vs PyTorch
  on the LIBERO fixture).
- **Adreno >= 800 + Vulkan** is skipped — the Vulkan driver on Adreno 830
  produced cos sim ~0.73 vs PyTorch on the LIBERO fixture (vs ~0.999 on
  every other accepted Vulkan target), so any Adreno Vulkan device is
  rejected even when OpenCL isn't loaded.
- **Adreno < 800** is rejected (older Qualcomm OpenCL ICDs have incomplete
  OpenCL 3.0 support, kernel-compile failures on several ggml ops, and
  shared-memory OOMs).

When no acceptable GPU is found the addon falls back to CPU; to force CPU
regardless, pass `backend: 'cpu'` to `load()`.

## Built With

- [qvac-lib-inference-addon-cpp](https://github.com/tetherto/qvac-lib-inference-addon-cpp) — foundational Bare-addon framework.
- [ggml](https://github.com/ggml-org/ggml) — tensor / inference primitives. We use raw ggml directly (not llama.cpp) because SmolVLA's flow-matching ODE and dual-VLM-with-expert architecture aren't representable in any existing higher-level wrapper.
- [SmolVLA](https://huggingface.co/HuggingFaceVLA/smolvla_libero) by LeRobot / HuggingFace — the upstream model architecture.
- [SmolVLM2](https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct) by HuggingFaceTB — the underlying VLM the action expert attaches to.

## Development

Build from source:

```bash
npm install
bare-make generate
bare-make build
bare-make install
```

Tests:

```bash
npm run test:unit          # brittle JS unit tests
npm run test:integration   # end-to-end with a real GGUF (set QVAC_VLA_MODEL)
npm run test:cpp           # GoogleTest C++ unit tests
```

LIBERO closed-loop simulation eval (PyTorch reference vs QVAC GGUF):
see [`sim/README.md`](./sim/README.md).

## License

@qvac/vla-ggml itself is Apache-2.0. Bundled third-party components are governed
by their respective licenses; see [`NOTICE`](./NOTICE).
