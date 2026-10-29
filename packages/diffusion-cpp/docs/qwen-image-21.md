# Qwen-Image-2.1

The integration uses the native QVAC engine through `ImgStableDiffusion`.
The package's `vcpkg-configuration.json` selects the versioned
`stable-diffusion-cpp` port from the QVAC registry at revision `2026-08-11#7`.
That port pins merged native engine commit
[`4ec33ca21eec64b9778b6fd16d58e88cd501936d`](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/commit/4ec33ca21eec64b9778b6fd16d58e88cd501936d)
from [native PR #57](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/57),
with a verified archive SHA-512. It retains ggml
`9f94f330ac196e0a2e3176e798b36226b22091a5` and the existing platform features.

Build from this package directory using the normal CUDA commands:

```sh
npm run build:cuda
```

No package-local port overlay or uncommitted native patch is needed.
[Registry PR #432](https://github.com/tetherto/qvac-registry-vcpkg/pull/432)
is merged. The manifest requires `stable-diffusion-cpp >= 2026-08-11#7`, resolved
from the existing default QVAC registry on `main`. No separate registry entry
is needed, and the existing registry baselines are retained.
Existing binaries built with native port #6 do not provide the new context
capability APIs; rebuild the addon with the updated registry configuration.

## Model files

Run `bash scripts/download-model-qwen-image-21.sh`. It downloads pinned revisions
and checks SHA-256 before installing each file. `QWEN_MODELS_DIR` overrides the
output directory. Read the [model license at the pinned official revision](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/d26bb61231c349cf6b7896fa83353113880e1ba3/LICENSE)
before using or distributing the weights. Model weights are not included in the
package and retain their own licenses.

| Public file key | Asset |
| --- | --- |
| `model` | `qwen_image_2.1-Q4_K.gguf` |
| `llm` | `Qwen3VL-8B-Instruct-Q4_K_M.gguf` |
| `vae` | `qwen_image_2.1_vae_bf16.safetensors` |
| `llmVision` | `mmproj-Qwen3VL-8B-Instruct-F16.gguf`, required for editing with the GGUF encoder |

All file paths must be absolute. `llmVision` is separate from the video API's
`clipVision`. Earlier Qwen Image and Wan VAE files are incompatible with 2.1.
The projector also participates in `assessFit` through the shared file mapping.

## Generation and editing

Build with CUDA enabled and download the model files above. Run these commands
from `packages/diffusion-cpp`. Each preset works independently and writes a
separate PNG under `output/`:

```sh
export CUDA_VISIBLE_DEVICES=0

# Text-to-image: generate a von Neumann portrait from a prompt alone.
npm run generate:qwen:text-to-image

# Single-reference edit: change the colorized portrait's jacket to burgundy.
npm run generate:qwen:edit

# Two-reference composition: the two referenced men shaking hands in one scene.
npm run generate:qwen:compose

# Transparent generation: create a new portrait cutout from text alone.
npm run generate:qwen:transparent

# Transparent reference edit: remove the colorized portrait's background.
npm run generate:qwen:remove-background
```

| Mode | Default references from `assets/` | Output in `output/` |
| --- | --- | --- |
| `text-to-image` | None | `qwen-image-21-portrait.png` |
| `edit` | `von-neumann-colorized.jpg` | `qwen-image-21-portrait-edit.png` |
| `compose` | `von-neumann-colorized.jpg`, then `von-neumann.jpg` | `qwen-image-21-handshake.png` |
| `transparent` | None | `qwen-image-21-transparent-portrait.png` |
| `remove-background` | `von-neumann-colorized.jpg` | `qwen-image-21-no-background.png` |

Text-to-image and transparent generation use only a portrait prompt; they do
not load the asset or reproduce its exact likeness. The editing modes load the
vision projector automatically. Composition demonstrates two ordered references
using the two bundled von Neumann portraits to create a handshake scene; no
earlier generation is required. Both inputs depict the same historical person,
so this illustrates two-reference composition rather than distinct-identity fidelity.

Pass your own files after npm's `--` separator to replace the default references
(one for `edit` or `remove-background`, two for `compose`). The zero-reference modes
reject image arguments. `--remove-background [image]` remains an alias for
`--mode remove-background [image]` when invoking the script directly with Bare.
Use `bare examples/generate-image-qwen-21.js --help` to list the modes.

```sh
CUDA_VISIBLE_DEVICES=0 npm run generate:qwen:edit -- /absolute/path/to/portrait.jpg
CUDA_VISIBLE_DEVICES=0 npm run generate:qwen:compose -- first.png second.png
```

`QWEN_PROMPT` and `QWEN_OUTPUT` override any preset's prompt and destination.
The original interface is also available: no arguments generates a red teapot,
and positional image paths without a mode use those images as references.

RGBA results are saved directly without alpha thresholding or background-removal
postprocessing. Generative edits can change subject details, and transparent
backgrounds may have near-zero alpha rather than exactly zero. Inspect the
output before using it as a cutout.

The example defaults to `cuda0`, 512×512, 30 Euler steps, CFG 6, and seed 42.
`QWEN_WIDTH`, `QWEN_HEIGHT`, `QWEN_STEPS`, `QWEN_SEED`, `QWEN_PROMPT`,
`QWEN_OUTPUT`, and `QWEN_BACKEND` override those settings. Width and height must
be multiples of 32. Leave prediction and scheduler automatic: the engine
selects the model's resolution-dependent flow schedule.

Use `init_image` for one encoded PNG/JPEG reference, or `init_images` for an
ordered array. They are mutually exclusive. Native model detection routes Qwen
references through image conditioning, starting the generated target from
noise. The `strength` parameter is not a reference-editing strength control.
References retain their array order; Qwen does not require FLUX `@imageN` tags.

RGBA references retain alpha when decoded for this model. RGB inputs acquire
opaque alpha. Existing models that request RGB keep their RGB decode path.
Output is PNG, preserving the model's four-channel output. To request transparent
content, explicitly describe an RGBA image with a transparent background in the
prompt. Preserving an alpha channel does not guarantee that the model generates
the transparency or edit requested by a particular prompt.

ESRGAN accepts RGB images only. Qwen-Image-2.1's four-channel output cannot use
`upscale: true`; the addon rejects that option before generation. Keep upscaling
disabled to preserve the RGBA output.

The base-model measurements below cover text-to-image and reference editing
on RTX 5090 CUDA. Turbo has separate NVIDIA GB10 measurements below.
Prefix KV caching and broad LoRA compatibility remain unvalidated.

## Turbo recipe

Qwen-Image-2.1-Turbo uses the same architecture with different diffusion weights,
CFG 1, and a fixed eight-step schedule. The addon accepts `custom_sigmas` for
image generation and forwards it to the engine's existing sampling API. Values
must be finite, non-negative and strictly decreasing after conversion to float,
with a final zero. The array overrides `scheduler` and `steps`; its length minus
one is the effective step count. Omit it to retain normal scheduling.

The [official Turbo configuration](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/main/model_index.json)
contains eight sampling values. The native API also needs a terminal zero:

```js
const sampling = {
  sampling_method: 'euler',
  cfg_scale: 1,
  steps: 8,
  custom_sigmas: [1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0]
}
```

After rebuilding the addon, provide a compatible Turbo diffusion GGUF or
safetensors file explicitly. The existing downloader supplies the base model
and shared components; it does not download Turbo weights. The example reuses
the Qwen-2.1 encoder, VAE and optional vision projector from `QWEN_MODELS_DIR`.

```sh
QWEN_TURBO=1 QWEN_TURBO_MODEL=/absolute/path/to/turbo.gguf \
  npm run generate:qwen:text-to-image
QWEN_TURBO=1 QWEN_TURBO_MODEL=/absolute/path/to/turbo.gguf \
  npm run generate:qwen:edit -- /absolute/path/to/reference.png
```

Turbo mode fixes the schedule at eight steps and ignores `QWEN_STEPS`. Default
output filenames gain a `-turbo` suffix. Other example overrides still apply.
The default 512×512 size is a development smoke-test size; the official model
examples use approximately 2K resolution. No engine or registry pin change is
needed for the custom-sigma API.

For output areas of 2048×2048 pixels or larger, the example enables VAE tiling
with `vae_tile_size: 64`. When calling `run()` directly at those sizes, pass
`vae_tiling: true` and `vae_tile_size: 64` as well. The native tile size is in
latent units (64 corresponds to 1024 output pixels for Qwen-Image-2.1), not
output pixels. Enabling tiling alone leaves the default tile size of 512, which
still covers the entire 2K latent grid. Full-frame decoding at 2048×2048 hit
the CUDA backend's `s02 <= uint32_t::max()` assertion on the validated stack;
the smaller tiles avoid that path.

### Measured Turbo validation

Validated on 2026-10-28 on NVIDIA DGX Spark (GB10, Linux ARM64), with CUDA,
eight CPU threads, flash attention, Euler sampling, CFG 1 and seed 42.
The diffusion checkpoint was
[`qwen-image-2.1-turbo-Q8_0.gguf`](https://huggingface.co/unsloth/Qwen-Image-2.1-Turbo-GGUF/blob/5d1f9f759ea877ae556cda88dbec958b62ad3809/qwen-image-2.1-turbo-Q8_0.gguf)
from revision `5d1f9f759ea877ae556cda88dbec958b62ad3809`, SHA-256
`399d2ddc3636f36456e2f5bfa57187da4e38721bc046430317f42a9eab5b1712`.
The encoder, projector and VAE were the same pinned files as the downloader
above; all four files were checksum-verified.

The rebuilt addon used cached `stable-diffusion-cpp 2026-08-11#9` and
`ggml 2026-08-11#5` libraries. This validates the addon with that native stack;
the minimum dependency versions were not rebuilt for this run.

| Public API operation at 512×512 | Request time |
| --- | ---: |
| Text-to-image | 5.15 s |
| Single-reference color edit | 9.91 s |
| Transparent generation | 4.56 s |
| Transparent reference edit | 9.91 s |
| Two-reference composition | 16.31 s |

These are single smoke-test observations, excluding model load, with one model
instance reused across requests. Every request reported eight completed
denoising steps even with `steps: 30` and `scheduler: 'karras'`, confirming that
the explicit schedule takes precedence. Missing terminal zero, duplicate sigmas
and a JavaScript NaN entry were rejected; subsequent valid requests succeeded.

All five PNGs were 512×512 RGBA. Visual inspection confirmed the red-to-blue
teapot edit and the ordered two-teapot composition. Transparent generation and
editing retained alpha values spanning 0–255, with near-transparent backgrounds;
this is a smoke check, not a claim of pixel-exact cutout edges or parity with
the official pipeline. Other Turbo quantizations and platforms remain untested.

A separate 2048×2048 portrait request completed in 184.90 s with the same
sampling settings and `vae_tile_size: 64`: eight denoising steps followed by
nine VAE decode tiles. Model load took 2.89 s separately.

The full native test binary passed 281 tests, including all five custom-sigma
tests; 35 tests skipped because their other-model fixtures were absent.
TypeScript compilation and lint passed. The JavaScript unit suite passed
137 tests with 519 assertions using Bare 1.36.0. All 51 Node tests passed,
including regression coverage for automatic VAE tiling in the 2K example.

## Measured base-model validation

Validated on one RTX 5090 (32 GB), CUDA 13.3, using physical GPU 0 only.
All timings below use the pinned files above, 512×512, 30 Euler steps, CFG 6,
seed 42, flash attention, eight CPU threads, and automatic scheduling. These
are single smoke-test observations, not benchmark averages.

| Public API operation | Request time |
| --- | ---: |
| Text-to-image | 6.44 s |
| Single-reference color edit | 13.09 s |
| Two-reference composition | 21.04 s |
| Transparent generation | 6.34 s |
| Transparent reference edit | 13.03 s |

The five bundled portrait presets were also run individually through their
`npm run generate:qwen:*` commands with the settings above:

| Example mode | Request time |
| --- | ---: |
| `text-to-image` | 6.48 s |
| `edit` | 13.13 s |
| `compose` | 25.39 s |
| `transparent` | 6.55 s |
| `remove-background` | 13.28 s |

The four unchanged presets matched their earlier, visually inspected direct-Bare
PNG SHA-256 hashes exactly. The edit changed the jacket to burgundy. The updated
composition preset was rerun and visually inspected: it places the two referenced
men together in one office scene with a handshake visible between them. Generated
faces, clothing and hands can differ from the references. Both transparency presets
produced RGBA PNGs with alpha spanning 0–255. Sampled background strips had alpha
0–7 for transparent generation and 0–2 for background removal, without
postprocessing; their backgrounds are not uniformly zero-alpha.

Text-to-image context load took 2.52 s; the edit context took 2.64 s.
The two-reference output placed the red teapot on the left and the blue teapot
on the right. Framing and fine scene details were not perfectly preserved.
Transparent generation and editing produced RGBA PNGs with alpha spanning
0–255; alpha is preserved without thresholding or background removal.

Peak observed device memory during the combined editing/transparency/lifecycle
smoke was 15,356 MiB, sampled by `nvidia-smi` every 100 ms. This is total device
memory, may miss short peaks, and does not predict larger resolutions or more
references. Device 1 stayed at its 2 MiB idle level. Memory returned to the idle
level after unloading.

Cancellation delivered no image, a subsequent request succeeded, repeated
unload succeeded, and a missing projector rejected editing while permitting a
subsequent text-to-image request. The missing-projector response currently
reports the native generation failure; the engine log provides the specific
vision-weights requirement.
