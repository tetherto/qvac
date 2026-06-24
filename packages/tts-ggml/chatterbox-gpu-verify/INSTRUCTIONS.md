# Chatterbox GPU-vs-CPU on-device verification (QVAC-20557)

Run **Chatterbox** end-to-end on a physical Android device and capture audio + logs, so we can verify the GPU path
**by ear** and from the per-stage `[gpu-diag]` trace. **CPU is the known-good reference; the GPU run is what we verify.**

This is **Chatterbox-only** (the runner never loads Supertonic). The runner is a thin wrapper over the package's existing
synth helpers (`test/utils/runChatterboxTTS.js`); one synthesis per process.

> **Verified end-to-end on 2026-06-23** on an Adreno 740 (SM8550): build → deploy → on-device GPU synth → pullable WAV +
> `result.json` + tag-filtered `[gpu-diag]` all work. `ports/tts-cpp` → `63f25312` (both Chatterbox stages
> `allow_arm_mali=true`). **The ggml-speech pin depends on the branch:** `#2734` pins `25655933` (conv_transpose
> ARM-gate **ON** → conv_transpose routed to the Mali CPU); the **`QVAC-20557-mali-convtranspose-gpu-probe`** branch pins
> `e303be3f` (gate **OFF** → conv_transpose stays on the Mali GPU). See **Findings** below for why this matters.

---

## Findings so far (2026-06-24) — there is a 12 kHz whine, and it lives on the Mali **CPU** path

Running the full matrix on a real **Mali Pixel 9a** (off the gated `#2734` build) surfaced a constant **sharp ~12 kHz
(Nyquist) tone** sitting behind the speech — present in the GPU run **and** the all-CPU run. Forensic analysis (ledger
rounds L/M + on-device Adreno-vs-Mali CPU comparison) shows:

- **It is NOT a GPU-compute bug, and NOT GPU-vs-CPU divergence.** On Mali, the GPU S3Gen output matches the CPU output
  stage-for-stage (the #28 Vulkan fixes are numerically correct).
- **The tone is Mali-device-specific and lives on the CPU `conv_transpose_1d` (HiFT ISTFT) op** (ggml-cpu `armv9.0`
  variant). Adreno's CPU (`armv8.6`) and the Mali **GPU** conv_transpose are both clean. Evidence: Mali-GPU hift rms
  `0.022` ≈ Adreno `0.020`; **Mali-CPU `0.103` is the lone outlier** = clean speech (`~0.03`) + a `~0.16`-amplitude
  12 kHz tone.
- **#28's `CONV_TRANSPOSE_1D` ARM `supports_op` gate** routes conv_transpose **off the (correct) Mali GPU onto the
  (toney) Mali CPU** — so the gated `#2734` build whines on the GPU path too. The gate was added against a contaminated
  Mali-CPU reference; the "5× quiet" GPU output it tried to "fix" was actually correct.

**What the `...-convtranspose-gpu-probe` branch tests:** pinning ggml-speech to `e303be3f` (= #28 tile + FA fixes
**without** the conv_transpose gate) keeps conv_transpose on the Mali GPU. Run two configs and compare **by ear**:

| run | command | conv_transpose runs on | expected |
|---|---|---|---|
| `mali-ct-gpu`  | `03-run-config.sh turbo cpu gpu mali-ct-gpu`  | **Mali GPU** | **CLEAN** — no 12 kHz whine, intelligible |
| `mali-cpu-ref` | `03-run-config.sh turbo cpu cpu mali-cpu-ref` | Mali CPU     | **still whines** (the contrast that isolates the Mali-CPU bug) |

**Mandatory self-check:** `mali-ct-gpu.gpudiag.txt` MUST contain `[gpu-diag] hift primary_runs_all=1 mali_vulkan=1` —
that proves conv_transpose actually ran on the Mali GPU (gate gone). If it shows `primary_runs_all=0`, the rebuild didn't
take and the result is invalid (re-run `01-build-android.sh`).

---

## How Chatterbox works (so the matrix makes sense)

Chatterbox is **one model made of two stages run in sequence** (never in parallel):

1. **T3** — text → speech tokens (autoregressive).
2. **S3Gen** — speech tokens → waveform (vocoder).

The model is *stored* as **two `.gguf` files** (T3 weights + S3Gen weights); **both are required** to make audio. You
select the model with a **single** input — `CHBX_VARIANT=turbo|mtl` — and the runner derives both filenames. The
`S3Gen/T3` axis only chooses **which stage runs on GPU vs CPU** within that one synthesis.

GGUFs per variant (must be present in `MODEL_DIR` on the device):
- **turbo**: `chatterbox-t3-turbo.gguf`, `chatterbox-s3gen.gguf`
- **mtl**:   `chatterbox-t3-mtl.gguf`,   `chatterbox-s3gen-mtl.gguf`

---

## The matrix — 8 samples = 2 (CPU/GPU) × 2 (S3Gen/T3) × 2 (turbo/MTL)

Backend placement: `useGPU = (S3GEN_BACKEND==gpu)` (both stages attempt GPU); `T3_BACKEND=cpu` adds
`TTS_CPP_T3_FORCE_CPU=1` (pins T3 to CPU). There is **no** S3Gen-force-CPU lever, so `(T3=gpu, S3Gen=cpu)` is
unreachable — and unneeded, since CPU is the reference.

| label              | CHBX_VARIANT | T3_BACKEND | S3GEN_BACKEND | placement (T3,S3Gen) | what it checks |
|--------------------|--------------|------------|---------------|----------------------|----------------|
| turbo-s3gen-cpu    | turbo        | cpu        | cpu           | (CPU,CPU)            | all-CPU reference |
| turbo-s3gen-gpu    | turbo        | cpu        | gpu           | (CPU,GPU)            | **S3Gen on GPU** (T3 fixed CPU → deterministic). By ear should **match** turbo-s3gen-cpu. |
| turbo-t3-cpu       | turbo        | cpu        | gpu           | (CPU,GPU)            | same placement as turbo-s3gen-gpu (identical audio). |
| turbo-t3-gpu       | turbo        | gpu        | gpu           | (GPU,GPU)            | **T3 on GPU**, end-to-end. T3 is stochastic → judge coherence vs CPU, not a match. |
| mtl-s3gen-cpu / -gpu / t3-cpu / t3-gpu | mtl | (same four) | | | same four for MTL |

`*-t3-cpu` ≡ `*-s3gen-gpu` (same placement → identical audio); `04-run-all.sh` copies the file so you still get 8 named WAVs.

---

## Prerequisites
- **The four GGUFs.** If `packages/tts-ggml/models/` doesn't already have them, download from the public QVAC registry
  (no token needed):
  ```sh
  cd packages/tts-ggml
  node scripts/download-tts-ggml-models.js --group chatterbox,chatterbox-mtl
  ```
  This fetches `chatterbox-t3-turbo.gguf` + `chatterbox-s3gen.gguf` (turbo) and `chatterbox-t3-mtl.gguf` +
  `chatterbox-s3gen-mtl.gguf` (mtl) into `packages/tts-ggml/models/` — the default `MODELS_DIR` that `02-deploy.sh` pushes.
  (turbo-only is enough for the probe: `--group chatterbox`.)
- Android NDK + `bare` + `bare-make` + vcpkg toolchain (to build the addon). The vcpkg overlay pins are in `../ports`.
- The Android `bare` CLI: `npm pack bare-runtime-android-arm64@<host-bare-version>` → `package/bin/bare` (must match your
  host `bare --version`).
- The NDK aarch64 `libc++_shared.so` (the addon is built with `c++_shared`).
- `adb` with the device authorized (`adb get-state` = `device`).

## Steps (helper scripts in this folder)

```sh
# 1. build the arm64-android prebuild from the overlay
bash chatterbox-gpu-verify/01-build-android.sh

# 2. deploy package + bare CLI + libc++ + models to the device
BARE_CLI=/path/to/package/bin/bare \
LIBCXX_SO="$ANDROID_NDK/toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" \
MODELS_DIR=./models \
bash chatterbox-gpu-verify/02-deploy.sh

# 3. run the whole 8-sample matrix (pulls AUDIO first, then result.json, then logcat, per run)
OUT_DIR=./chbx-results bash chatterbox-gpu-verify/04-run-all.sh
# ...or a single config:
OUT_DIR=./chbx-results bash chatterbox-gpu-verify/03-run-config.sh turbo gpu gpu turbo-t3-gpu
```

Each run produces, under `OUT_DIR` (default `./chbx-results`):
- `<label>.wav` — the audio (LISTEN to it).
- `<label>.result.json` — `backendDevice / backendId / gpuUnsupported / realTimeFactor / sampleCount / durationMs / passed`.
- `<label>.gpudiag.txt` — the per-stage `[gpu-diag]` trace (tag-filtered `qvac-chatterbox`).
- `<label>.console.txt` — native stdout (`ggml` init, `BENCH: S3GEN_INFER_MS/AUDIO_MS`, backend selection).

Zip `<label>.wav` + `<label>.gpudiag.txt` (+ console/result) per sample and send back.

## How to read the results
- **Which backend actually ran S3Gen?** Read the `[gpu-diag]` per-stage **prefix** (`Vulkan.s3gen.*` / `OpenCL.s3gen.*`
  vs `CPU.s3gen.*`), NOT `result.json`'s `backendDevice`. `backendDevice` reports the **T3** backend — so a
  `*-s3gen-gpu` run (T3 forced to CPU) shows `backendDevice=0` even though S3Gen ran on the GPU. Also read
  `[gpu-diag] hift primary_runs_all=…`: `1` = HiFT (incl. conv_transpose) ran entirely on the primary backend (the GPU on
  the probe branch); `0` = the scheduler routed conv_transpose to CPU (the gated `#2734` build, and Adreno always).
- **Listen for the 12 kHz whine.** A constant, sharp, high-pitched tone behind the words = the Mali-CPU conv_transpose
  artifact (see Findings). On the **probe** branch the `mali-ct-gpu` run (conv_transpose on the Mali GPU) should be
  **clean**; the `mali-cpu-ref` run should still whine. (To measure: a dominant tone at fs/2 = 12 kHz drives the
  zero-crossing rate to ~0.86 vs ~0.08 for clean speech — visible as a flat bright line at the top of a spectrogram.)
- **By ear (general matrix):** with conv_transpose routed identically, S3Gen-GPU vs the matching CPU sample should sound
  the same (identical T3-CPU tokens); T3-GPU is stochastic ⇒ judge coherence, not a sample-for-sample match. On the probe
  branch the GPU and CPU samples will DIFFER (GPU clean, CPU whiny) — that difference is the result.
- **Per-stage `[gpu-diag]`:** every stage should read `nan=0`. (Observed-benign exception: `hift.y_postdiv` may show
  `nan=1` from a window-edge divide; it is cleared by `hift_wav` which must be `nan=0`.)

## Notes / gotchas (all handled by the scripts)
- The runner writes a **result file** because bare's JS `console.log` is swallowed over `adb shell` (native `ggml`
  stdout does come through). Native `[gpu-diag]` goes to **logcat** (`__android_log`, tag `qvac-chatterbox`) — capture it
  **tag-filtered** (`adb logcat -d -s 'qvac-chatterbox:*'`) or the driver spam rolls it out.
- The runner calls `proc.exit(0)` after writing artifacts (bare can otherwise hang on exit with the GPU context open);
  `03-run-config.sh` also wraps the run in a `timeout` (default 300 s) as a hard safety net.
- Push `node_modules` as the bundled tarball (done by `02-deploy.sh`) — a raw `adb push` of ~30k files drops the USB link.

_DO-NOT-MERGE diagnostic harness._
