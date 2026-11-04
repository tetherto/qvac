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
device. Metal accepts `Metal`, `Metal0` and GGML's native `MTL0` name.
`backendsDir` optionally overrides Fabric's module directory. Backend
availability depends on the platform's Fabric build. GPU masks set before
starting the process also apply to this addon.

`embed()` accepts JPEG/PNG bytes without dimensions, or packed RGB bytes with
all three dimension fields. Inputs use RGB conversion, ImageNet normalization,
antialiased bilinear resizing to 322 × 322, and 14 × 14 patches. No cropping or
aspect-ratio padding is applied. Batch size is one. Calls on one instance are
serialized; different instances own separate graphs and weight buffers.

`load()` reads weights and builds the graph on a native worker, keeping the JS
event loop responsive. `load()` and `unload()` are idempotent. An unloaded
instance can load again.
`destroy()` releases resources permanently. Runtime statistics describe the last
successful embedding and include time, allocated weight bytes, backend ID and
the number of graph nodes assigned to CPU fallback. Backend IDs are CPU=0,
Metal=1, CUDA=2, Vulkan=3, OpenCL=4 and other=99. Fallback allows portable graph
operations to execute on CPU when a GPU backend does not support them.

## Local GGUF conversion

Two formats are supported: **F16 (default), 436.8 MiB**, and **mixed (F16 body
with a Q6_K projection), 278.7 MiB**. Mixed is **36.2% smaller** (F16 is 1.57 times
its size). In a 512-query retrieval screen, both retained PyTorch FP32's
78.9062% Recall@1. The lowest mAP across four tested backends was 70.8692% for
F16 and 70.8455% for mixed, versus 70.8680% for PyTorch: mixed lost 0.0225
percentage points against PyTorch. Lowest mean descriptor cosine similarity to
PyTorch was 0.9999948 for F16 and 0.9998124 for mixed. These small engineering
screens do not establish accuracy on unseen datasets; latency depends on the
backend, so smaller storage does not imply faster inference.

Obtain the original `model.safetensors` from
[MegaLoc on Hugging Face](https://huggingface.co/gberton/MegaLoc/resolve/a0f34722c4297ff787e022433799250180860af7/model.safetensors).
The converter verifies the supported checkpoint revision and SHA256, uses the
safetensors reader, and does not execute downloaded Python model code.

Use Python 3.11 or newer. Install the converter tools and obtain the compatible
Fabric sources; these are offline tools, not addon runtime dependencies:

```sh
python -m pip install numpy==2.4.4 safetensors==0.8.0 PyYAML==6.0.3 tqdm==4.68.4
git clone --filter=blob:none --no-checkout https://github.com/tetherto/qvac-fabric-llm.cpp.git fabric
git -C fabric checkout --detach d0a43e514c493b3655debf7e04f12a57931ca8e9
```

From the addon directory, manually convert both test models. F16 is the default:

```sh
python scripts/convert-megaloc.py --input model.safetensors --output test/fixtures/megaloc-f16.gguf --gguf-py fabric/gguf-py
```

For the second format, build the native core quantizer, then quantize only the
final projection to Q6_K. This dependency build does not use a GPU; the embedded
GGML sources do not contain the standalone tests/examples directories:

```sh
cmake -S fabric/ggml -B ggml-build -DBUILD_SHARED_LIBS=ON -DGGML_CPU=OFF -DGGML_METAL=OFF -DGGML_BLAS=OFF -DGGML_BUILD_TESTS=OFF -DGGML_BUILD_EXAMPLES=OFF
cmake --build ggml-build --target ggml-base --config Release --parallel 4
```

On Linux with a single-configuration generator:

```sh
python scripts/convert-megaloc.py --input model.safetensors --output test/fixtures/megaloc-mixed.gguf --quant mixed --gguf-py fabric/gguf-py --ggml-library ggml-build/src/libggml-base.so
```

The native quantizer must come from a compatible Fabric/GGML build. Its library
is normally `ggml-build/bin/Release/ggml-base.dll` with Visual Studio on Windows
(`ggml-build/bin/ggml-base.dll` with Ninja), and
`ggml-build/src/libggml-base.dylib` on macOS with a single-configuration generator.
Adjust the path to the actual build output. A Fabric `.bare` addon cannot be
used as the quantizer library. F16 conversion does not need this library.
GGUF format names describe matrix storage; activations and reductions use F32.
Small tensors and patch-projection weights remain F32 in both formats.
Positional embeddings use fixed-order float64 bicubic interpolation followed by
F32 storage, retaining the original coordinates and cubic kernel while avoiding
platform-dependent FP32 rounding. PyTorch is needed only to regenerate the test
reference fixtures, not for conversion or addon inference.
The converter finishes a temporary file before publishing the output path and
refuses to overwrite an existing file. Filesystems without hard links use an
exclusive copy; a failed copy removes its partial output.

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

Convert both files into `test/fixtures/` using the commands above before
`npm run test:integration`. Alternatively, set `QVAC_MEGALOC_F16_MODEL_PATH` and
`QVAC_MEGALOC_MIXED_MODEL_PATH` to your manually converted files elsewhere.
The tests require both formats and report missing files as errors.
`QVAC_MEGALOC_BACKEND` selects the explicit test device and defaults to CPU.
Separate tests compare both formats against PyTorch using automatic device
selection, exercising GPU inference when available. Set
`QVAC_MEGALOC_EXPECT_GPU=1` to require GPU selection in those tests.
Synthetic reference fixtures come from original PyTorch FP32 and cover
upscaling, downscaling and unchanged dimensions. They also check repeated
inference, decoding, error recovery, model coexistence and lifecycle behavior.

`npm run test:cpp` includes preprocessing parity and malformed-model checks.
Run `python scripts/test_convert_megaloc.py -v` with NumPy installed to check the
converter's positional interpolation against stored original PyTorch references
and output publication, including filesystems without hard links.
Integration tests verify backend selection and record CPU fallback counts.
For mobile tests, run `npm run mobile:copy-prebuilds` after conversion. It stages
both model files and reference assets for the device using the same local paths
and environment overrides. Converted MegaLoc GGUFs are ignored by Git and
excluded from the published npm package, including staged mobile copies.
