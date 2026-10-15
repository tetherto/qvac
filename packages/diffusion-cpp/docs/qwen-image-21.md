# Qwen-Image-2.1

The integration uses the native QVAC engine through `ImgStableDiffusion`.
The package's `vcpkg-configuration.json` automatically selects the checked-in
`vcpkg-overlays/stable-diffusion-cpp` port. That port pins native engine commit
[`e34802ff987c6cef3773b2b7cff2b58a0ee677e3`](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/commit/e34802ff987c6cef3773b2b7cff2b58a0ee677e3)
from [native draft PR #57](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/57),
with a verified archive SHA-512. It retains ggml
`9f94f330ac196e0a2e3176e798b36226b22091a5` and the registry port's platform features.

Build from this package directory using the normal CUDA commands:

```sh
npm run build:cuda
```

No external overlay directory or uncommitted native patch is needed. The local
port is versioned `2026-08-11#7`; this does not publish that revision to the
registry. Keep the overlay until a registry port containing the native changes
is available, then update the dependency/baseline and remove it together.
Existing binaries built with native port #6 do not provide the new context
capability APIs; rebuild the addon with this source pin.

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

Build with CUDA enabled, then run:

```sh
CUDA_VISIBLE_DEVICES=0 bare examples/generate-image-qwen-21.js
QWEN_PROMPT='Make the teapot blue.' CUDA_VISIBLE_DEVICES=0 \
  bare examples/generate-image-qwen-21.js output/qwen-image-21.png
QWEN_PROMPT='Put the object in the first image into the scene in the second image.' \
  CUDA_VISIBLE_DEVICES=0 bare examples/generate-image-qwen-21.js first.png second.png
```

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
