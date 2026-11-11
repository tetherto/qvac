# VLM Benchmark

> **One frozen image fixture → one consolidated quality + speed report**, produced
> *identically* on every platform and backend so the numbers are directly comparable.
> It can compare **models**, **addon builds** (your branch vs published), or **engines**
> (addon vs native llama.cpp CLIs), across **desktop** (Linux / macOS / Windows) and
> **mobile** (Android / iOS via AWS Device Farm). Flexible first, sensible defaults:
> out of the box it compares Qwen3.5‑0.8B with its vision projector at **F16 vs Q8**.

Everything ships from this one directory
(`packages/llm-llamacpp/benchmarks/vlm-benchmark/`). The **same harness runs on every
target**; a host-side script collects the per-leg logs and renders one Markdown report
(workflow step summary + PR comment + artifact).

---

## 1 · Quick start — the `gh workflow` command

The benchmark runs through the **Benchmarks** workflow (`.github/workflows/benchmarks.yml`) with
`suite=vlm` in its `args`. Each desktop leg is one of llm's `benchmark` configurations, picked with
`configs`: `linux-x64` (Linux CPU), `linux-x64-gpu` (Linux GPU), and `darwin-arm64` and `win32-x64`,
which run CPU then GPU. The mobile leg is `run_mobile` on one `platform` and its `devices`. Every
other choice is an `args` word; **omit any to use its `config.cjs` default**:

```bash
gh workflow run benchmarks.yml --ref <branch> \
  -f packages=llm-llamacpp \
  -f configs=linux-x64,linux-x64-gpu \
  -f args="suite=vlm mode=two-models preset=full models=qwen3.5-f16,qwen3.5-q8 sources=addon samples=5 mobile_timeout_min=60" \
  -f run_mobile=true -f platform=Android -f devices="Samsung Galaxy S26 Ultra"
```

`args` words: `mode` (two-models | several-sources), `preset` (smoke | cognitive | ocr1page |
ocr5pages | full), `models` (catalog names | `[label=]<llm-url>|<mmproj-url>[@ctx=N]` | `json:[…]`),
`sources` (addon | addon@candidate | addon@baseline | fabric[@ref] | upstream[@ref]; addon@candidate
is this run's build of `--ref`), `samples`, `baseline_npm`, `mobile_timeout_min`, and `vlm_devices`
(the mobile backends, cpu,gpu).

**Smallest valid run** (everything from `config.cjs` defaults):
```bash
gh workflow run benchmarks.yml --ref <branch> -f packages=llm-llamacpp -f configs=linux-x64 -f args=suite=vlm
```

**Preview a several-sources version resolution without running** (no CI):
```bash
node packages/llm-llamacpp/benchmarks/vlm-benchmark/resolve-versions.cjs "addon,fabric,upstream"
```

---

## 2 · Feature reference

Legend: **✅** supported · **❌** not available · **⚠️** supported with a caveat. "Arg"
shows the dispatch flag; most also have a `config.cjs` field and/or a `QVAC_VLM_*` env
(for local runs) — see column 5 and §3.

### 2.1 Modes & sources (what is compared)

| Feature | Desktop | Mobile | Argument / values | Notes & restrictions |
|---|---|---|---|---|
| **two-models** | ✅ | ✅ | `mode=two-models` | `MODEL_1` vs `MODEL_2` (config). Can be two variants of one model (default: same LLM, mmproj F16 vs Q8) or two different models. |
| **several-sources — build** | ✅ | ✅ | `mode=several-sources sources=addon@candidate,addon@baseline` | Candidate vs published, **same model**. Mobile runs each build as its own Device-Farm session. ⚠️ the candidate mobile leg can be flaky (see §6). |
| **several-sources — engine** | ✅ | ❌ | `… sources=addon,fabric,upstream` | addon vs native llama.cpp CLIs. **Desktop only** — CLIs are native binaries; mobile runs an addon app. |
| `addon` source | ✅ | ✅ | `sources=addon` | The published npm prebuild. |
| `addon@candidate` | ✅ | ✅ | `…@candidate` + `--ref <branch\|tag\|sha>` | Built from `ref` (triggers `prebuild-candidate`). Desktop swaps the prebuild; mobile bundles it. |
| `addon@baseline` | ✅ | ✅ | `…@baseline` | **Latest published npm release, auto-detected** at run time. Pin a specific version with `baseline_npm=<ver>`; `config.defaultBaseline.npm` is only an offline fallback. |
| `fabric` / `upstream` CLI | ✅ | ❌ | `fabric[@ref]`, `upstream[@ref]` | Native `llama-mtmd-cli`, built per-OS. `ref` = release **tag**, **branch**, or **full 40-char commit SHA**. |
| **Auto version parity** | ✅ | n/a | bare `fabric`/`upstream` (no `@ref`) | Auto-picks the **most recent llama.cpp build all requested sources support** (addon's `qvac-fabric` vcpkg pin is the ceiling) and pins everything to it → apples-to-apples by default. |
| **Manual version** | ✅ | n/a | any explicit `@ref` | Refs used as given (builds may differ). Report's **Engine versions** table labels it *set manually* (no warning). |

### 2.2 Presets (how much is run)

| Feature | Desktop | Mobile | Argument | Notes & restrictions |
|---|---|---|---|---|
| `smoke` | ✅ | ✅ | `preset=smoke` | 1 task × 1 sample — wiring check. |
| `cognitive` | ✅ | ✅ | `…=cognitive` | 5 VQA tasks (textvqa/vizwiz/gqa/docvqa/ai2d) × 5. |
| `ocr1page` | ✅ | ✅ | `…=ocr1page` | 1 light `ocr-page` doc — quick OCR; fits the mobile session. |
| `ocr5pages` | ✅ | ⚠️ | `…=ocr5pages` | All 5 high-MP OCR docs — desktop-oriented; heavy on mobile (raise `mobile_timeout_min`). |
| `full` (default) | ✅ | ⚠️ | `…=full` | cognitive + `ocr-small` ×5 + 1 `ocr-page`. Heavy on mobile. |

> The CLI engine legs now honor the preset (same tasks/ids as the addon) — `cognitive`
> runs the 5 VQA on every engine, `ocr1page`/`ocr5pages` run only the OCR docs.

### 2.3 Platforms × backends

| Feature | Desktop | Mobile | Argument | Notes & restrictions |
|---|---|---|---|---|
| Linux CPU | ✅ | — | `-f configs=linux-x64` | |
| Linux GPU | ✅ | — | `-f configs=linux-x64-gpu` | GPU = Vulkan. |
| macOS | ✅ | — | `darwin-arm64` | Apple-silicon GPU runner; runs CPU, then GPU (Metal). |
| Windows | ✅ | — | `win32-x64` | Runs CPU, then GPU (Vulkan). CLI builds use pre-installed clang + Ninja (no Visual Studio on the runner). |
| Android | — | ✅ | `-f run_mobile=true -f platform=Android -f devices="Samsung Galaxy S26 Ultra"` | One Device Farm session per device name, matched exactly. `vlm_devices=cpu,gpu` (default) runs both backends in that session; `cpu` or `gpu` runs one. |
| iOS | — | ✅ | `-f platform=iOS -f devices="Apple iPhone 17 Pro"` | Same rules. |

### 2.4 Models & knobs

| Feature | Desktop | Mobile | Argument / env | Notes & restrictions |
|---|---|---|---|---|
| Catalog model | ✅ | ✅ | `models=qwen3.5-f16,qwen3.5-q8,gemma4-q4` | Direct HF URLs (registry entries' canonical sources). |
| Ad-hoc URL model | ✅ | ✅ | `models=[label=]<llm-url>\|<mmproj-url>[@ctx=N]` | Any model from two https GGUF URLs; no code change. |
| `json:[…]` model spec | ✅ | ❌ | `models=json:[…]` | For registry/exotic sources — **desktop only** (P2P registry client not on mobile). |
| samples / task | ✅ | ✅ | `samples=N` · `QVAC_VLM_SAMPLES` | Empty = preset default (mobile 2 / desktop 5). |
| repeats / sample | ✅ | ✅ | `QVAC_VLM_REPEATS` (local only) | Mean reported. Default 3 desktop / 1 mobile. No dispatch input. |
| task subset | ✅ | ✅ | `QVAC_VLM_TASKS` (local only) | `null` = all preset tasks. No dispatch input. |
| mobile timeout | — | ✅ | `-f mobile_timeout_min=N` · `config.mobileTimeoutMin` | Raises the Device-Farm Mocha/Android per-test ceiling. ≤120; empty/null = 35/30-min default. |
| candidate `ref` | ✅ | ✅ | `-f ref=<branch\|tag\|sha>` | Built as `addon@candidate`. Fork PR → use head **SHA** (fork branch names don't resolve in base repo). |

### 2.5 Report contents

| Feature | Desktop | Mobile | Where / when | Notes & restrictions |
|---|---|---|---|---|
| Quality "Overall %" (VQA) | ✅ | ✅ | presets with VQA tasks | lmms-eval-style mean (vqa/anls/mc). OCR-only presets show `—` here (data is in the OCR table). |
| OCR CER/WER/BLEU | ✅ | ✅ | OCR presets | Separate table (↓CER/WER, ↑BLEU), never folded into Overall %. |
| Speed: mmproj vision-encode | ✅ | ❌ | always | From llama.cpp stderr — **not captured on mobile**; the report shows `—` and uses **TTFT** as the mobile proxy. |
| Speed: TTFT / decode TPS / wall | ✅ | ✅ | always | |
| **Peak RSS** | ✅ | ✅ | Details table | Process high-water (`getrusage`). Populated on Linux/macOS/Windows **and Android + iOS**. ⚠️ CLI engine sources show `—` (separate subprocess). |
| **Δ % column** | ✅ | ✅ | **two-models** Highlights | Relative %, next to the absolute Δ, in all 3 comparison tables. `—` when baseline = 0. |
| Summary one-liner | ✅ | ✅ | **two-models** Highlights | 🚀/⚖️/🐢 + avg speed & quality across legs. Quality **blends VQA + OCR**. |
| **Engine versions table** | ✅ | — | **several-sources** Details | Build used + most-recent per source; *chosen automatically* / *set manually*. |
| Stability (warmup + thermal guard) | ✅ | ✅ | always | Warmup pass dropped (`block 0`); thermal guard before measuring (effectively mobile-only — see §5). |
| Preset label | ✅ | ✅ | report header | `**Preset:** <name>` below the Mode line. |

---

## 3 · How to launch (CI · local · config branch)

**A. CI (the normal path)** — `gh workflow run …` as in §1. Everything (mode, preset,
models, sources, platforms, samples, timeout) is a `-f` flag — **no commit needed**. The
dispatch value is forwarded to every leg: desktop via env, phones via the pushed
`qvacPerfConfig.txt` device-env channel.

**B. Local (desktop, no CI)** — run the harness under `bare` with env overrides:
```bash
QVAC_VLM_MATRIX=1 QVAC_VLM_MODE=two-models QVAC_VLM_PRESET=cognitive \
QVAC_VLM_MODELS=qwen3.5-f16,qwen3.5-q8 QVAC_VLM_SAMPLES=2 \
bare test/integration/vlm-matrix.test.js
```
All `QVAC_VLM_*` overrides: `MODE`, `PRESET`, `MODELS`, `SCENARIOS`, `SAMPLES`, `REPEATS`,
`DEVICES`, `TASKS`, `WARMUP_REPEATS`, `NO_GPU`. `node run-desktop.cjs --selfcheck`
validates the config/contract wiring without running a model. Several-sources CLIs are
built + driven by `cli-fixture-runner.cjs`.

**C. When a config edit is required (a branch)** — only the **model definitions** are
config-only (everything else is an `args` word). To change `MODEL_1`/`MODEL_2`/`SOURCES_MODEL`,
the model catalog, the baseline npm version, presets, or methodology tuning: edit
`config.cjs`, push the branch, and dispatch with `--ref <that-branch>`. (Or avoid the
edit entirely by passing an ad-hoc model via `models=<llm-url>|<mmproj-url>`.)

**Two worked examples:**

```bash
# two-models, mixed legs, ad-hoc challenger model
gh workflow run benchmarks.yml --ref <branch> -f packages=llm-llamacpp \
  -f configs=linux-x64,linux-x64-gpu,darwin-arm64 \
  -f args="suite=vlm mode=two-models preset=full models=qwen3.5-q8,challenger=https://huggingface.co/org/NewVLM-GGUF/resolve/<sha>/NewVLM-Q4_K_M.gguf|https://huggingface.co/org/NewVLM-GGUF/resolve/<sha>/mmproj-F16.gguf"

# candidate-vs-baseline: validate --ref's build against the latest published build
gh workflow run benchmarks.yml --ref <branch|tag> -f packages=llm-llamacpp -f configs=linux-x64 \
  -f args="suite=vlm mode=several-sources sources=addon@candidate,addon@baseline models=qwen3.5-q8 preset=full"
# addon@baseline auto-resolves to the LATEST published npm release — nothing to pin.
# To compare against a specific older release instead, add: -f baseline_npm=0.22.1
```

`prebuild-candidate` builds the **full platform matrix** from `ref`; a non-linux build
failure currently gates the desktop legs (desktop-only build filter is a follow-up).

---

## 4 · Report layout

1. **Highlights** — header (Mode · Engine · Preset), a one-line verdict (two-models:
   🚀/⚖️/🐢 + avg speed & quality), then Quality / Speed / OCR tables (two-models adds the
   **Δ %** column; several-sources is per-source).
2. **Details** — Engine-versions table (several-sources), Sources → resolved versions,
   Models & origins (Source = Registry/HF/S3/URL), HW/SW provenance, full matrices,
   **Peak memory (RSS)**.
3. **Test Results** — per-target pass counts.
4. **Image samples** — task → image → W×H.

---

## 5 · Measurement stability (warmup + thermal guard)

Cold-start (weight load, JIT, Vulkan shader-compile) and CPU **heating/throttling** skew
latency — especially on mobile. Three layers keep numbers steady-state:

1. **Warmup pass** — one pass over the first item before measuring, stamped `block: 0` and
   **dropped from every statistic** (override `QVAC_VLM_WARMUP_REPEATS`, `0` disables).
2. **Thermal guard** — `methodology.cjs` `stabilityGuard()` waits for a steady thermal
   state (calibrated CPU micro-probe), bounded by a hard `maxWaitMs`. **Mobile-only by
   default** (~6 s cap); desktop runs it `off` (fresh CI VMs don't throttle, and the probe
   doesn't reliably stabilise on a contended runner). Emits a `[VLMBLOCK]` marker.
3. **First-encode drop + repeats** — the vision-encode metric drops the first segment per
   cell (shader-compile spike); measured passes repeat (`repeats`, mean reported).

Tuning lives in `config.cjs` `methodology`.

---

## 6 · Known limitations & restrictions

- **several-sources *engine* mode is desktop-only.** `fabric`/`upstream` are native CLIs;
  the mobile path runs an addon app. (`addon@candidate`/`@baseline` builds *do* run on mobile.)
- **No P2P registry on mobile.** The QVAC Registry is a P2P (Hyperswarm/Hyperblobs) store
  reached via `@qvac/registry-client`, which is **not bundled into the mobile app**
  (desktop/Linux only). Registry blobs are fetched on every target via their **pinned
  HTTPS origin** (byte-identical); a `source.type:'registry'` blob fails on mobile. So
  mobile only works with **direct download links** (hf/url/s3).
- **mmproj vision-encode time is unavailable on mobile** — neither Android logcat nor the
  iOS console carry llama.cpp's native stderr; the report shows `—` and uses **TTFT**.
- **CLI-source Peak RSS shows `—`** — the CLIs are separate subprocesses; the in-process
  `getrusage` sampler measures the addon (and mobile addon), not a spawned CLI.
- **Candidate-vs-baseline on mobile can be flaky.** The desktop comparison and the mobile
  `addon@baseline` leg are solid; the mobile `addon@candidate` leg has timed out at the
  Device-Farm monitor under the candidate's longer pipeline (a fresh prebuild build) plus
  two concurrent device sessions. Re-run, or pin a higher `mobile_timeout_min`.
- **`ocr5pages` / `full` are heavy on mobile** — the high-MP OCR docs can overrun the
  Device-Farm session; raise `mobile_timeout_min` or prefer `smoke`/`cognitive`/`ocr1page`.
- **addon vs CLI prompt parity** — the addon API sends the image as its own `user` turn
  (~+11 tokens) vs the CLIs' single turn, so addon-vs-CLI quality isn't strictly
  apples-to-apples. `fabric` vs `upstream` is the clean engine comparison.
- **MC (ai2d)** scores only an explicit/short letter answer; a reasoning paragraph with no
  stated choice scores 0 (by design).
- **Small n** — defaults are modest (mobile 2 samples); raise `matrix_samples` for tighter
  estimates (single-sample borderline cases flip the mean).
- **No Windows Visual Studio** — CLI builds use pre-installed clang + Ninja.

---

## 7 · Extending

- **Add tasks / refresh images** — `node build-fixture.cjs --per-task 3 --max-side 1024`
  (filters HF datasets by resolution, open-licensed only, writes `./fixture/`, regenerates
  `fixture.data.cjs` + `fixture.NOTICE.md`). **Images are not committed** — they live in an
  S3 fixture store; upload `./fixture/` after regenerating. CI syncs it before each run.
- **Change models** — edit `MODEL_1`/`MODEL_2` or `SOURCES_MODEL` in `config.cjs` (each
  blob gets a `source` descriptor). Two variants of one model = same `llm`, different `mmproj`.
- **Add a platform** — one case in the workflow `context` job: desktop in `dmatrix`, a phone
  in `mmatrix` (must exist in the Device-Farm fleet). No harness change.
- **Tune the scorers** — `node score-check.cjs <report-or-log>` re-scores REAL predictions
  with the current scorers (no inference), so you can iterate on quality metrics offline.

---

## 8 · Files & contract

Runner ↔ report meet only at the frozen interface in **`CONTRACT.md`** (marker schema v2,
env vars, launch grammar); `markers-v2.sample.txt` is its executable sample;
`node run-desktop.cjs --selfcheck` validates it.

| File | Role |
|---|---|
| `config.cjs` | **single source of truth** — modes, presets, model catalog, sources, baseline, methodology |
| `vlm-matrix.test.js`, `harness.cjs` | the harness — loads models, runs items, emits markers (runs on every target) |
| `aggregate.js` | parses markers → report (quality scoring, Δ%, RSS, Engine-versions, Summary) |
| `combine.cjs` | host-side: log discovery, host tagging, provenance, render |
| `scenarios.cjs` | the task set (VQA + OCR) |
| `models.cjs` | `models` grammar → canonical model specs |
| `sources.cjs` | source tokens (addon / candidate / baseline / fabric / upstream) |
| `resolve-versions.cjs` | several-sources llama.cpp version resolver (auto max-common build / manual) |
| `version-guard.cjs` | helper: derive a source's build (addon vcpkg pin / CLI ref); preview parity locally |
| `methodology.cjs` | warmup + thermal-guard helpers |
| `cli-fixture-runner.cjs`, `cli-case-runner.js`, `stdout-parser.js`, `accuracy.js`, `utils.js`, `cli-source-config.js`, `build-cli-sources.js` | **vendored** native-CLI helpers — build + run fabric/upstream `llama-mtmd-cli` (several-sources, desktop-only) |
| `build-fixture.cjs`, `fixture.data.cjs`, `fixture.NOTICE.md` | fixture generator + frozen manifest + attribution (images in S3) |
| `score-check.cjs` | offline re-scoring of real predictions (metric tuning, no inference) |
| `stage.cjs` | copies harness + config + fixture into `test/integration/` + `testAssets/` for the mobile build |
| `run-desktop.cjs` | desktop run driver + `--selfcheck` contract guard |
| `CONTRACT.md`, `markers-v2.sample.txt` | the frozen runner↔report contract + sample |
| `../../ci/benchmark-vlm.sh`, `../../ci/benchmark-report.mjs`, `../../ci/prepare-mobile.mjs` | desktop legs, combine, and the mobile bootstrap, run by `benchmarks.yml` |

**Reused from the package** (not copied): the addon (`../../index.js`) and `ensureModel`
(`../../test/integration/utils.js`).

## 9 · Checkpoints

Periodic, reproducible baselines — Qwen3.5-0.8B vs Gemma-4-E2B across every platform ×
accelerator — captured over time to track improvements and regressions in the VLM
ecosystem, live in **[`checkpoint/`](./checkpoint/)**. See `checkpoint/README.md` for the
procedure (3 CI runs → two `avg ± deviation%` tables via `aggregate-checkpoint.cjs`) and
`checkpoint/checkpoints/` for collected snapshots.
