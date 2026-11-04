# FLUX.3 Image Klein

FLUX.3 uses split diffusion weights, a Qwen3-VL 4B text encoder, and the
FLUX.2 VAE. The native engine detects the architecture from the weights;
use `prediction: 'auto'`. No vision projector or external tokenizer is required.

## Backend and build

This integration builds on [QVAC #5550](https://github.com/tetherto/qvac/pull/5550)
and uses the same [registry #475](https://github.com/tetherto/qvac-registry-vcpkg/pull/475)
baseline, `3e01cbf62a3b61e0ac67ffb52e50e658b8bd0e8a`, on
`feat/diffusion-2026-11-01`. Both native ports are `2026-11-01`; the diffusion
engine source is `11d3d0138537abd8098c13d9bd2889bf1413bab1`.
Keep the registry branch available until the pin is refreshed to merged main.

Rebuild the addon and its paired GGML dependency together using the package's
[build instructions](../build.md). Previously published `0.33.0` binaries do
not establish support for this engine. From this package directory, run
`npm run build` (or `npm run build:cuda` for a CUDA build) after installing
the repository dependencies and platform build tools.

## Download

Accept the [FLUX.3 model access terms](https://huggingface.co/black-forest-labs/flux-3-image-klein)
and export `HF_TOKEN` with read access, then run from `packages/diffusion-cpp`:

```bash
bash scripts/download-model-flux3.sh
```

`FLUX3_MODELS_DIR` overrides the default `models/flux3` directory. The script
pins repository revisions and verifies SHA-256 before promoting `.part` files.
It resumes interrupted transfers and reuses verified files, including the VAE
without a token when already cached. Invalid partial downloads are removed so
the next run can retry. Downloaded weights retain their source licenses.

| File | Source |
| --- | --- |
| `flux3-image-klein-Q8_0.gguf` | [leejet FLUX.3 Image Klein](https://huggingface.co/leejet/flux-3-image-klein-GGUF/tree/1c2ad2f9b9247ccca6506a23bdb033fdb0873321) |
| `Qwen3VL-4B-Instruct-Q4_K_M.gguf` | [Qwen3-VL 4B](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/tree/1cd86afb9a95c410a6038ab3b40d8b578c892266) |
| `flux3-vae.safetensors` | [FLUX.3 `ae.safetensors`](https://huggingface.co/black-forest-labs/flux-3-image-klein/tree/09561231f44e41381c461caf53d5452005a60ac9) |

These files total approximately 9 GB. The downloader fetches the gated VAE
first to report access failures before downloading the larger public files.

## Generate and edit

```bash
bare examples/generate-image-flux3.js
FLUX3_PROMPT='Put the cat in a garden' FLUX3_OUTPUT=flux3-edit.png \
  bare examples/generate-image-flux3.js flux3.png
```

The example uses the distilled Klein model with 16 Euler steps, CFG 1,
the discrete scheduler, seed 42, and explicit 512×512 output dimensions.
The engine supplies the FLUX.3 time shift. Set `FLUX3_WIDTH`, `FLUX3_HEIGHT`
(positive multiples of 32), `FLUX3_SEED`, `FLUX3_PROMPT`, and `FLUX3_OUTPUT`
to override the example defaults. `FLUX3_BACKEND=cuda0` or `vulkan0` selects
a backend when its module is built and available; otherwise selection is automatic.

Pass up to ten reference image paths as positional arguments. They map to
`init_images`, which the native model capability routes to reference editing.
Output dimensions stay explicit instead of inheriting the first reference's size.

For direct API use, pass absolute paths as `files.model`, `files.llm`, and
`files.vae`, using the filenames above. The existing load and `assessFit` APIs
share this split-file mapping. This setup targets the distilled model;
FLUX.3 Image Klein Base requires its own weights and sampling settings.

## Validation

Run the downloader behavior tests without downloading model weights:

```bash
node --test scripts/download-model-flux3.test.mjs
```

The generation example exercises the actual addon when run with a rebuilt
native package and downloaded weights. Engine-only validation results do not
replace a rebuilt-addon generation check.
