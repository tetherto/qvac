# Local benchmark: addon vs llama-server (vision + text)

`run-local.cjs` compares the `@qvac/llm-llamacpp` addon with **llama-server** on any desktop
host where this repo is checked out: macOS, Linux or Windows, on CPU, Metal, Vulkan or CUDA.
It does not run in CI.

It has two suites, and runs both by default:

- **vlm:** a model GGUF plus its mmproj, over the same images, scored for quality and speed.
- **text:** text-only workloads on the same model: single-stream prefill and decode,
  concurrent requests, and speculative decoding (see §6).

```bash
cd packages/llm-llamacpp
# both suites
npm run benchmarks:vlm -- --llm /models/Qwen3.5-0.8B-Q8_0.gguf --mmproj /models/mmproj-Q8_0.gguf
# text only (any text GGUF; no mmproj or fixture needed)
npm run benchmarks:vlm -- --llm /models/Qwen3-8B-Q4_K_M.gguf --suite text
```

**Contents**
1. [What one run does](#1--what-one-run-does)
2. [One-time host setup](#2--one-time-host-setup)
3. [Running](#3--running)
4. [Options](#4--options)
5. [What is held equal between the engines](#5--what-is-held-equal-between-the-engines)
6. [Text suite](#6--text-suite)
7. [Speculative decoding on another host](#7--speculative-decoding-on-another-host-qwen38-27b-mtp-and-dflash)
8. [Benchmarking an unreleased addon change](#8--benchmarking-an-unreleased-addon-change-separate-worktrees)
9. [Output](#9--output)
10. [Comparing machines](#10--comparing-machines)
11. [Troubleshooting](#11--troubleshooting)
12. [Limitations](#12--limitations)

---

## 1 · What one run does

For each backend you ask for (`--backend cpu,gpu`), `run-local.cjs` does these steps. The
image steps (3, 5) are skipped with `--suite text`, the text step (6) with `--suite vlm`:

1. **Checks the host.** It looks for Node ≥ 18, `bare`, `git`, `cmake` and a C/C++
   compiler, and for the vlm suite checks that the fixture images are present. If
   something is missing, it names it and stops.
2. **Prepares the addon.**
   - If `node_modules/` is missing, it runs `npm install`.
   - If `prebuilds/` has no addon build for this platform, it fetches the prebuild of this
     checkout's version from npm for this run only. It is removed when the run ends, so
     later tests in the checkout never load it by accident. The tarball's sha256 is
     recorded with the addon version.
   - A prebuild you already have, for example from `npm run build`, is used as it is.
3. **Runs the addon leg.** The existing harness (`vlm-matrix.test.js`) runs under `bare`
   with your model files: one warmup pass, then the measured passes.
4. **Builds llama-server** from the **qvac-fabric tag the addon is built on**.
   - The tag is `v<version>`, using the `qvac-fabric` version in
     `packages/fabric/vcpkg.json`.
   - The build is cached in `cli-builds/` per OS, arch, backend, GPU API and commit, so
     later runs reuse it. Both suites use the same build.
5. **Runs the llama-server leg.** It starts one server on `127.0.0.1` with a per-run API
   key, sends one warmup request, then posts every fixture item to
   `/v1/chat/completions`.
6. **Runs the text suite.** Each text configuration is one job: the addon in a fresh `bare`
   process, then llama-server freshly started with the same settings (§6).
7. **Writes the reports.** `report.md` (vlm) uses the same renderer as the CI report;
   `text-report.md` and `text-report.html` hold the text suite; `results.json` holds both
   in machine-readable form.

## 2 · One-time host setup

Every host needs:

- **Node.js ≥ 18**
- **A current bare**: `npm install -g bare@latest`. Some installed dependencies need a
  newer bare than the package's own `engines` floor (for example `bare-dns` needs ≥ 1.33);
  the runner checks this before the addon leg and names the package that needs it.
- **git** and **cmake ≥ 3.14**
- **A C/C++ compiler** to build llama-server. The addon itself comes prebuilt.

Extra setup per platform:

- **macOS (Apple silicon):** install the Xcode command-line tools with
  `xcode-select --install`. Metal needs nothing else.
- **Linux:** install `build-essential` (or clang).
  - For `--backend gpu` with Vulkan, the default, also install the Vulkan SDK or
    `libvulkan-dev`, and put `glslc` (or `glslangValidator`) on PATH.
  - With `--gpu-api cuda`, install the CUDA toolkit instead.
  - Either way, the host needs a working GPU driver.
- **Windows:** install one of these toolchains:
  - Visual Studio Build Tools with the C++ workload;
  - clang + Ninja, with `CMAKE_GENERATOR=Ninja`, `CC=clang` and `CXX=clang++` set.

  For the GPU backend, add the Vulkan SDK, or the CUDA toolkit with `--gpu-api cuda`.

**NVIDIA and AMD hosts.** The addon prefers CUDA when it is available. The benchmark
always pins the addon to the API that llama-server is built with:

- By default that is Vulkan, so both engines run Vulkan.
- To compare on CUDA, pass `--gpu-api cuda` (needs the CUDA toolkit).

### Fixture images

The images are **not in git**. They live in a private bucket, `s3://tether-ai-dev/vlm-benchmark/`.
There are two ways to get them:

- **With AWS access to the bucket:** add `--sync-fixture` to the first run. It runs
  `aws s3 sync` into `benchmarks/vlm-benchmark/fixture/`.
- **Without AWS access:** copy the images once from a teammate or another machine. Put them
  in `benchmarks/vlm-benchmark/fixture/`, or keep them elsewhere and pass
  `--fixture-dir <dir>`.

Only the images for the preset you run need to be present. If any are missing, the runner
lists them before it starts.

The text suite needs no fixture.

### Models

Any GGUF + mmproj pair that llama.cpp supports will work for the vlm suite; any GGUF for
the text suite. Put the files anywhere and pass absolute or relative paths. The files are
used where they are; nothing is copied or downloaded.

## 3 · Running

Run from `packages/llm-llamacpp`. These two forms are equivalent:
```bash
npm run benchmarks:vlm -- --llm <model.gguf> --mmproj <mmproj.gguf> [options]
node benchmarks/vlm-benchmark/run-local.cjs --llm <model.gguf> --mmproj <mmproj.gguf> [options]
```

Typical runs:

```bash
# Wiring check: one image on the GPU (the default preset and backend)
npm run benchmarks:vlm -- --llm ~/models/qwen.gguf --mmproj ~/models/qwen-mmproj.gguf

# The real comparison: the 5 VQA tasks × 5 samples, 3 repeats, CPU and GPU
npm run benchmarks:vlm -- --llm ~/models/qwen.gguf --mmproj ~/models/qwen-mmproj.gguf \
  --preset cognitive --repeats 3 --backend cpu,gpu

# Everything (VQA + OCR), fixed thread count, fixture kept outside the repo
npm run benchmarks:vlm -- --llm ~/models/qwen.gguf --mmproj ~/models/qwen-mmproj.gguf \
  --preset full --threads 8 --fixture-dir ~/vlm-fixture

# NVIDIA host, comparing on CUDA instead of Vulkan
npm run benchmarks:vlm -- --llm … --mmproj … --gpu-api cuda

# First run on a host with AWS access: also fetch the fixture
npm run benchmarks:vlm -- --llm … --mmproj … --sync-fixture

# Text suite only, the standard matrix: p512/p2048 × n128, concurrency 1–16, speculation
npm run benchmarks:vlm -- --llm ~/models/qwen3-8b-q4_k_m.gguf --suite text --text-preset standard

# Speculative decoding on both engines (addon >= 0.63.0; full steps and models: §7):
# an MTP model gets draft-mtp automatically; a DFlash --draft adds draft-dflash
npm run benchmarks:vlm -- --llm ~/models/Qwen3.8-27B-UD-Q4_K_XL.gguf --suite text --text-suites spec \
  --draft ~/models/Qwen3.8-27B-DFlash2-Q8_0.gguf --spec-draft-n-max 7

# Classic draft model (llama-server only; same vocabulary as --llm)
npm run benchmarks:vlm -- --llm ~/models/qwen3-8b-q4_k_m.gguf --suite text --text-suites spec \
  --draft ~/models/qwen3-0.6b-q8_0.gguf

# Concurrency sweep only, higher levels
npm run benchmarks:vlm -- --llm … --suite text --text-suites conc --concurrency 1,4,8,16,32
```

The first GPU run spends a few minutes building llama-server. Later runs reuse that build.

Presets (`config.cjs`) set how many images run:

- `smoke`: 1 image; a wiring check. This is the default.
- `cognitive`: the 5 VQA tasks × 5 samples.
- `ocr1page`: 1 document page (OCR).
- `ocr5pages`: 5 document pages (OCR); heavy.
- `full`: `cognitive`, plus `ocr-small` × 5 and 1 document page.

## 4 · Options

`--help` prints the full list.

- **Model files:** `--llm` (required); `--mmproj` (required for the vlm suite);
  `--text-llm` (a different model for the text suite); `--draft` (draft model for
  speculative decoding: a DFlash draft, or a small same-vocabulary model); `--mtp-head`
  (an external MTP head for `draft-mtp`, §6).
- **Suites:** `--suite all|vlm|text` (default `all` when `--mmproj` is given, else `text`).
- **Text suite** (§6):
  - `--text-preset quick|standard|full` (default `quick` with `--preset smoke`, else
    `standard`)
  - `--text-suites single,conc,spec` (default: all three)
  - `--text-prompts 512,2048`, `--text-gen 128`, `--text-repeats 3`
  - `--concurrency 1,2,4,8,16`
  - `--spec-types ngram-simple,draft-mtp,draft-dflash,…` (default: see §6),
    `--spec-draft-n-max 7`, `--spec-gen 512`, `--spec-concurrency 1,4,8`
- **Backend:**
  - `--backend cpu|gpu|cpu,gpu` (default `gpu`).
  - `--gpu-api metal|vulkan|cuda` (default `metal` on macOS, `vulkan` elsewhere).
- **Run size:**
  - `--preset`, `--samples`, `--repeats`, `--tasks`. Defaults come from the preset;
    `--tasks` is a comma-separated list such as `textvqa,docvqa`.
  - `--timeout-min` (default 240) caps the addon leg's run time.
- **Fixture:** `--fixture-dir <dir>` points at the images; `--sync-fixture` fetches them
  from S3 first.
- **Engine parameters**, applied to both engines (see §5):
  - `--ctx` (default 4096)
  - `--threads`, `--batch`, `--ubatch` (default: the engine default, which is the same for
    both)
  - `--flash-attn` (default `on`)
  - `--cache-type` (default `f16`)
  - `--gpu-layers` (default 99)
  - `--mmproj-cpu`
  - `--image-max-tokens` (default: the addon's cap for the projector)
  - `--fit` (default `off`)
- **Engine source:** `--fabric-ref <tag|sha>` builds llama-server from a different
  qvac-fabric tag or commit. Use it when §11 says so, or to test another engine version.
  Prefer a tag: GitHub serves any commit of the repository's fork network by SHA, so the
  report marks a raw SHA as unverified.
- **Addon prebuild:**
  - `--addon-version <ver|latest>` picks the npm version to fetch for the run when
    `prebuilds/` has none. There is no automatic fallback to another version.
  - `--addon-prebuild <dir>` runs against another addon build, such as a PR's CI prebuild
    artifact (a directory holding `<platform>-<arch>/qvac__llm-llamacpp.bare`). The
    checkout's `prebuilds/` is moved aside for the run and restored when it exits.
- **One leg only:** `--skip-addon`, `--skip-server`.
- **Output and port:**
  - `--out-dir` (where results go)
  - `--host-label` (the host's name in the report)
  - `--port` (llama-server; default 8089, and the run stops if the port is busy)

## 5 · What is held equal between the engines

Both engines use the same model files, the same fixture items and the same scoring. The
following are also held equal:

- **Engine version:** llama-server is built from the qvac-fabric tag the addon links,
  found in `packages/fabric/vcpkg.json`.
- **Prompt shape:** a system message ("You are a helpful assistant."), then one user turn
  holding the image followed by the question. The addon folds its media message into the
  next user message, so llama-server gets the same single turn; `prompt_tokens` should
  match between the engines.
- **Sampling:** greedy, at temperature 0 with seed 42.
- **Output cap:** set per item from the task: 128 tokens for VQA, 96 for `ocr-small`, 768
  for `ocr-page`.
- **Reasoning:** off. The addon gets `reasoning-budget 0`, which also renders the chat
  template with thinking disabled. The server gets `--reasoning off --reasoning-budget 0`,
  because on llama-server the budget alone does not change the template.
- **Image-token cap:** pinned on both engines.
  - Unless you set `--image-max-tokens`, the cap is the one the addon applies for the
    mmproj's projector: 2048 for Qwen-VL, 280 for Gemma 4, and the model's own budget for
    other projectors.
  - llama-server would otherwise use the model's own budget for every projector.
- **Context, threads and batch:**
  - `--ctx` is applied to both engines.
  - `--threads`, `--batch` and `--ubatch` are applied to both when given. Otherwise both
    keep llama.cpp's common default.
- **Flash attention and KV cache:** set explicitly on both (`on`, `f16`). The addon's own
  defaults differ from llama-server's: it turns flash attention on, and on GPU switches
  the KV cache to q8_0.
- **GPU placement:**
  - Both use the same GPU API: the addon's `backend` is pinned to `--gpu-api`.
  - Both put `--gpu-layers` layers on the GPU.
  - Both use a single device: llama-server gets `--split-mode none`, which is the addon's
    default.
  - The vision projector runs on the GPU unless `--mmproj-cpu` is given.
- **CPU backend:** nothing is offloaded on either engine. llama-server also gets
  `--device none`.
- **Memory auto-fit:** off on both, so neither engine quietly shrinks ctx or layers.
- **Thread polling:** pinned to 50 on both (addon `poll`, llama-server `--poll` and
  `--poll-batch`). The defaults differ: the addon turns the CPU threadpool's busy-waiting
  off, llama-server polls at 50. On an Apple M4 the addon decodes at the same speed either
  way, while llama-server with `--poll 0` is about 20% slower on Metal.
- **Prompt cache:** disabled on the server (`cache_prompt: false`, `--cache-ram 0`, one
  slot), so every request prefills in full, as the addon does.
- **Warmup and repeats:** one warmup request per engine, dropped from the stats. Then both
  run the same number of measured repeats.
- **Order:** in the vlm suite the addon leg runs before the llama-server leg on every
  backend. On a laptop that throttles, the second leg runs on a warmer machine; let it
  cool between runs, or compare against a second run with `--skip-addon` /
  `--skip-server`. The text suite alternates which engine goes first across the jobs
  both run (each single-stream prompt length is its own job).

## 6 · Text suite

Three workloads on the same text model, each run on both engines and on every backend:

- **Single stream** (`single`): one request at a time at fixed prompt lengths (default
  512 and 2048 tokens) and a fixed generation length (128), like `llama-bench -p 512,2048
  -n 128`. Reports prefill tok/s, decode tok/s and TTFT from each engine's own counters.
- **Concurrent requests** (`conc`): N requests in flight at once (default 1, 2, 4, 8, 16),
  512-token prompts, 128 generated tokens each. Reports aggregate tok/s (all generated
  tokens ÷ batch wall time), per-request decode tok/s, median TTFT (client-measured, so
  queueing counts) and peak RSS.
- **Speculative decoding** (`spec`): four prompts (code, rewrite, story, explain), up to
  512 generated tokens, stopping at EOS. Both engines run their baseline and every
  `--spec-types` mode they support (below). Reports decode tok/s per prompt, the speedup
  against the same engine without speculation, addon vs llama-server on the same mode,
  and draft acceptance (accepted ÷ drafted tokens). With `--spec-concurrency 1,4,8` it
  also runs speculation under concurrency.

Presets set the run size:

- `quick`: p512 × n64 once, concurrency 1 and 4, two speculative prompts at 256 tokens.
  The default with `--preset smoke`; a wiring check.
- `standard`: p512 and p2048 × n128 × 3 repeats, concurrency 1–16 × 2 rounds, all four
  speculative prompts × 2.
- `full`: p128–p4096, concurrency 1–32 × 3 rounds, speculation also at 4 and 8 concurrent.

**Speculative modes.** `--spec-types` takes llama-server's `--spec-type` values. Which
engine runs which:

- **Both engines:** `draft-mtp` and `draft-dflash`. The addon has speculative decoding
  since `@qvac/llm-llamacpp` 0.63.0
  ([tetherto/qvac#4849](https://github.com/tetherto/qvac/pull/4849): `spec-type`,
  `spec-draft-model`, `spec-draft-n-max` load keys; `draftTokens` / `draftAcceptedTokens`
  stats). The benchmark passes it the same values as llama-server's flags.
  - `draft-mtp` uses the model's own multi-token-prediction layers. Not every GGUF keeps
    them (unsloth's Qwen3.5 quants strip them; ggml-org's keep them).
  - `draft-mtp` with `--mtp-head <gguf>` loads the MTP layers from a separate GGUF instead
    (an *external MTP head*), so a model without its own can still use MTP; for example
    ggml-org's Qwen3.5-0.8B as the head for unsloth's Qwen3.5-0.8B. llama-server gets it
    as `--spec-type draft-mtp -md <head>`, the addon as `spec-draft-model`. On the addon
    this needs [tetherto/qvac#5232](https://github.com/tetherto/qvac/pull/5232), not
    released yet: run it as in §8. `run-local.cjs` refuses a head without MTP layers.
  - `draft-dflash` needs a DFlash block-diffusion draft model, passed with `--draft`.
- **llama-server only:** `ngram-*` (draft from text already in the context; helps most on
  copy-heavy output such as rewrites and code), `draft-simple` (a small `--draft` model
  with the **same vocabulary** as `--llm`, e.g. Qwen3-0.6B for Qwen3-8B) and
  `draft-dspark`.

Without `--spec-types` the run picks: `ngram-simple`; `draft-mtp` when the GGUF has MTP
layers (`<arch>.nextn_predict_layers > 0`) or `--mtp-head` is given; and, with `--draft`,
`draft-dflash` for a DFlash draft (`general.architecture = dflash`) or `draft-simple`
otherwise. A mode that loads a separate model shows its file name next to the mode in the
report.

**Draft length.** `--spec-draft-n-max <n>` is the longest draft per step: how many
tokens the MTP layers, head or draft model may propose before the model verifies them in
one decode. Longer drafts keep more tokens per step when acceptance is high and waste more
work when it is low. The benchmark passes the same value to both engines (addon
`spec-draft-n-max`, llama-server `--spec-draft-n-max`); without it each keeps its default,
3 on both. The addon lowers it at load, with a warning, so the draft fits one `ubatch-size`
and each sequence's share of `batch-size`; a DFlash draft is also capped by its block size
minus one. To find the best length on a host, run the same command with, say, 3, 5 and 7
under different `--host-label`s and merge them (§8, step 4).

**Older addon builds.** An addon older than 0.63.0 has no speculative decoding: its
speculative rows fail with `invalid argument: --spec-type` and are listed under *Failed
configurations*; everything else still runs. To benchmark an addon build that is not
released yet, see §8.

**Held equal**, beyond §5:

- **Prompts:** the same chat messages on both engines (one user turn), rendered by each
  engine's chat template with thinking off. Prompt lengths are calibrated once, on the
  first engine run, by adjusting filler text until the rendered prompt is the target
  token count. Every request gets a unique fixed-width document number, so no prompt
  cache can hit, without changing the token count. The tables show the prompt tokens each
  engine actually processed.
- **Generation length:** EOS is ignored for `single` and `conc` (addon `ignore-eos`,
  server `ignore_eos`), so every request generates exactly the target length.
- **Slots and KV:** the addon gets `parallel = N`; llama-server gets `-np N
  --no-kv-unified`. Both split the context evenly, and each job sizes its context to N ×
  (prompt + generation + headroom).
- **Fresh state:** every configuration is a new model load: a new `bare` process for the
  addon, a new server for llama-server. Peak RSS is therefore per configuration.
- **Warmup:** the first request (or first round of N) in every job is dropped.

**Outputs:** `text-report.md`, `text-report.html` (charts plus tables, self-contained),
`text-<host>-<backend>.log` (raw `[TEXTROW]` / `[TEXTBATCH]` markers),
`text-calibration.json`, `text-meta.json` (the run's host, model, shape and builds,
which `text-report.cjs` reads per directory, so keep it when copying results), `plans/`
(the exact job each engine ran) and `llama-server-text-<backend>.log`. Re-render or merge
hosts with
`node benchmarks/vlm-benchmark/text-report.cjs --dir <dir>[,<dir>…] --out <dir>`.

## 7 · Speculative decoding on another host (Qwen3.8-27B, MTP and DFlash)

This reproduces the speed setup of [#4849](https://github.com/tetherto/qvac/pull/4849),
which added speculative decoding to the addon (released in 0.63.0): MTP and DFlash on
Qwen3.8-27B, on both engines. One checkout of `main` is enough; its addon already has
speculative decoding.

**Host:** ≥ 32 GB of GPU or unified memory (the 27B model is 17.6 GB, the draft 2.1 GB,
plus KV cache), ~25 GB of free disk for the models, and everything in §2.

**1. Check out `main`.**

```bash
git clone git@github.com:tetherto/qvac.git ~/qvac
cd ~/qvac/packages/llm-llamacpp
npm install
```

In an existing clone, `git checkout main && git pull` first. After every `git pull`, run
`npm install` again, so the installed `@qvac/fabric` matches
`packages/fabric`; `run-local.cjs` warns when they differ.

**2. Download the models.** #4849 names its speed-test files as "Qwen3.8-27B UD-Q4_K_XL"
and "`incoai/Qwen3.8-27B-DFlash2` Q8_0". Pinned to the repository revisions below:

| File | Source (revision) | Size | sha256 |
|---|---|---|---|
| `Qwen3.8-27B-UD-Q4_K_XL.gguf` (target, keeps its MTP layers) | [unsloth/Qwen3.8-27B-GGUF](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) (`4ca72078`) | 17,559,178,144 B | `3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e` |
| `Qwen3.8-27B-DFlash2-Q8_0.gguf` (DFlash draft, `general.architecture = dflash`) | [incoai/Qwen3.8-27B-DFlash2-GGUF](https://huggingface.co/incoai/Qwen3.8-27B-DFlash2-GGUF) (`51962825`) | 2,056,414,816 B | `c18e800daedc59ca68fd13b6a856d795746af6d399a9279ac6a277d1d422f87e` |
| `Qwen3.5-0.8B-MTP-Q8_0.gguf` (optional small check; #4849's integration-test model) | [ggml-org/Qwen3.5-0.8B-GGUF](https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF) (`8fea6208`) | 833,592,096 B | `37ae482d336108d23516fa35e8e0c4126688d81018b87178a18d752a1357814f` |

```bash
mkdir -p ~/models && cd ~/models
curl -L --fail -o Qwen3.8-27B-UD-Q4_K_XL.gguf \
  https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q4_K_XL.gguf
curl -L --fail -o Qwen3.8-27B-DFlash2-Q8_0.gguf \
  https://huggingface.co/incoai/Qwen3.8-27B-DFlash2-GGUF/resolve/51962825493a48b846b40126d35c799ac4093ad0/Qwen3.8-27B-DFlash2-Q8_0.gguf
curl -L --fail -o Qwen3.5-0.8B-MTP-Q8_0.gguf \
  https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/8fea620810c4afa23dd6443f999a48574c1611a3/Qwen3.5-0.8B-Q8_0.gguf
shasum -a 256 -c - <<'EOF'          # Linux: sha256sum -c -; Windows: certutil -hashfile <file> SHA256
3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e  Qwen3.8-27B-UD-Q4_K_XL.gguf
c18e800daedc59ca68fd13b6a856d795746af6d399a9279ac6a277d1d422f87e  Qwen3.8-27B-DFlash2-Q8_0.gguf
37ae482d336108d23516fa35e8e0c4126688d81018b87178a18d752a1357814f  Qwen3.5-0.8B-MTP-Q8_0.gguf
EOF
```

Every line must print `OK`; drop a line for a file you skipped.

Use the 27B files only from these repositories: unsloth's other Qwen GGUFs (the Qwen3.5
quants, for example) strip the MTP layers, and `incoai/Qwen3.8-27B-DFlash2` itself holds
only safetensors.

**3. Run the benchmark.**

```bash
cd ~/qvac/packages/llm-llamacpp
# optional wiring check on the small model (draft-mtp on both engines, a few minutes)
npm run benchmarks:vlm -- --llm ~/models/Qwen3.5-0.8B-MTP-Q8_0.gguf --suite text \
  --text-suites spec --spec-gen 512
# #4849's setup: draft-mtp and draft-dflash on both engines, draft length 7
npm run benchmarks:vlm -- --llm ~/models/Qwen3.8-27B-UD-Q4_K_XL.gguf \
  --draft ~/models/Qwen3.8-27B-DFlash2-Q8_0.gguf --spec-draft-n-max 7 \
  --suite text --text-suites spec --text-preset standard --host-label <name>
```

- The run picks the modes from the files: `ngram-simple`, `draft-mtp` (the target has MTP
  layers) and `draft-dflash` (the draft is a DFlash model), plus each engine's baseline.
  Check the `text:` line it prints at the start.
- The addon is the checkout's own build in `prebuilds/`, or, when there is none, the npm
  prebuild of the checkout's version, fetched for the run (§1). Either way it must be
  0.63.0 or later; the report's addon line shows which build ran.
- llama-server is built from the qvac-fabric tag in `packages/fabric/vcpkg.json`, the
  engine the addon runs on. #4849's own numbers were taken on fabric 11018.2.0, so absolute
  speeds on a newer tag can differ.
- To benchmark an unreleased addon build instead, add `--addon-prebuild <dir>` (a PR's
  `prebuild-llm-llamacpp-<platform>-<arch>` CI artifact, or `prebuilds/` of another
  worktree after `npm run build`; see `packages/llm-llamacpp/build.md`).
- The GPU API defaults to Metal on macOS and Vulkan elsewhere; add `--gpu-api cuda` on
  NVIDIA. Drop `--text-suites spec` to add single-stream and concurrency results for the
  27B model; add `--spec-concurrency 1,4` for speculation under concurrency.
- Results land in `benchmarks/vlm-benchmark/results/<timestamp>-<name>/` (§9).

## 8 · Benchmarking an unreleased addon change (separate worktrees)

To benchmark an addon change that is not released yet (an open PR, or a local branch),
keep two git worktrees of one clone:

- the **clone itself** (`~/qvac`) on the branch under test, where the addon is built from
  source;
- a **benchmark worktree** (`~/qvac-bench`) on `main`, which runs `run-local.cjs`
  against that build with `--addon-prebuild`.

Each worktree keeps its own `node_modules/` and `prebuilds/`, so the benchmark checkout
stays on its own addon and nothing has to be copied by hand. The example below uses
[tetherto/qvac#5232](https://github.com/tetherto/qvac/pull/5232) (external MTP heads, branch
`fix/assessfit-speculative`); for another change, substitute its branch and models.

**Host:** everything in §2, plus what building the addon needs
(`packages/llm-llamacpp/build.md`):

- `bare-make`: `npm install -g bare-make`
- vcpkg at tag `2025.12.12`, with `VCPKG_ROOT` set:
  ```bash
  git clone --branch 2025.12.12 --single-branch https://github.com/microsoft/vcpkg.git ~/vcpkg
  ~/vcpkg/bootstrap-vcpkg.sh          # Windows: ~\vcpkg\bootstrap-vcpkg.bat
  export VCPKG_ROOT=~/vcpkg           # Windows: $env:VCPKG_ROOT = "$HOME\vcpkg"
  ```
- macOS: Apple clang ≥ 15 (not Homebrew LLVM). Linux: clang with libc++, CMake.
  Windows: Visual Studio 2022 with C++, Clang and LLVM tools, and the Vulkan SDK.

The vcpkg registry (`tetherto/qvac-registry-vcpkg`) is public; no token is needed.

**1. The clone on the branch under test, plus a benchmark worktree.**

```bash
git clone git@github.com:tetherto/qvac.git ~/qvac      # or use an existing clone
cd ~/qvac
ADDON_BRANCH=fix/assessfit-speculative                 # the change under test
git fetch origin "$ADDON_BRANCH" main
git checkout --detach "origin/$ADDON_BRANCH"           # needs a clean working tree
git worktree add --detach ~/qvac-bench origin/main
```

`--detach` avoids creating local branches; to follow a branch later, `git -C <checkout>
fetch origin` and `git -C <checkout> checkout --detach origin/<branch>`.

**2. Build the addon in the clone.**

```bash
cd ~/qvac/packages/llm-llamacpp
npm install
npm run build
ls prebuilds/                       # e.g. darwin-arm64/qvac__llm-llamacpp.bare
```

`npm run build` compiles the TypeScript wrapper and the native addon (`bare-make generate`,
`build`, `install`) into `prebuilds/<platform>-<arch>/`. The first build fetches the vcpkg
dependencies and takes a while; later builds reuse them.

*Without a build toolchain:* download the branch's CI prebuild instead. A PR's checks
upload `prebuild-llm-llamacpp-<platform>-<arch>` artifacts (the *On PR Trigger* run in the
PR's *Checks* tab):

```bash
gh run download <run-id> --repo tetherto/qvac --name prebuild-llm-llamacpp-darwin-arm64 \
  --dir ~/qvac-addon-prebuild
```

and use that directory in step 3. The artifact is native code that runs with your
privileges, so first check that the run built the PR's current head in `tetherto/qvac`
(not a fork you have not reviewed):

```bash
gh run view <run-id> --repo tetherto/qvac --json headSha,headRepository
gh pr view <pr> --repo tetherto/qvac --json headRefOid
```

`headSha` must equal `headRefOid`.

**3. Run the benchmark worktree against that build.**

```bash
cd ~/qvac-bench/packages/llm-llamacpp
npm install
# #5232: unsloth's Qwen3.5-0.8B (no MTP layers) with ggml-org's Qwen3.5-0.8B as the MTP head
npm run benchmarks:vlm -- --llm ~/models/Qwen3.5-0.8B-Q8_0.gguf \
  --mtp-head ~/models/Qwen3.5-0.8B-MTP-Q8_0.gguf --suite text --text-suites spec --spec-gen 512 \
  --addon-prebuild ~/qvac/packages/llm-llamacpp/prebuilds --host-label <name>
```

The two models, pinned:

- `Qwen3.5-0.8B-Q8_0.gguf` (no MTP layers): [unsloth/Qwen3.5-0.8B-GGUF](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF)
  at `6ab461498e2023f6e3c1baea90a8f0fe38ab64d0`.
- `Qwen3.5-0.8B-MTP-Q8_0.gguf` (the head): ggml-org's file, the same as in §7. Its
  upstream name is also `Qwen3.5-0.8B-Q8_0.gguf`, so keep the `-MTP-` name it is saved
  under.

```bash
mkdir -p ~/models && cd ~/models
curl -L --fail -o Qwen3.5-0.8B-Q8_0.gguf \
  https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q8_0.gguf
curl -L --fail -o Qwen3.5-0.8B-MTP-Q8_0.gguf \
  https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/8fea620810c4afa23dd6443f999a48574c1611a3/Qwen3.5-0.8B-Q8_0.gguf
shasum -a 256 -c - <<'EOF'          # Linux: sha256sum -c -
0ad885ffd4bb022fc4f0d33a3308fa108ef8613159d3b3a67e23abca056b7a6c  Qwen3.5-0.8B-Q8_0.gguf
37ae482d336108d23516fa35e8e0c4126688d81018b87178a18d752a1357814f  Qwen3.5-0.8B-MTP-Q8_0.gguf
EOF
```

**Larger examples.** #5232's opt-in tests use the models below
(`QVAC_RUN_SPECULATIVE_27B=1`, `QVAC_RUN_SPECULATIVE_MTP_HEADS=1`). Each run gets its own
`--host-label` so step 4 can merge them; labels keep `[a-z0-9]` only. The 27B runs need
≥ 32 GB of GPU or unified memory.

| File | Source (revision) | Role | sha256 |
|---|---|---|---|
| `Qwen3.8-27B-UD-Q4_K_XL.gguf` | [unsloth/Qwen3.8-27B-GGUF](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) (`4ca72078`) | 27B target; keeps its MTP layers (every unsloth 27B quant does) | `3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e` |
| `mtp-Qwen3.8-27B-Q4_0.gguf` | same, `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` | standalone MTP head for the 27B | `50d9ce5a6da381bbcfb31061cf73df94a90e6faf8efeddee379a9cb8f1501c6e` |
| `Qwen3.5-2B-Q4_0.gguf` | [unsloth/Qwen3.5-2B-GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF) (`f6d5376b`) | target without MTP layers (24 blocks, no `nextn` tensors) | `cd70221bebaee0503e0f6717e174250cd7825aa88438b3aabec9ad55731d9bb1` |
| `Qwen3.5-2B-MTP-Q4_0.gguf` | [unsloth/Qwen3.5-2B-MTP-GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-MTP-GGUF) (`e05864f8`), file `Qwen3.5-2B-Q4_0.gguf` | head: the same model with its MTP layer (block 24) | `5865aef7b9983e463901ad0683c7f11cde89c86420d239c7fb5f051ded7b070e` |
| `google_gemma-4-E2B-it-Q4_K_M.gguf` | [bartowski/google_gemma-4-E2B-it-GGUF](https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF) (`b5e99bd9`) | Gemma 4 E2B target (no MTP layers) | `b5310340b3a23d31655d7119d100d5df1b2d8ee17b3ca8b0a23ad7e9eb5fa705` |
| `gemma-4-E2B-it-assistant-Q8_0.gguf` | [AtomicChat/gemma-4-E2B-it-assistant-GGUF](https://huggingface.co/AtomicChat/gemma-4-E2B-it-assistant-GGUF) (`5ba02977`), file `gemma-4-E2B-it-assistant.Q8_0.gguf` | Gemma 4 assistant (`gemma4-assistant`, 4 MTP layers) | `bbb29c822cad3df242fd0f75fc0928a29e90bdd52aa1625b2d6bff476b739095` |

```bash
cd ~/models
HF=https://huggingface.co
curl -L --fail -o Qwen3.8-27B-UD-Q4_K_XL.gguf \
  $HF/unsloth/Qwen3.8-27B-GGUF/resolve/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q4_K_XL.gguf
curl -L --fail -o mtp-Qwen3.8-27B-Q4_0.gguf \
  $HF/unsloth/Qwen3.8-27B-GGUF/resolve/4ca720788d1e01f1bff70c033e0d0028fd02e502/MTP/mtp-Qwen3.8-27B-Q4_0.gguf
curl -L --fail -o Qwen3.5-2B-Q4_0.gguf \
  $HF/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_0.gguf
curl -L --fail -o Qwen3.5-2B-MTP-Q4_0.gguf \
  $HF/unsloth/Qwen3.5-2B-MTP-GGUF/resolve/e05864f8066d874d5f85aaff007ae57a2a7d1efe/Qwen3.5-2B-Q4_0.gguf
curl -L --fail -o google_gemma-4-E2B-it-Q4_K_M.gguf \
  $HF/bartowski/google_gemma-4-E2B-it-GGUF/resolve/b5e99bd964eaacc27ba484bb2eb3e9f6160b9143/google_gemma-4-E2B-it-Q4_K_M.gguf
curl -L --fail -o gemma-4-E2B-it-assistant-Q8_0.gguf \
  $HF/AtomicChat/gemma-4-E2B-it-assistant-GGUF/resolve/5ba029771ba4efc3488835c4a137b30bd1f80b03/gemma-4-E2B-it-assistant.Q8_0.gguf
shasum -a 256 -c - <<'EOF'          # Linux: sha256sum -c -
3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e  Qwen3.8-27B-UD-Q4_K_XL.gguf
50d9ce5a6da381bbcfb31061cf73df94a90e6faf8efeddee379a9cb8f1501c6e  mtp-Qwen3.8-27B-Q4_0.gguf
cd70221bebaee0503e0f6717e174250cd7825aa88438b3aabec9ad55731d9bb1  Qwen3.5-2B-Q4_0.gguf
5865aef7b9983e463901ad0683c7f11cde89c86420d239c7fb5f051ded7b070e  Qwen3.5-2B-MTP-Q4_0.gguf
b5310340b3a23d31655d7119d100d5df1b2d8ee17b3ca8b0a23ad7e9eb5fa705  google_gemma-4-E2B-it-Q4_K_M.gguf
bbb29c822cad3df242fd0f75fc0928a29e90bdd52aa1625b2d6bff476b739095  gemma-4-E2B-it-assistant-Q8_0.gguf
EOF
```

```bash
cd ~/qvac-bench/packages/llm-llamacpp
PREBUILD=~/qvac/packages/llm-llamacpp/prebuilds

# a) 27B on its own MTP layers. Released since 0.63.0; --addon-prebuild keeps the build
#    the same as in b), so a) vs b) differs only in where the draft comes from.
npm run benchmarks:vlm -- --llm ~/models/Qwen3.8-27B-UD-Q4_K_XL.gguf \
  --spec-types draft-mtp --spec-draft-n-max 3 \
  --suite text --text-suites spec --text-preset standard \
  --addon-prebuild $PREBUILD --host-label m4own

# b) the same 27B, drafting from unsloth's external MTP head instead of its own layers
npm run benchmarks:vlm -- --llm ~/models/Qwen3.8-27B-UD-Q4_K_XL.gguf \
  --mtp-head ~/models/mtp-Qwen3.8-27B-Q4_0.gguf --spec-types draft-mtp --spec-draft-n-max 3 \
  --suite text --text-suites spec --text-preset standard \
  --addon-prebuild $PREBUILD --host-label m4head

# c) a target without MTP layers, with a head carrying them (what external heads are for)
npm run benchmarks:vlm -- --llm ~/models/Qwen3.5-2B-Q4_0.gguf \
  --mtp-head ~/models/Qwen3.5-2B-MTP-Q4_0.gguf --spec-types draft-mtp \
  --suite text --text-suites spec --text-preset standard \
  --addon-prebuild $PREBUILD --host-label m4qwen2b

# d) Gemma 4 E2B with its Gemma 4 assistant as the MTP head
npm run benchmarks:vlm -- --llm ~/models/google_gemma-4-E2B-it-Q4_K_M.gguf \
  --mtp-head ~/models/gemma-4-E2B-it-assistant-Q8_0.gguf --spec-types draft-mtp \
  --suite text --text-suites spec --text-preset standard \
  --addon-prebuild $PREBUILD --host-label m4gemma
```

- Check the `text:` line each run prints first: it lists `draft-mtp` and, for b)–d), the
  head file.
- a) alone needs no #5232 build; drop `--addon-prebuild` to measure the released addon.
- `--spec-draft-n-max 3` is both engines' default, pinned; see §6 *Draft length*.
- All four use `--text-preset standard` (4 prompts × 2 runs at up to 512 tokens), so the
  merged report compares like with like; its header lists each label's shape.
- A Gemma 4 assistant's memory is not in the addon's fit (fabric cannot measure it yet),
  so leave room for it. Use assistant GGUFs whose `general.architecture` is
  `gemma4-assistant`, the name fabric loads; some uploads use `gemma4_mtp` instead.

Things to keep consistent between the two worktrees:

- **Which addon ran:** `--addon-prebuild` swaps the build into the benchmark worktree's
  `prebuilds/` for the run and restores it on exit. The addon rows' `source_ref` names the
  prebuild directory and the version from that checkout's `package.json` ("version
  unknown" for a CI artifact), so the report records which build ran. A build left
  behind by a run that could not clean up (killed, crashed) is marked, and the next run
  removes it and restores the original.
- **Same engine version:** the addon build links the `@qvac/fabric` of the clone
  (`~/qvac`), and at run time loads the one in the benchmark worktree's `node_modules/`.
  Keep both on the same `@qvac/fabric` version (`npm ls @qvac/fabric` in each); if the
  branch under test moves fabric, merge or rebase it so both match, and build llama-server
  from the same tag (`--fabric-ref`, §4).
- **Same JavaScript:** the benchmark worktree's `index.js` loads the other build's native
  addon. That is fine when the change is native only, as #5232 is (its `src/index.ts`
  changes are doc comments). If the change also edits `index.js`, check out the branch
  under test in the benchmark worktree too (check it out there instead of `main`).
- **Comparison:** run the same command without `--addon-prebuild` for the released addon.
  For #5232 that gives the "before" picture: the addon's `draft-mtp` row fails with
  "spec-draft-model requires spec-type draft-dflash" and a hint to this section, while
  llama-server's runs.

**4. Merge the runs into one report.** Pass the results directories, comma-separated:

```bash
cd ~/qvac-bench/packages/llm-llamacpp
R=benchmarks/vlm-benchmark/results
ls $R                               # <timestamp>-m4own, <timestamp>-m4head, …
node benchmarks/vlm-benchmark/text-report.cjs \
  --dir $R/<ts>-m4own,$R/<ts>-m4head,$R/<ts>-m4qwen2b,$R/<ts>-m4gemma \
  --out ~/bench-combined --title "Speculative decoding: own MTP layers vs external heads"
open ~/bench-combined/text-report.html     # Linux: xdg-open
```

Rows are grouped by `--host-label`, so each run gets its own card with its own baseline,
speedup, addon-vs-server ratio and acceptance, and the header names each label's model,
addon build and llama-server. Runs that share a label are pooled into the same medians,
which is why every run above has its own. `text-report.html` is self-contained.

**5. Clean up** when done:

```bash
git -C ~/qvac worktree remove ~/qvac-bench
git -C ~/qvac checkout main                 # back from the branch under test
```

## 9 · Output

Each run writes to `benchmarks/vlm-benchmark/results/<timestamp>-<host>/`, which git
ignores:

- `report.md`: the consolidated report, with one column per engine (`addon`,
  `llama-server`). It covers:
  - quality, overall and per task
  - speed
  - peak RSS
  - OCR CER/WER/BLEU
  - resolved versions
- `results.json`: for each engine and backend:
  - run and error counts
  - `ttft_ms`, `prefill_tps`, `decode_tps`, `wall_ms`, `vision_enc_ms`, `peak_rss_mb`
  - `quality_pct`, `quality_by_task_pct` and `ocr`

  It also records the host info, the parameters, the addon version and the fabric ref.
  The `text` block holds the text-suite summary (`single`, `conc`, `spec` arrays).
- `text-report.md` / `text-report.html` and the other text-suite files: see §6.
- `vlm-matrix-<host>-<backend>.log`: the raw markers for both legs. `combine.cjs` can
  render them again later.
- `llama-server-<backend>.log`: the server's own log.
- `prov-<host>-<backend>.md`: the host and software provenance shown in the report.

These files contain the hostname, absolute model paths and hardware details. Check them
before you share a report outside the team.

How each metric is measured:

- **TTFT, prefill tok/s and decode tok/s** come from each engine's own counters, and
  prefill includes the image.
  - The addon reports `TTFT`, `ppTPS` and `TPS`.
  - llama-server reports `timings.prompt_ms`, `prompt_per_second` and
    `predicted_per_second`.
  - The server's client-side first-token time is kept per row as `client_ttft_ms`.
- **Wall time** (`ms`) is the full request: in-process for the addon, and over HTTP for
  llama-server. It is useful for context, not as an engine comparison.
- **mmproj encode:**
  - for the addon, `visionEncodeMs`
  - for llama-server, the time from the `encoding mtmd batch` log line to the first
    `decoding image batch` line, read from the log timestamps (the server runs at
    `--verbosity 4 --log-timestamps`). Both cover the encoder pass only.
- **Peak RSS** is the whole-process high-water mark.
  - For the addon, this is the `bare` process, so it includes the Bare runtime (tens of MB).
  - For llama-server, it is the kernel high-water mark on Linux (`VmHWM`) and
    `PeakWorkingSet64` on Windows.
  - macOS has no per-process peak, so the server's RSS is read after each request (not
    polled during it, which would add load to the server leg only). It plateaus once the
    model and buffers are loaded, but a short-lived peak inside a request is not seen.

## 10 · Comparing machines

1. Run the same command on each machine, with a different `--host-label` on each.
2. Copy every machine's `vlm-matrix-<host>-<backend>.log` and `prov-*.md` files into one
   directory.
3. Render one combined report:

```bash
node benchmarks/vlm-benchmark/combine.cjs --dir <that-dir> --out <that-dir>/report.md \
  --mode several-sources --engine "addon vs llama-server" --preset <preset>
```

Each machine gets its own row, with an `addon` column and a `llama-server` column.

For the text suite, point `text-report.cjs` at each machine's results directory; each host
gets its own tables, charts and provenance (addon build, llama-server ref, parameters):

```bash
node benchmarks/vlm-benchmark/text-report.cjs --dir <host-a-dir>,<host-b-dir> --out <out-dir>
```

The same works for several runs on one machine (different models, heads or draft
lengths), as long as each run has its own `--host-label` (§8, step 4).

`results.json` files can be merged by any script; each one carries its own host block.

For results you can compare across machines:

- Keep the preset, `--repeats`, the parameters and the model files identical.
- Keep the checkout identical on every machine, so they use the same addon version and
  fabric tag. Both appear in the report's *Sources* table.
- On laptops, plug in power and close heavy apps.

## 11 · Troubleshooting

- **`fixture images missing`:** copy the images into `fixture/`, or pass `--fixture-dir`.
  See §2.
- **`installed @qvac/fabric is X but packages/fabric is Y`:** the addon's shared runtime
  came from npm at a different version than this checkout's `packages/fabric`. The
  default llama-server tag may then not match the addon's engine. Either:
  - pass `--fabric-ref v<qvac-fabric version of X>`, taken from that release's
    `packages/fabric/vcpkg.json`; or
  - update the checkout so the versions match.
- **`npm pack @qvac/llm-llamacpp@<ver> failed`:** this checkout's version is not on npm.
  - Build the addon locally with `npm run build` (see `packages/llm-llamacpp/build.md`), or
  - pick a published version with `--addon-version`.
- **`addon prebuild is X but the checkout's JS is Y`:** the prebuild came from a different
  version than the checkout's JS. Build locally for an exact match.
- **The llama-server build fails with `--backend gpu`:** the GPU SDK is missing. Check with
  `glslc --version` for Vulkan, or `nvcc --version` for CUDA.
- **The model fails to load or runs out of memory:** lower `--ctx` or `--gpu-layers`, or
  pass `--fit on`. With `--fit on`, each engine may choose a different placement, so check
  the logs.
- **`port … is already in use`:** pass `--port <free port>`.
- **A leg had errors:** the *Test Results* section of `report.md` counts the failures, and
  each failing row in the `.log` carries its error.
- **`llama-server exited … before becoming healthy` in a text job:** the lines after it are
  the server's own errors. The usual causes are a `--spec-types` mode the model cannot
  use (`draft-mtp` on a model without MTP layers, `draft-simple` with a draft of another
  vocabulary) or a context too large for memory at a high `--concurrency`.
- **`spec-draft-model requires spec-type "draft-dflash"` from the addon:** the run passed
  `--mtp-head`, and the addon build predates external MTP heads (tetherto/qvac#5232).
  Run it against a build with #5232 (§8), or drop `--mtp-head`.
- **`invalid argument: --spec-type` from the addon:** the addon build is older than 0.63.0
  and has no speculative decoding. Update the checkout (and `npm install`), remove a stale
  `prebuilds/` build, or point `--addon-prebuild` at a newer build.
- **`prompt calibration failed`:** the model could not be loaded for the calibration pass;
  the error above it says why. The rest of the text suite is skipped on that backend.
- **A speculative row shows no acceptance:** the mode drafted nothing. `ngram-*` modes only
  draft once the output repeats text already in the context; short generations may never
  get there. Raise `--spec-gen`.

## 12 · Limitations

- **Desktop only.** Phones run the addon through the CI workflow (`README.md` §1); there is
  no llama-server on phones.
- **CPU builds differ slightly.** llama-server is compiled for the host CPU
  (`GGML_NATIVE=ON`), while the addon's fabric runtime picks the best prebuilt CPU variant
  when it loads. Both should use the same instruction set, but BLAS and OpenMP settings may
  differ between the two builds.
- **Multi-GPU hosts.** Both engines use a single GPU, but they may not choose the same one.
  To make them use the same GPU, expose only that one before running, with
  `GGML_VK_VISIBLE_DEVICES=<n>` (Vulkan) or `CUDA_VISIBLE_DEVICES=<n>` (CUDA). Both legs
  inherit the variable.
- **The quality fixture is required for the vlm suite.** Speed-only runs on arbitrary
  images are not supported.
- **Only the parameters in §5 and §6 are shared.** Engine flags that `run-local.cjs` does
  not expose (tensor split and so on) stay at each engine's default.
- **The addon's speculative decoding covers `draft-mtp` and `draft-dflash`** (0.63.0 and
  later; `draft-mtp` with an external head needs tetherto/qvac#5232). The other modes
  compare llama-server's speculation against both engines' baselines.
- **Prompt rendering.** The addon accepts chat messages only, so the text suite measures
  chat-templated prompts on both engines rather than raw token sequences.
- **Text quality is not scored.** The text suite measures speed and memory; greedy outputs
  may diverge between engines after some tokens.
