# Fibo 2.0 Edit Turbo

This download profile uses [AbrahamPJ's Q4_0 GGUF](https://huggingface.co/AbrahamPJ/fibo2-edit-turbo-q4_0-gguf)
of [Bria's Fibo 2.0 Edit Turbo](https://huggingface.co/briaai/Fibo-2.0-edit-turbo).
It includes the Qwen3-VL-4B encoder, matching vision projector, and FLUX.2 VAE.
Download verification, wrapper tests, and native inference are separate checks.
The four-step portrait edit and the 25-assertion native integration check pass
through the addon on CUDA and Vulkan with this exact profile. This does not
establish official-pipeline parity.

## Download

Run from `packages/diffusion-cpp`:

```bash
bash scripts/download-model-fibo2-edit-turbo.sh --dry-run
bash scripts/download-model-fibo2-edit-turbo.sh
```

The default destination is package-relative `models/fibo2-edit-turbo`, even
when the script is invoked from another directory. Override it with:

```bash
FIBO_MODELS_DIR='/absolute/path/to/fibo models' bash scripts/download-model-fibo2-edit-turbo.sh
```

The four files total **8,540,063,644 bytes (8.54 GB / 7.95 GiB)**. Allow additional
space for builds and generated outputs; download size is not peak runtime memory.
The script needs Bash, curl, and either `sha256sum` or `shasum`. All four sources
are public, so this profile does not require a Hugging Face token.

| Constructor field | Relative file | Bytes |
| --- | --- | --- |
| `files.model` | `fibo2_edit_turbo-q4_0.gguf` | 4,870,390,432 |
| `files.llm` | `Qwen3VL-4B-Instruct-Q4_K_M.gguf` | 2,497,281,664 |
| `files.llmVision` | `mmproj-Qwen3VL-4B-Instruct-F16.gguf` | 836,180,256 |
| `files.vae` | `vae/flux2-vae.safetensors` | 336,211,292 |

The downloader pins repository revisions and SHA-256 hashes. `--dry-run` prints
the full inventory without writing files or accessing the network. It verifies
existing files on every run, resumes transport failures using `.part` files,
and renames a download only after its size and hash match. A corrupt completed
download is discarded; rerun to retry. An existing file is replaced only after
the replacement is verified. Reusing a verified cache or symlinking an existing
correct model file into this layout avoids another download.

Only one downloader can write to a destination at a time. If a process is killed
without cleanup, confirm it is no longer running before removing the empty
`.download-fibo2-edit-turbo.lock` directory inside the model directory. Leave
partial files in place to resume. Network and HTTP failures preserve partial
transfers and return a nonzero exit status.

Weights retain their source terms: [Fibo quantization](https://huggingface.co/AbrahamPJ/fibo2-edit-turbo-q4_0-gguf),
[original Fibo](https://huggingface.co/briaai/Fibo-2.0-edit-turbo),
[Qwen encoder and projector](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF),
and [VAE distribution](https://huggingface.co/Comfy-Org/Fibo-2.0).

## Editing example

Use an addon built with a native engine containing Fibo support; follow
[the package build instructions](../build.md) for the selected backend. The
downloader does not build or install a native addon.

Build this checkout to include the addon's `flux` scheduler and its pinned
[engine capability patch](../vcpkg-overlays/README.md). An older published
prebuild can reject `scheduler: 'flux'` or Fibo's `init_images`; downloading
weights alone does not update that binary.

```bash
bare examples/generate-image-fibo2-edit-turbo.js assets/von-neumann-colorized.jpg
```

This requests a burgundy jacket and writes `output/fibo2-edit-turbo.png`. The
example uses four steps, CFG 1, Euler, and the engine's FLUX scheduler. It takes
one to four positional reference paths in order and passes them through
`init_image` or `init_images`. The vision projector is always supplied. Use a
prompt describing your own images when providing custom references:

```bash
FIBO_PROMPT='Change the car to red; preserve the scene and lighting.' \
  bare examples/generate-image-fibo2-edit-turbo.js /absolute/path/to/car.png
```

`FIBO_MODELS_DIR` selects the same layout as the downloader. `FIBO_OUTPUT`,
`FIBO_WIDTH`, `FIBO_HEIGHT`, and `FIBO_SEED` override output and reproducibility
settings; dimensions must be positive multiples of 16. `FIBO_BACKEND` selects an
engine backend if needed; otherwise native backend selection applies. On shared
GPU hosts, run inference through the host's GPU scheduler and select only devices
visible within the allocation.

This is reference-image editing with the standalone Turbo checkpoint; no Turbo
LoRA or Dev checkpoint is needed. Do not substitute text-only Qwen3-4B for
Qwen3-VL-4B, a different projector, or an earlier FLUX VAE. Structured JSON prompts
can be passed as `FIBO_PROMPT`, but the current native implementation documents
missing glyph rendering, Bria VGL expansion, and native mask preprocessing. This
example does not claim those capabilities or official pipeline parity.

## Native integration check

After building the addon and downloading its components, run:

```bash
FIBO_MODELS_DIR="$PWD/models/fibo2-edit-turbo" \
  bare test/integration/generate-image-fibo2-edit-turbo.test.js --exit
```

The test exercises one, two, and four references, invalid image inputs,
cancellation followed by another edit, and unload/reload with a JSON instruction.
It uses packaged reference assets by default. `FIBO_TEST_IMAGE` replaces the first
reference and `FIBO_TEST_OUTPUT_DIR` saves the resulting PNGs for visual review.
`FIBO_BACKEND` selects the backend as in the example. Without `FIBO_MODELS_DIR`,
this model-dependent test is skipped; a skip is not an inference validation.

These assertions cover API behavior and valid output images, not composition
quality. In visual review, a two-person garden prompt produced one person through
both the addon and the standalone native CLI. Multiple references can execute
successfully without preserving every requested subject; review the generated
images for your intended edit.
