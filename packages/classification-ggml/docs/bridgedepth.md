# BridgeDepth

BridgeDepth estimates stereo disparity from a rectified left/right image pair.
This addon runs the `rvc_pretrain` checkpoint with the Depth Anything V2 ViT-S
mono branch, as in the
[gbionics/BridgeDepth `bench-vits`](https://github.com/gbionics/BridgeDepth/tree/bench-vits)
variant of [BridgeDepth](https://github.com/aeolusguan/BridgeDepth). It returns
the disparity of the left image in input pixels; converting it to depth
(`focal * baseline / disparity`) needs the camera calibration and is left to
the caller.

```js
const { BridgeDepth } = require('@qvac/classification-ggml')

const model = new BridgeDepth({
  modelPath: './bridgedepth-vits-f32.gguf',
  backend: 'CPU', // optional; exact GGML device name, e.g. CUDA0 or Vulkan0
  threads: 8
})
await model.load()
const { width, height, disparity } = await model.infer(leftPng, rightPng)
// disparity: Float32Array, row-major [height, width]
const stats = model.getRuntimeStats()
await model.destroy()
```

`infer()` takes two JPEG/PNG buffers, or two packed RGB buffers with one shared
`{ width, height, channels: 3 }`. Both views must have the same size, each side
between 32 and 4096 pixels; other sizes are rejected with an error.

The model runs on at most 1280 x 720. The model authors recommend downsampling
inputs above 720p, for speed and for accuracy, and the graph memory grows with
the pixel count. A pair wider than 1280 or taller than 720 is scaled by one
factor to fit inside 1280 x 720, bilinear as the upstream `demo.py` does, and
the disparity is resized back to the input size and multiplied by the input
width over the model width, so `width`, `height` and the values stay in input
pixels. A side the scaling would take below 32 stays at 32. A pair inside
1280 x 720 runs at its own size. Inputs are padded on the top and the right by
edge replication and the result is cropped back, as in the original
`InputPadder`.

Backend selection, `backendsDir`, `load()`, `unload()`, `destroy()` and the
runtime statistics behave as for [MegaLoc](megaloc.md). `cpu_fallback_nodes`
counts compute nodes the scheduler placed on the CPU while a GPU was selected.
On Metal, CUDA and Vulkan it is 0. OpenCL has no kernel for the `roll` and
`top_k` ops this graph uses, so on OpenCL those nodes run on the CPU, with
copies between the device and the CPU around each of them.

## Accuracy

The tests compare the port with the original PyTorch model in FP32 on CPU,
on a synthetic 100 x 200 pair. The DPN picks two disparity proposals per pixel
with a top-k over 40 candidates, most of which tie at the same masked value.
torch.topk keeps the lowest tied index and this port does the same: a tie
choice that changes from pixel to pixel costs accuracy, one fixed rule does
not. Metal, and Vulkan on devices with fp16 or coopmat2, stage F32 matrix
products in half precision, so they sit slightly further from the reference
than CPU and CUDA.

The CUDA backend uses the CUDA 13 runtime installed on the host
(`libcudart.so.13`, `libcublas.so.13`, `libcublasLt.so.13` on Linux); Fabric
does not bundle it. Without it the CUDA backend does not load and the default
GPU selection uses Vulkan.

## Local GGUF conversion

One format is supported: F32, about 196 MB. Weights are not bundled.

1. Clone `https://github.com/gbionics/BridgeDepth` at `f6d8cdd` (`bench-vits`)
   and install its requirements and torch. Loading the model downloads
   `rvc_pretrain` and `Depth-Anything-V2-Small` from Hugging Face.
2. Run:

```bash
python scripts/convert-bridgedepth.py --fork <BridgeDepth checkout> \
  --output bridgedepth-vits-f32.gguf \
  --gguf-py <qvac-fabric-llm.cpp>/gguf-py
```

The script loads the model through the checkout's own `from_pretrained`, writes
the GGUF, reads it back bit-exact, then reruns the fixture pair with only the
GGUF weights loaded and requires an identical disparity. The addon accepts a
GGUF only when its tensor layout matches this converter's output.

## Tests

The C++ reference tests and the JS integration test need the converted GGUF:

```bash
QVAC_BRIDGEDEPTH_MODEL_PATH=/path/bridgedepth-vits-f32.gguf npm run test:cpp
QVAC_BRIDGEDEPTH_MODEL_PATH=/path/bridgedepth-vits-f32.gguf npm run test:integration
```

The integration test also finds the model at
`test/fixtures/bridgedepth-vits-f32.gguf`, which is where CI stages it and where
`npm run mobile:copy-prebuilds` reads it for the mobile bundle.
`QVAC_BRIDGEDEPTH_BACKEND` selects the device (default CPU). Without the model,
the tests that need weights are skipped and the input, padding and GGUF
validation tests still run. `test/fixtures/generate-bridgedepth-reference.py`
regenerates the fixture pair and the PyTorch reference.

## License

BridgeDepth code is MIT (`LICENSE-BridgeDepth`). Depth Anything V2 Small is
Apache-2.0. See `NOTICE`.
