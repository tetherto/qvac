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

The initial backport covers regular text-to-image and reference editing. Turbo,
prefix KV caching, and broad LoRA compatibility are not validated by this recipe.
Hardware validation is limited to RTX 5090 CUDA; other ticket targets need
separate runs.

## Measured validation

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
