# MegaLoc

MegaLoc maps an image to an 8,448-component, L2-normalized descriptor for visual
place recognition and image retrieval. It returns a `Float32Array`; labels and
classification probabilities belong to the separate `ImageClassifier` interface.

```js
const { MegaLoc } = require('@qvac/classification-ggml')

const model = new MegaLoc({
  modelPath: './megaloc-f16.gguf',
  backend: 'CPU', // optional; exact GGML device name, e.g. CUDA0 or Vulkan0
  threads: 8
})
await model.load()
const descriptor = await model.embed(rgbBytes, { width: 640, height: 480, channels: 3 })
const stats = model.getRuntimeStats()
await model.unload()
await model.destroy()
```

Omit `backend` to select a registered GPU, then an integrated GPU, then CPU.
An explicitly requested backend must exist; it does not silently select another
device. `backendsDir` optionally overrides Fabric's module directory. Backend
availability depends on the platform's Fabric build. GPU masks set before
starting the process also apply to this addon.

`embed()` accepts JPEG/PNG bytes without dimensions, or packed RGB bytes with
all three dimension fields. Inputs use RGB conversion, ImageNet normalization,
antialiased bilinear resizing to 322 × 322, and 14 × 14 patches. No cropping or
aspect-ratio padding is applied. Batch size is one. Calls on one instance are
serialized; different instances own separate graphs and weight buffers.

`load()` and `unload()` are idempotent. An unloaded instance can load again.
`destroy()` releases resources permanently. Runtime statistics describe the last
successful embedding and include time, allocated weight bytes, backend ID and
the number of graph nodes assigned to CPU fallback. Backend IDs are CPU=0,
Metal=1, CUDA=2, Vulkan=3, OpenCL=4 and other=99. Fallback allows portable graph
operations to execute on CPU when a GPU backend does not support them.

## Local GGUF conversion

Obtain the original `model.safetensors` from
[MegaLoc on Hugging Face](https://huggingface.co/gberton/MegaLoc).
The converter verifies the supported checkpoint revision and SHA256, uses the
safetensors reader, and does not execute downloaded Python model code.

Use Python 3.11 or newer with `numpy`, `torch`, `safetensors` and Fabric's
`gguf-py` package. These are converter tools, not addon runtime dependencies.
F16 is the default:

```sh
python scripts/convert-megaloc.py --input model.safetensors --output megaloc-f16.gguf --gguf-py /path/to/fabric/gguf-py
```

For the second format, quantize only the final projection to Q6_K:

```sh
python scripts/convert-megaloc.py --input model.safetensors --output megaloc-mixed.gguf --quant mixed --gguf-py /path/to/fabric/gguf-py --ggml-library /path/to/libggml-base.so
```

The native quantizer must come from a compatible Fabric/GGML build. Its library
is named `ggml-base.dll` on Windows and `libggml-base.dylib` on macOS builds that
produce that shared library. F16 conversion does not need this library.
GGUF format names describe matrix storage; activations and reductions use F32.
Small tensors and patch-projection weights remain F32 in both formats.
The converter writes a complete temporary file before publishing the output
path and refuses to overwrite an existing file.

Keep converted files outside the package's `weights/` directory. MegaLoc GGUFs
are not bundled, uploaded by the converter, or registered with P2P. The MIT
notice is retained in `LICENSE-MegaLoc`; model provenance is recorded in GGUF
metadata.

## Addon structure

The native addon follows the multi-model `IModel` pattern used by QVAC's TTS
addon: each model implementation lives in its own directory, and instance
creation selects the implementation and its typed output handler. MobileNet
lives under `model-interface/mobilenet/`; MegaLoc lives under
`model-interface/megaloc/`. Image decoding and raw-input validation are shared;
the model-specific resizing and graphs are separate. The low-level configuration
defaults to MobileNet; the `MegaLoc` wrapper explicitly selects `modelType:
"megaloc"`. Both public interfaces use the same native addon and Fabric runtime.

## Tests

Set `QVAC_MEGALOC_F16_MODEL_PATH` and `QVAC_MEGALOC_MIXED_MODEL_PATH` to local
converted files before `npm run test:integration`. The tests require both
formats. `QVAC_MEGALOC_BACKEND` selects the device for those tests and defaults
to CPU. Synthetic reference fixtures come from original PyTorch FP32 and cover
upscaling, downscaling and unchanged dimensions. They also check repeated
inference, decoding, error recovery, model coexistence and lifecycle behavior.

`npm run test:cpp` includes preprocessing parity and malformed-model checks.
Integration tests verify backend selection and record CPU fallback counts.
Cross-platform CI and mobile tests need the model fixtures staged separately;
test models are not included in the published npm package.
