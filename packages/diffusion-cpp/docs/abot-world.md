# ABot-World: interactive world generation

ABot-World is a **causal, interactive world model** (a derivative of
Wan2.2-TI2V-5B): instead of generating a whole video from one call, it
generates video **block-by-block under per-block keyboard input**, so you can
walk through a generated world in real time. This package exposes it through
`@qvac/diffusion-cpp/world`.

Two phases, four model files:

```
scene creation (once per world)          interactive walk (loop)
prompt ──► umT5-XXL ─┐
                     ├─► scene pack ──► ABot DiT ──► taehv ──► RGB frames
image ──► Wan2.2 VAE ┘      ▲
                            └── keys per block (W A S D  I J K L)
```

- **Scene pack** (`.safetensors`, ~10 MB): prompt embeddings + first-frame
  latents. Created natively by `createScene()` — no offline tooling needed.
- **Walk**: each `step(keys)` denoises one block (3 latent frames at the
  default config, decoded to 12 RGB frames) and streams the frames (PNG, or
  JPEG via config).

## Models

| role | file | size | quant |
|---|---|---|---|
| world model (walk) | `abot-world-0-5b-lf-dit-q8_0.gguf` | 5.5 GiB | Q8_0 |
| pixel decoder (walk) | `taew2_2_f16.gguf` | 22 MiB | F16 |
| prompt encoder (scene creation) | `umt5-xxl-enc-q8_0.gguf` | 5.6 GiB | Q8_0 |
| first-frame encoder (scene creation) | `wan2.2_vae_f16.gguf` | 1.3 GiB | F16 |

All four are published in the **QVAC P2P model registry** (engine
`@qvac/diffusion-cpp`, tag `abot-world`).

**Fidelity note:** these are GGUF conversions of the original PyTorch
checkpoints (DiT and umT5 quantized to Q8_0, VAE and taehv kept at F16), so
outputs are **not bit-exact** against the PyTorch reference. Parity is held by
cosine-similarity gates instead: golden walk replays score 0.993–0.99995
against reference activations, scene packs ≥ 0.997, and end-to-end walks land
at ~32–38 dB PSNR (the Q8 umT5 encoder measures 37.9 dB at walk level vs
F16). In validation walks the difference is not visually distinguishable.

### Getting the models (P2P registry — recommended)

No credentials needed: the registry client joins the QVAC P2P swarm with a
built-in discovery key and streams the blobs from peers.

```bash
npm install -g @qvac/registry-client
P=qvac_models_compiled/ABot-World-0-5B-LF/2026-07-17
mkdir -p ~/abot-models && cd ~/abot-models
qvac-registry download "$P/abot-world-0-5b-lf-dit-q8_0.gguf" s3 -o abot-world-0-5b-lf-dit-q8_0.gguf
qvac-registry download "$P/taew2_2_f16.gguf"                 s3 -o taew2_2_f16.gguf
qvac-registry download "$P/umt5-xxl-enc-q8_0.gguf"           s3 -o umt5-xxl-enc-q8_0.gguf
qvac-registry download "$P/wan2.2_vae_f16.gguf"              s3 -o wan2.2_vae_f16.gguf
```

Programmatic (node or bare):

```js
const { QVACRegistryClient } = require('@qvac/registry-client')
const client = new QVACRegistryClient() // built-in default registry key
await client.ready()
await client.downloadModel(
  'qvac_models_compiled/ABot-World-0-5B-LF/2026-07-17/abot-world-0-5b-lf-dit-q8_0.gguf',
  's3',
  { outputFile: '/abs/path/dit.gguf', timeout: 600000, onProgress: (p) => {} }
)
await client.close()
```

Apps built on the QVAC SDK can instead discover the set at runtime via
`modelRegistrySearch({ filter: 'ABot' })` and download with the returned
`registrySource`/`registryPath`.

(`s3` in these commands is the registry's *source label* for this entry set —
part of the public registry protocol, not a storage URL.)

`scripts/download-model-abot.sh` wraps the same downloads and defaults to
`test/model/abot`, the directory the integration tests use (the CI lanes
provision the same files themselves via `@qvac/registry-client`).

> If `npm install -g` fails with `EACCES` on a host without sudo, install
> locally instead: `npm i @qvac/registry-client` in a scratch directory and
> run `./node_modules/.bin/qvac-registry` from there.

## Hardware requirements

Measured on an RTX 5090 (32 GB) with the Q8 DiT, KV cache on, 832x480 —
the validated end-user configuration:

| requirement | minimum (832x480 interactive) | notes |
|---|---|---|
| GPU VRAM | **≥ 20 GB free**; a **24 GB card is the practical minimum** | 16.3 GB steady (weights + F32 KV ring) + ~2.7 GB transient compute at the first block. The card must be *dedicated*: another process holding VRAM OOMs the first walk block even though load succeeds (see [Troubleshooting](#troubleshooting)) |
| host RAM | 4 GB process / **8 GB system** | 3.1 GB max RSS measured; 8 GB keeps the 7.3 GB walk model set page-cached |
| CPU | 2 physical cores | ~1.1 cores average during a walk |
| disk | **14 GB** (7.3 GB if scenes are created elsewhere) | 4 GGUFs + scene packs |
| PSU / thermal | ~450 W sustained per GPU | the walk holds 50–83 % GPU utilization |

**Optimal setup:** an RTX 5090-class GPU with nothing else resident,
`ABOT_KV_CACHE=1`, and NVMe storage (cold model load ~12 s, warm 1.5 s).
With two GPUs, split the modules — `ABOT_BACKEND="diffusion=cuda0,vae=cuda1"`
— to keep scene creation off the walk GPU. Measured at this tier: **1.78
s/block, 6.7–6.8 fps generation, 16.3 GB peak VRAM**, flat across 45+ blocks.

**Low-VRAM tier:** 448x256 walks run on ~6 GB GPUs (validated on a laptop
RTX 4050) — usable for development, far below interactive frame rates.

Running without the KV cache (`kvCache: false`) shrinks steady VRAM to
~15.1 GB but block times ramp from 1.8 s to 7.5 s as the recompute window
fills — fine for tests, not for interactive walking. Prefer freeing VRAM and
keeping the cache on.

## Building the addon

Prerequisites: Node 20+, `bare` and `bare-make` (`npm i -g bare bare-make`),
a C++ toolchain (MSVC + clang-cl on Windows, clang on Linux/macOS), CMake, and
`GH_TOKEN` in the environment — a GitHub PAT with `repo` scope for the private
vcpkg registry (see `.env.example` at the repo root).

```bash
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/diffusion-cpp
npm install
npm run build            # TypeScript + native build (Vulkan GPU by default on win/linux)
```

GPU backend variants:

```bash
npm run build:cuda       # NVIDIA CUDA (requires the CUDA toolkit; nvcc on PATH)
npm run build:vulkan     # explicit Vulkan (the default on Windows/Linux)
```

macOS builds default to Metal; Android to OpenCL+Vulkan. The engine
(`stable-diffusion-cpp 2026-07-03#6`) and `ggml` resolve from the QVAC vcpkg
registry; the only overlay left in this package is a one-flag local ggml
patch needed for Linux CUDA builds.

## Running the interactive demo

`examples/world-walk-server.js` serves a browser page with a video window and
WASD/IJKL keyboard control, backed by a walk session.

```bash
export ABOT_MODELS_DIR=/path/to/models     # dir containing the 4 GGUFs
export ABOT_KV_CACHE=1                     # per-layer KV cache: the main speed knob
bare examples/world-walk-server.js
```

Then open **http://127.0.0.1:8787**. If a `scene.safetensors` exists in
`ABOT_MODELS_DIR` it walks that world; otherwise the server starts in a
"no world yet" state and you use the page's **"Generate a world"** card:
upload a JPEG/PNG (any resolution; it is cover-scaled and center-cropped)
plus an optional description, and walk it a few seconds later. The
**Restart world** button re-spawns at the first frame.

Useful environment knobs (all optional):

| var | default | effect |
|---|---|---|
| `ABOT_DIT` / `ABOT_TAEHV` / `ABOT_SCENE` / `ABOT_T5` / `ABOT_VAE` | files in `ABOT_MODELS_DIR` | explicit model paths |
| `ABOT_PROMPT` + `ABOT_IMAGE` | — | create the scene at startup when `ABOT_SCENE` does not exist yet |
| `ABOT_WIDTH` x `ABOT_HEIGHT` | 832x480 | world resolution (multiples of 32; 832x480 is the model's native training resolution, 448x256 the validated low-VRAM point) |
| `ABOT_BACKEND` | best available | `cpu`, `cuda`, `vulkan`, `metal`, exact device (`CUDA0`), or per-module (`"diffusion=cuda0,vae=cuda1"`) |
| `ABOT_KV_CACHE=1` | off | KV cache (~3.7x fewer frame passes; forwarded as the `kvCache` session param) |
| `ABOT_JPEG_QUALITY` | 0 (PNG) | 1..100: JPEG frames — much lighter streams for remote playback (85 is a good value) |
| `ABOT_THREADS` / `ABOT_SEED` | auto / 42 | CPU threads / walk noise seed |
| `HOST` / `PORT` | 127.0.0.1 / 8787 | bind address |

### Local playback

Run the server and open the page on the same machine — nothing else needed.
The page shows generation fps, playback fps and per-block timing live.

### Playback over SSH

Run the server on the GPU host, tunnel the port from your local machine, and
open the page locally (`-i` only if you authenticate with a key file):

```bash
ssh -N -L 8787:localhost:8787 USER@REMOTE_ADDR -i PRIV.KEY
```

Then open http://127.0.0.1:8787 in your local browser. For tunneled links,
set `ABOT_JPEG_QUALITY=85` on the server — it streams frames as MJPEG with
drop-on-backpressure and paced delivery, so remote playback stays smooth and
key-to-reaction latency stays at the generation-bound floor (typical ~0.6 s
key→block wait + one ~1.8 s block on an RTX 5090; validated hands-on over a
tunnel at 6.7 fps with no degradation vs local).

### End-to-end on a remote GPU host (copy-paste)

The complete sequence for a fresh Linux CUDA host — build, fetch models,
serve, walk from your laptop. Each step's expected outcome is noted so the
run can be verified as it goes.

```bash
# 1. code + deps (needs GH_TOKEN with repo scope for the private vcpkg registry)
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/diffusion-cpp
npm install
export GH_TOKEN=<your PAT>

# 2. build with CUDA (~10 min cold: vcpkg fetches + compiles the engine)
npm run build:cuda       # ends with: prebuilds/linux-x64/qvac__diffusion-cpp.bare

# 3. models from the P2P registry (~13.3 GB total, no credentials)
npm install -g @qvac/registry-client   # EACCES without sudo? see the note in "Getting the models"
mkdir -p ~/abot-models && cd ~/abot-models
P=qvac_models_compiled/ABot-World-0-5B-LF/2026-07-17
qvac-registry download "$P/abot-world-0-5b-lf-dit-q8_0.gguf" s3 -o abot-world-0-5b-lf-dit-q8_0.gguf
qvac-registry download "$P/taew2_2_f16.gguf"                 s3 -o taew2_2_f16.gguf
qvac-registry download "$P/umt5-xxl-enc-q8_0.gguf"           s3 -o umt5-xxl-enc-q8_0.gguf
qvac-registry download "$P/wan2.2_vae_f16.gguf"              s3 -o wan2.2_vae_f16.gguf

# 4. serve (no scene pack needed - the browser page creates the world)
cd - # back to packages/diffusion-cpp
export ABOT_MODELS_DIR=~/abot-models
export ABOT_KV_CACHE=1 ABOT_JPEG_QUALITY=85 ABOT_BACKEND=cuda
bare examples/world-walk-server.js
# logs: "no scene pack yet - open the page and use Generate a world"
```

On your **local** machine:

```bash
ssh -N -L 8787:localhost:8787 USER@REMOTE_ADDR -i PRIV.KEY
```

then open http://127.0.0.1:8787 — upload an image on card 1 (a few seconds),
press **Start walk** on card 2, hold W/A/S/D to move and I/J/K/L to look.

## Building an app on the world API

```js
const WorldStableDiffusion = require('@qvac/diffusion-cpp/world')

const world = new WorldStableDiffusion({
  files: {
    model: '/abs/path/abot-world-0-5b-lf-dit-q8_0.gguf',
    taehv: '/abs/path/taew2_2_f16.gguf',
    scene: '/abs/path/scene.safetensors' // consumed by walks, produced by createScene
  },
  config: { seed: 42, kvCache: true }
})

// 1. create a world (once) - prompt + first-frame image -> scene pack
const creation = await world.createScene({
  prompt: '| unknown | A realistic outdoor world scene with a navigable path.',
  image: fs.readFileSync('first-frame.jpg'),   // PNG/JPEG bytes, any size
  t5: '/abs/path/umt5-xxl-enc-q8_0.gguf',
  vae: '/abs/path/wan2.2_vae_f16.gguf',
  output: '/abs/path/scene.safetensors',
  width: 832, height: 480                      // multiples of 32
})
await creation.onUpdate(() => {}).await()

// 2. walk it
await world.load()                             // DiT + taehv + scene stay resident
const response = await world.step({ W: true }) // or ['W','J'], or a raw 8-bit mask
await response.onUpdate((data) => {
  if (data instanceof Uint8Array) frames.push(data)  // PNG/JPEG frame
  else console.log(data)                             // progress JSON
}).await()
await world.unload()
```

Key API facts:

- **`config`**: `threads`, `seed`, `backend`, `numFramePerBlock` (default 3),
  `localAttnSize` (default 8 — with `kvCache` the engine validates the window
  against the compiled KV ring and **fails at load** on an unsupported
  combination), `offloadParamsToCpu`, `frameJpegQuality` (0 = PNG, 1..100 =
  JPEG), `kvCache`, `profile`. Types ship in `world.d.ts`.
- **Keys**: object `{ W: true, L: true }`, array `['S','J']`, or a raw mask
  built from the exported `ActionFlag` named bits
  (`world.step(ActionFlag.W | ActionFlag.L)`; bit 0..7 = `W A S D I J K L`;
  WASD move, IJKL camera). Case-insensitive; unknown keys throw.
- **One step at a time**: a second `step()` while a block is still streaming
  rejects with `Cannot set new job...` — await the response first (drive your
  key loop off that contract, as the demo does).
- **`createScene` is standalone** — works before `load()`, loads its
  encoders per call and frees them after. Scene resolution is baked into the
  pack; create one pack per resolution you need.
- **Failures are terminal per session**: if a step fails, `unload()` and
  create a fresh instance (the engine's RNG/history cannot be resumed).
- **Cancellation has block granularity**: the engine exposes no mid-block
  abort hook, so `cancel()` lets the current DiT block finish internally,
  stops the remaining frame delivery, and rejects the in-flight `step()`
  with the typed `Diffusion/Cancelled` error (never a silently truncated
  "success"). Treat it like any failed step: reload the session.
  `createScene()` is **uninterruptible** (no engine abort hook yet) — a
  `cancel()` or `unload()` issued during a scene creation blocks until the
  encode completes, so await the creation response before tearing down.
- **`unload()` settles in-flight work**: it cancels, fails any job that was
  admitted but never started (`Model was unloaded`), and releases the busy
  guard — the instance can be `load()`-ed again afterwards.
- **Sizing**: 832x480 native quality (390 latent tokens/frame), 448x256 for
  ~6 GB GPUs. Attention cost scales ~quadratically with pixel area.

## Performance vs the PyTorch reference

Measured on the same RTX 5090, same 16-block walk (832x480, 12 frames/block):
QVAC = this addon (Q8 DiT, KV cache); reference = the upstream
`ABot-World` PyTorch pipeline in its deployed default quantization
(fp8-per-token, Triton SLA attention).

| metric (walk phase) | QVAC addon | PyTorch reference |
|---|---|---|
| block time / generation rate | 1758 ms — **6.8 fps** | ~420 ms — **28.5 fps** |
| GPU utilization (avg) | 73.9 % | 73.6 % |
| VRAM peak | 16.3 GB | 10.6 GB |
| host RAM peak | **3.1 GB** | **43.6 GB** (load/quantize; 17.5 GB steady) |
| CPU load (avg) | 1.1 cores | 2.3 cores |
| time to first frame | **1.5 s** (warm) | **~54 s** (load + on-the-fly fp8 quantize) |
| on-disk footprint | 13.3 GB models + 257 MB addon | ~28 GB checkpoints + ~10 GB Python venv |
| software stack | bare runtime only | Python + torch/cu129 + Triton |

The honest headline: **the QVAC build is ~4.2x slower per block** — the
biggest known con of the current implementation. Both stacks saturate the GPU
to the same utilization; the gap is per-op efficiency (the reference's fused
SLA attention + fp8 GEMMs vs ggml kernels plus a masked-attention composition
kept compatible with the registry ggml — the fused-softmax kernel in a newer
ggml would reclaim ~15 % on its own). What QVAC buys for that price: 36x
faster startup, 14x less host RAM, half the CPU, ~2.5x less disk, higher VRAM
need (+5.7 GB, the F32 KV ring — an F16 ring upstream would swing VRAM below
the reference too), and zero Python — a single self-contained native module
that embeds in bare/Node apps.

## Validation

The `test/integration/abot-world.test.js` lanes (guard, fixed-scene walk,
world generation, variations) run on the Linux x64 GPU pool in CI, and
`test/unit/world-input-validation.test.js` covers the full key/params input
matrix. The engine-side parity story (golden replays vs the PyTorch
reference, scene-pack cosine gates) lives in the engine repo's PR #22/#27
documentation. The full shipped pipeline — registry engine port, P2P model
set, native scene creation, 45+ block walks over an SSH tunnel — was
validated hands-on on an RTX 5090 with zero errors and flat VRAM.

## Troubleshooting

**1. OOM at the first walk block — but the session loaded fine.**
Signature: `ggml_backend_cuda_buffer_type_alloc_buffer: ... cudaMalloc
failed: out of memory` then `ABot-World walk step failed`. Loading only
allocates the persistent ~16.3 GB; the first block adds a ~2.7 GB transient
compute reservation, and that is what tips over when **another process holds
VRAM on the same GPU** (this makes it look like a walk bug — it isn't). Check
`nvidia-smi` for co-tenants first; free the card or move to a dedicated one
(≥ 20 GB free). Dropping to 448x256 or `kvCache: false` also fits smaller
budgets, at a heavy speed cost.

**2. "failed to create ABot-World walk session" at startup.**
The scene pack (`ABOT_SCENE` / `scene.safetensors`) does not exist yet. The
demo server handles this: it starts in a "no world yet" state and waits for
the page's **Generate a world** upload (or `ABOT_PROMPT` + `ABOT_IMAGE` at
startup). In your own app, call `createScene()` before `load()`.

**3. Linux CUDA build fails linking the addon (relocation / fPIC errors).**
The package-local ggml overlay (`vcpkg/overlay-ports/ggml`, which only adds
`CMAKE_POSITION_INDEPENDENT_CODE=ON`) was not picked up — verify the
directory exists and rerun `npm run build:cuda` (it regenerates the CMake
tree). vcpkg fetch failures right before this usually mean `GH_TOKEN` is
missing or expired.

**4. The walk stops and every further `step()` rejects.**
A failed step is **terminal by design** — the native session's RNG/history
cannot be resumed after a mid-block failure. `unload()` and create a fresh
instance (the demo's **Restart world** button does exactly this). The step's
error and the native log carry the root cause — most commonly the VRAM
squeeze from issue 1.

**5. The world drifts or stops reacting to keys after long walks.**
Architectural, not a bug: the model attends to ~2.7 s of history
(`localAttnSize: 8` blocks), so scenery beyond that horizon is re-imagined
rather than remembered, and heavily degraded worlds can stop steering.
Restart the world (fresh session at block 0). Larger attention windows are
gated by the compiled KV ring and the VRAM budget above.
