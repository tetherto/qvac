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
- **Walk**: each `step(keys)` denoises one block (12 latent frames at the
  default config) and streams decoded frames (PNG, or JPEG via config).

## Models

| role | file | size | quant |
|---|---|---|---|
| world model (walk) | `abot-world-0-5b-lf-dit-q8_0.gguf` | 5.5 GiB | Q8_0 |
| pixel decoder (walk) | `taew2_2_f16.gguf` | 22 MiB | F16 |
| prompt encoder (scene creation) | `umt5-xxl-enc-q8_0.gguf` | 5.6 GiB | Q8_0 |
| first-frame encoder (scene creation) | `wan2.2_vae_f16.gguf` | 1.3 GiB | F16 |

All four are published in the **QVAC P2P model registry** (engine
`@qvac/diffusion-cpp`, tag `abot-world`).

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

(Internal alternative: `scripts/download-model-abot.sh` fetches the same set
from corp S3 — used by CI, needs AWS credentials.)

## Building the addon

Prerequisites: Node 20+, `bare` and `bare-make` (`npm i -g bare bare-make`),
a C++ toolchain (MSVC + clang-cl on Windows, clang on Linux/macOS), CMake, and
`GH_TOKEN` in the environment — a GitHub PAT with `repo` scope for the private
vcpkg registry (see `.env.example` at the repo root).

```bash
cd packages/qvac/packages/diffusion-cpp   # inside the qvac monorepo
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
`ABOT_MODELS_DIR` it walks that world; otherwise use the page's
**"Generate a world"** card: upload a JPEG/PNG (any resolution; it is
cover-scaled and center-cropped) plus an optional description, and walk it
~20 s later. The **Restart world** button re-spawns at the first frame.

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

Run the server on the GPU host, tunnel the port, and open the page locally:

```bash
ssh -N -L 8787:localhost:8787 user@gpu-host
```

Then open http://127.0.0.1:8787 in your local browser. For tunneled links,
set `ABOT_JPEG_QUALITY=85` — the server streams frames as MJPEG with
drop-on-backpressure and paced delivery, so remote playback stays smooth and
key-to-reaction latency stays at the generation-bound floor (~2.2 s at
1.5 s/block on an RTX 5090).

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
- **Keys**: object `{ W: true, L: true }`, array `['S','J']`, or raw mask
  (bit 0..7 = `W A S D I J K L`; WASD move, IJKL camera). Case-insensitive;
  unknown keys throw.
- **One step at a time**: a second `step()` while a block is still streaming
  rejects with `Cannot set new job...` — await the response first (drive your
  key loop off that contract, as the demo does).
- **`createScene` is standalone** — works before `load()`, loads its
  encoders per call and frees them after. Scene resolution is baked into the
  pack; create one pack per resolution you need.
- **Failures are terminal per session**: if a step fails, `unload()` and
  create a fresh instance (the engine's RNG/history cannot be resumed).
- **Sizing**: 832x480 native quality (390 latent tokens/frame), 448x256 for
  ~6 GB GPUs. Attention cost scales ~quadratically with pixel area.

## Validation

The `test/integration/abot-world.test.js` lanes (guard, fixed-scene walk,
world generation, variations) run on the Linux x64 GPU pool in CI, and
`test/unit/world-input-validation.test.js` covers the full key/params input
matrix. The engine-side parity story (golden replays vs the PyTorch
reference, scene-pack cosine gates) lives in the engine repo's PR #22/#27
documentation.
