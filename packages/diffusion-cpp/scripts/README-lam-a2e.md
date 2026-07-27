# LAM Audio2Expression — GGUF conversion and parity tooling

Developer-time tooling for the `LamAudio2Expression` API exported by
`@qvac/diffusion-cpp`. It turns the upstream
[LAM_Audio2Expression](https://github.com/aigc3d/LAM_Audio2Expression)
PyTorch checkpoint (Apache-2.0) into a `lam-audio2exp` GGUF that the isolated
LAM-A2E engine in `qvac-ext-stable-diffusion.cpp` can load.

These scripts are **not** shipped to npm consumers.

## Files in this directory

| File | Purpose |
|---|---|
| `_lam_a2e_arch.py` | Shared tensor name map, KV metadata, and the positional-conv weight-norm fold. Imported by both converters so the two paths cannot drift. |
| `convert-lam-a2e-to-gguf.py` | The converter. Takes the upstream `.tar` checkpoint, writes a `lam-audio2exp` GGUF. |
| `remap-lam-a2e-gguf.py` | No-torch fallback. Takes a raw GGUF that still carries PyTorch tensor names and rewrites it into the same dialect. |
| `dump-lam-a2e-stages.py` | Generates per-stage parity fixtures from the trusted PyTorch reference (feeds `lam-a2e-parity`). |
| `dump-lam-a2e-frontend-reference.py` | Generates the Wav2Vec2 frontend fixture (feeds `lam-a2e-frontend-smoke`). |
| `requirements.txt` | Pip deps for the converters (`gguf`, `numpy`, CPU `torch`). |
| `setup-venv.sh` | One-shot provisioning: creates `./venv` and installs `requirements.txt`. Idempotent. |
| `convert-lam-a2e.sh` | Thin wrapper around the converter. Fetches and caches the upstream checkpoint when `--checkpoint` is omitted, auto-discovers `./venv`, sanity-checks the modules, and forwards arguments. |
| `wav-to-pcm.js` | Audio-side converter. Decodes a `.wav` (or any container ffmpeg handles) into the raw float32 PCM the runtime expects. No Python involved. |
| `make-tiny-lam-a2e-gguf.py` | Builds a sub-megabyte random-weight GGUF for the structural test tier. Needs no checkpoint and no torch. |
| `requirements-tiny.txt` | Pip deps for the tiny generator alone (`gguf`, `numpy`). A subset of `requirements.txt`. |
| `check-lam-a2e-parity.js` | Numerical gate. Runs recorded PCM through a real GGUF and diffs the ARKit-52 output against PyTorch-dumped references. |

## The two assets

Running LAM-A2E needs exactly two inputs, produced by two independent
toolchains:

| Asset | Produced by | Format |
|---|---|---|
| Model | `convert-lam-a2e-to-gguf.py` (Python/venv) | `lam-audio2exp` GGUF |
| Audio | `wav-to-pcm.js` (Bare/ffmpeg) | raw LE float32, 16kHz mono |

The audio contract is not negotiable: `LamAudio2Expression.run()` rejects
anything other than a `Float32Array` at `sampleRate === 16000`. A `.wav` header
is 44 bytes of metadata the runtime has no parser for, which is why the file
gets decoded to headerless samples first.

## Quickstart — the full pipeline

Three steps: build the model, prepare the audio, run them together. The
commands below are verbatim and were run end to end on a clean checkout; the
whole thing takes about four minutes the first time and seconds after that.

```bash
cd packages/diffusion-cpp

# One-time: provision the local venv (gguf, numpy, CPU torch).
npm run setup:venv
```

### 1. Model — checkpoint to GGUF

Omitting `--checkpoint` makes the script fetch the upstream one itself.

```bash
npm run convert:lam-a2e -- --out models/lam-audio2exp-f32.gguf
```

```
Downloading checkpoint (~373MB) to .cache/lam-a2e/LAM_audio2exp_streaming.tar
Extracting pretrained_models/lam_audio2exp_streaming.tar
Converting LAM Audio2Expression checkpoint -> .gguf
wrote models/lam-audio2exp-f32.gguf (402.0 MB tensor data, dtype=f32)
```

About 4 minutes, dominated by the download. The checkpoint is cached, so
building the F16 variant afterwards takes ~9 seconds:

```bash
npm run convert:lam-a2e -- --out models/lam-audio2exp-f16.gguf --dtype f16
```

### 2. Audio — wav to PCM

Any container ffmpeg can demux works here, not just `.wav`.

```bash
npm run convert:wav-to-pcm -- \
    ../transcription-parakeet/examples/samples/jfk.wav \
    -o fixtures/jfk.pcm
```

```
Codec       : pcm_s16le @ 16000Hz
Output      : f32le mono @ 16000Hz
Samples     : 176000 (11.00s)
Wrote       : 704000 bytes to fixtures/jfk.pcm
```

### 3. Inference — PCM to ARKit-52

```bash
LAM_A2E_GGUF="$PWD/models/lam-audio2exp-f32.gguf" \
AUDIO_PCM_PATH=fixtures/jfk.pcm \
OUT_PATH=fixtures/jfk-arkit52.json \
    bare examples/lam-a2e.js
```

```
Loaded in 1.0s
Inference completed in 1.5s — got 330 frame(s)
Wrote 330 x 52 coefficients (545606 bytes) to fixtures/jfk-arkit52.json
```

330 frames is `ceil(176000 x 30 / 16000)`, and 11 seconds of audio in 1.5
seconds is roughly 7x realtime on CPU.

`files.model` is validated as an absolute path, so `LAM_A2E_GGUF` must be
absolute — a relative path fails before the model is ever opened.

### The output file

`OUT_PATH` picks its format from the suffix. A `.json` suffix gives a
self-describing file:

```json
{
  "sampleRate": 16000,
  "fps": 30,
  "nCoeffs": 52,
  "frameCount": 330,
  "durationSeconds": 11,
  "coeffNames": ["browDownLeft", "...", "tongueOut"],
  "frames": [{ "timestampUs": 0, "arkit52": [0.001044, "..."] }]
}
```

`coeffNames` is Apple's fixed ARKit-52 ordering and matches the
`lam-audio2exp.coeff_names` array in the GGUF. It appears once at the top level
rather than inside every frame; each frame's `arkit52` is index-aligned to it,
so `arkit52[24]` is `jawOpen`. Values are post-sigmoid and therefore in `0..1`.

Any other suffix writes raw little-endian float32 in `(frames x 52)` row-major
order with no header — the same layout as the parity fixtures, so the two can
be diffed without a parser in between. The same 11-second clip comes to 68,640
bytes that way, versus ~545 KB as JSON.

## Checkpoint handling

The download lands in `./.cache/lam-a2e/`, which is gitignored, and is reused
on later runs. `wget -c` resumes a partial file, so an interrupted 373 MB pull
does not restart from zero, and the byte count is verified before extraction —
a truncated archive otherwise fails deep inside `torch.load` with an unhelpful
message.

Pass `--checkpoint <file>` to use a checkpoint you already have, which skips
the download entirely. Use `--download-dir <dir>` to cache it somewhere else.
If you fetch it by hand, mind the nesting: the download
is an *outer* archive named `LAM_audio2exp_streaming.tar` that expands to
`pretrained_models/lam_audio2exp_streaming.tar` — lowercase, 408 MB. The inner
file is the one `--checkpoint` wants; the outer one fails inside `torch.load`.

## Skipping the PCM file

The example also accepts an undecoded file via `AUDIO_PATH`, in which case it
runs the same decode in-process and step 2 can be skipped entirely:

```bash
LAM_A2E_GGUF="$PWD/models/lam-audio2exp-f32.gguf" \
AUDIO_PATH=../transcription-parakeet/examples/samples/jfk.wav \
OUT_PATH=fixtures/jfk-arkit52.json \
    bare examples/lam-a2e.js
```

Use `AUDIO_PATH` for one-off runs and `AUDIO_PCM_PATH` for fixtures, where a
byte-stable input matters more than convenience.

In code, the two assets meet like this:

```js
const { LamAudio2Expression } = require('@qvac/diffusion-cpp')

const a2e = new LamAudio2Expression({
  files: { model: '/abs/path/to/lam-audio2exp-f32.gguf' }
})
await a2e.load()

const buf = fs.readFileSync('/abs/path/to/speech.pcm')
const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
const response = await a2e.run(pcm, { sampleRate: 16000 })
```

## Direct invocation (no npm)

Both shell scripts are usable on their own:

```bash
bash scripts/setup-venv.sh
bash scripts/convert-lam-a2e.sh --out models/lam-audio2exp-f32.gguf
```

The remapper has no wrapper — it only needs `gguf` + `numpy`, so run it
against the venv directly:

```bash
./venv/bin/python scripts/remap-lam-a2e-gguf.py \
    --in raw-lam-a2e.gguf \
    --out models/lam-audio2exp-f32.gguf \
    --dtype f32
```

## Testing tiers

Validation is split by what each tier needs, so the cheap one can run
everywhere and the expensive one stays opt-in.

| Tier | Needs | Catches |
|---|---|---|
| Structural + wiring (`test/integration/lam-a2e-behaviour.test.js`) | tiny generated GGUF | wrong frame count, coefficient count drift, NaNs, out-of-range values, unwired identity or audio input, renamed tensors |
| End-to-end parity (`check-lam-a2e-parity.js`) | real GGUF + recorded fixtures | the math being wrong, anywhere between PCM in and coefficients out |
| Per-stage parity (`lam-a2e-parity` in the engine repo) | real GGUF + fixtures | *which* stage the math went wrong in |

The last two overlap on purpose. The end-to-end gate is cheap to run and
answers "is the output right"; the per-stage harness is what you reach for once
the answer is no, because it localises the drift to a specific tensor.

The first tier needs no hosted assets at all:

```bash
python3 -m venv venv && ./venv/bin/pip install -r scripts/requirements-tiny.txt
./venv/bin/python scripts/make-tiny-lam-a2e-gguf.py --out models/lam-a2e-tiny.gguf

LAM_A2E_GGUF="$PWD/models/lam-a2e-tiny.gguf" npm run test:integration
```

The tiny model keeps the real feature-extractor kernels and strides, so the
16kHz → 50Hz → 30fps time axis is exact and frame-count assertions stay
honest; only the layer widths shrink. Its tensor names come from the same
`build_name_map()` the real converter uses, so a rename upstream breaks the
tiny model too rather than silently passing.

Output is deterministic for a given `--seed`. What it cannot tell you is
whether the numbers are *correct* — random weights produce well-formed
nonsense, which is what the parity tier is for.

If `LAM_A2E_GGUF` is unset the suite skips rather than fails, so the tests are
safe to run in a checkout with no assets.

## Running the parity gate

`check-lam-a2e-parity.js` takes a fixture directory containing `manifest.json`
alongside `<case>_input_pcm.bin` and `<case>_expr.bin`, runs each case through
the real model, and diffs every coefficient of every frame.

```bash
bare scripts/check-lam-a2e-parity.js \
    --model "$PWD/models/lam-audio2exp-f32.gguf" \
    --fixtures /path/to/reference
```

It exits non-zero when any case exceeds `--tolerance` (default `1e-3`), so it
drops straight into CI. Measured on CPU against the two recorded cases:

| Build | max abs diff | mean abs diff |
|---|---|---|
| F32 | 2.9e-6 | 1.1e-7 |
| F16 | 1.4e-3 | 3.0e-5 |

F32 clears the default gate with three orders of magnitude to spare. F16 does
not — it halves the file at the cost of roughly 1e-3 on the output, so run it
with `--tolerance 2e-3` and treat F32 as the reference build wherever parity is
the thing being asserted.

## Parity fixtures

`dump-lam-a2e-stages.py` and `dump-lam-a2e-frontend-reference.py` are the
trusted-reference side of the parity gates. They deliberately run the
*original* PyTorch code path, so unlike the converters they:

- import the upstream project (`from models import build_model`) and need its
  project root passed as the first argument, and
- call `.cuda()`, so they need a GPU box.

That means they run inside the upstream project's own environment, **not**
the slim `./venv` provisioned here.

```bash
python scripts/dump-lam-a2e-stages.py \
    ~/LAM_Audio2Expression \
    ~/pretrained_models/lam_audio2exp_streaming.tar \
    ~/fixtures/sample.wav \
    ~/fixtures/win64.npz
```

Each writes an `.npz` plus a sibling `.json` describing shapes and metadata.
The consumers live in `qvac-ext-stable-diffusion.cpp` and take the fixture
directory as an argument, so the fixtures can be staged anywhere:

```bash
lam-a2e-parity <model.gguf> <fixture_dir> <case_prefix>
```

## Notes

- Outputs go under `packages/diffusion-cpp/models/` by convention. That path
  is already in `.gitignore`, as are `*.gguf` and `venv/`.
- `setup-venv.sh` is idempotent; pass `--force` to wipe and recreate.
- The GGUF KV keys written by `_lam_a2e_arch.py` are read by
  `src/lam_audio2expression.cpp` in the engine repo. Changing a key name or
  the `lam-audio2exp` architecture string requires a matching engine change.
- The converter is strict on both sides: it fails if the checkpoint contains
  a tensor the name map doesn't know about, or if a mapped tensor is missing.
  A new upstream revision that adds or renames tensors will surface as a
  loud `unmapped`/`expected tensors not found` error rather than a silently
  broken GGUF.
