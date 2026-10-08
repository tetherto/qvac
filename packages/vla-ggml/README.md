# @qvac/vla-ggml

**Technology Stack:** C++20, CMake, vcpkg, Bare Runtime, ggml
**Package Type:** Native Bare addon

A vision-language-action (VLA) inference addon for the Bare runtime, running
[SmolVLA](https://huggingface.co/HuggingFaceVLA/smolvla_libero), Physical
Intelligence [π₀.₅](https://www.physicalintelligence.company/blog/pi05), and
NVIDIA [GR00T N1.7](https://huggingface.co/nvidia/GR00T-N1.7-3B) on ggml. Given
camera frames and a natural-language instruction, it produces a chunk of robot
actions ready to dispatch to a manipulator. The model architecture is selected
automatically from the GGUF `general.architecture` key, so the same `VlaModel`
API serves all three.

## Key Features

- **Three VLA architectures on ggml** — *SmolVLA* (SigLIP-B/16 vision encoder,
  SmolLM2 language tower, action expert, 10-step flow-matching ODE), *π₀.₅*
  (SigLIP vision + PaliGemma/Gemma-1 VLM + action expert, same flow-matching
  ODE), and *GR00T N1.7* (Qwen3-VL backbone + VL-fusion + a 32-layer
  AlternateVLDiT action head driven by a Euler flow-matching loop). The
  polymorphic `IVlaModel` interface dispatches on the GGUF
  `general.architecture` key; legacy weights without the key load as SmolVLA.
  Every sub-graph of all three models is parity-tested against a PyTorch
  reference at cos > 0.999.
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

## Models

Both architectures ship as a single unified GGUF (vision tower, language
model, action expert, and flow-matching projections in one file) and are
loaded through the same `VlaModel` API; `getVlaHparams()` reports the
per-architecture shape so callers can adapt.

| Model | GGUF `general.architecture` | Cameras | Robot state | Default fixture |
|---|---|---|---|---|
| **SmolVLA** | `smolvla` (or no key — legacy) | 2 | continuous (`state` Float32Array) | `HuggingFaceVLA/smolvla_libero`, ~1.9 GB |
| **π₀.₅** | `pi05` | 3 | discrete — encoded as text in the prompt (`state` arg ignored) | `pi05_base.gguf` |
| **GR00T N1.7** | `groot` | per embodiment (LIBERO 2, DROID 4) | continuous (`state` Float32Array) | `groot-q8_vf16.gguf`, ~3.76 GB |

For π₀.₅ the prompt is **not** just the instruction: following the openpi /
PaliGemma-VLA convention, the caller builds a templated prompt
(`Task: <instruction>, State: <state>;\nAction:`) where the quantile-normalised
robot state is discretised and rendered as text into the `State:` segment, then
tokenises the whole string. That token array is passed as the usual
`tokens`/`mask` input; the addon's separate `state` argument is **ignored** for
π₀.₅ (pass an empty `Float32Array`). SmolVLA, by contrast, takes the instruction
as the prompt and the robot state as the continuous `state` vector. For
converting LeRobot / openpi π₀.₅ checkpoints to GGUF and the quantization
profiles, see [`scripts/README-pi05-converter.md`](./scripts/README-pi05-converter.md).

GR00T N1.7 takes the instruction as the prompt and the robot state as the
continuous `state` vector (like SmolVLA), and is **multi-embodiment**: a single
GGUF can carry many embodiments, one of which is active at a time. Name the one
you want in `config.embodiment` — a tag string, its numeric `cat_id`, or
`{ tag | catId, numCameras }`. Omitting it selects the GGUF's own default
embodiment, and is a no-op for single-embodiment or non-GR00T GGUFs; naming one
explicitly on a SmolVLA or π₀.₅ GGUF is rejected rather than ignored, since a
caller who asked for an embodiment by name has almost certainly pointed `files`
at the wrong model. The number
of cameras follows the selected embodiment (LIBERO 2, DROID 4), so read
`hparams.numCameras` after `load()` rather than hard-coding it;
`hparams.selectedEmbodimentTag` / `hparams.selectedEmbodimentCatId` report what
was resolved — on every GR00T GGUF, including a single-embodiment one, which
reports its baked tag and still rejects `setEmbodiment()`. Neither field is a
"can this switch" check. Many tags share one `cat_id` — all `oxe_droid_*` are 24 — so an
id-based selection reports that id's canonical tag, which may be a different
alias than the one you would have passed; the id is the stable identity.

```js
new VlaModel({ files, config: { embodiment: 'libero_sim' } })     // by tag
new VlaModel({ files, config: { embodiment: 24 } })               // by cat_id
new VlaModel({ files, config: { embodiment: { catId: 3, numCameras: 2 } } })
```

`numCameras` overrides the camera count stored in the GGUF for that embodiment.
It is **required** for an embodiment the GGUF has no count for: `num_cameras` is a
data-config property that isn't in the checkpoint, so a ship set can contain rows
whose view count was unknown at conversion time. Those rows are still selectable
— just not without being told the count, because inheriting another embodiment's
count would build the wrong image-token layout and infer silently wrong. (The
converter's `--embodiment-cameras TAG=N` can stamp counts into the GGUF instead.)

A loaded model can switch embodiments without reloading, taking the same
selector:

```js
const hparams = await model.setEmbodiment('oxe_droid_relative_eef_relative_joint')
console.log(hparams.numCameras, hparams.selectedEmbodimentTag) // 4, 'oxe_droid_...'
await model.setEmbodiment(24)                        // same embodiment, by id
await model.setEmbodiment({ catId: 3, numCameras: 2 })
```

Only that embodiment's weight rows are re-read (~20 MB); the vision tower,
backbone, VL fusion and DiT are shared and untouched. It resolves to the
refreshed hparams, and later `run()` calls must pass `hparams.numCameras` images.
It rejects an unknown tag or cat_id, one not stored in this GGUF, an embodiment
with no known camera count and no `numCameras`, and single-embodiment models,
leaving the active embodiment in place. It also rejects a switch while an
inference is dispatched but not yet awaited: `run()` returns as soon as the job
reaches the worker, so switching in that window would infer on the new
embodiment's weights against input validated against the old `numCameras`. Await
the response first. For the converter (`--embodiments` /
`--default-embodiment` / `--embodiment-cameras`), the `groot.embodiment.*` GGUF
metadata, and the quantization profiles, see
[`scripts/README-groot-converter.md`](./scripts/README-groot-converter.md#multi-embodiment).

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

The example above is SmolVLA (2 cameras, continuous `state` vector). π₀.₅ takes
up to 3 images and ignores the `state` argument — the caller instead encodes
robot state as text inside the prompt (`Task: …, State: …;\nAction:`) before
tokenising (see [Models](#models)). Check `hparams.numCameras` /
`hparams.stateInputMode` after `load()` rather than hard-coding the input shape.

## JavaScript API

| Export | What |
|---|---|
| `VlaModel` | Async model wrapper. Constructor takes `{ files, config?, logger?, opts? }`. `config.embodiment` (GR00T only) selects a row from a multi-embodiment GGUF and takes the full `VlaEmbodimentSelector`: a tag string, a numeric `cat_id` (`0..31`), or `{ tag \| catId, numCameras }` where `numCameras` overrides the stored view count (`''` / omitted = GGUF default). Call `await model.load({ backend? })` then `await (await model.run(input)).await()`. `await model.setEmbodiment(selector)` takes the same shape, switches embodiment on a loaded GR00T model and returns the refreshed hparams. |
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
- [SmolVLA](https://huggingface.co/HuggingFaceVLA/smolvla_libero) by LeRobot / HuggingFace — one of the two upstream model architectures.
- [SmolVLM2](https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct) by HuggingFaceTB — the underlying VLM SmolVLA's action expert attaches to.
- [π₀.₅](https://www.physicalintelligence.company/blog/pi05) by Physical Intelligence — the second supported architecture (SigLIP vision + PaliGemma/Gemma-1 VLM + action expert).

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
