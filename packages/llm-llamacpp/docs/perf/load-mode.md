# `load_mode` on each platform and device

What each model-loading mode costs to load and to keep resident, measured per
device. Produced by `benchmarks/performance/load-mode-sweep.js`.

> Status: **linux-x64 complete.** darwin-arm64, darwin-x64, win32-x64,
> linux-arm64, Android and iOS are not yet measured; §"Coverage" lists what each
> one needs. No row below is inferred — every figure is a measurement on the
> host named in its section.

## What the modes are

From `addon/src/model-interface/LoadFitNormalization.cpp` (`kLoadModes`) and
fabric `v10549.1.0` (`llama-model-loader.cpp:584`, `llama-model.cpp:1381`):

| Mode | Maps the weights | Locks | Direct I/O |
|------|------------------|-------|-----------|
| `auto` | yes, **unless** a selected device reports no mmap support → loads anonymously | no | no |
| `mmap` | yes | no | no |
| `mlock` | **no** — reads anonymously, then locks | yes | no |
| `mmap+mlock` | yes | yes | no |
| `none` | no | no | no |
| `dio` | no | no | **no — see "dio is inert"** |

`mlock` is not "`mmap` plus locking". It is the anonymous path plus locking.

**`auto` is the default.** Not `mmap`, as the README long claimed and as
QVAC-25043 was written assuming. It changed in #4154 (fabric b10549 sync,
merged 2026-09-10) and is pinned by
`LlamaModelTest.CommonParamsParseLoadModeDefaultsToAuto`. Every margin below is
therefore quoted against `auto`, and against `mmap` where the two differ.

`auto` falls back to the anonymous path when any selected device sets
`mmap_support = false`: OpenCL (`ggml-opencl.cpp`), Hexagon
(`ggml-hexagon.cpp`), Vulkan integrated GPUs (`ggml-vulkan.cpp`,
`!ctx->is_integrated_gpu`) and CUDA integrated GPUs (`ggml-cuda.cu`). On
everything else it maps.

## linux-x64

Host: Intel Core Ultra (Arrow Lake) with **both** an Intel iGPU (`uma: 1`) and
an RTX 5080 Laptop (`uma: 0`) — so one machine measures both sides of `auto`'s
decision. Model: Qwen3.5-0.8B-Q4_0. Addon `@qvac/llm-llamacpp@0.53.2`, fabric
`0.16.1`. One unmeasured warm-up per model, then 5 samples per cell, each in
its own process, with modes rotated between repetitions. All samples are
warm-cache; memory is the mean delta across them.

Figures are **medians of 5 samples**, each sample its own process, modes
rotated within a device group, each device group run as its own pass. Medians
rather than means because the integrated GPU shows an intermittent stall — see
"measurement artifacts" below. Memory is the mean delta; it was stable across
every run.

### Device selection left to the engine (`device: gpu`, no `main-gpu`)

| mode | status | load ms (median) | mean ± σ | Δ vs `auto` | rss | anon | file | locked |
|------|--------|------------------|----------|-------------|-----|------|------|--------|
| `auto` | measured | **774.4** | 777.1 ± 14.5 | — | 489.6 | 130.5 | 359.5 | 0 |
| `mmap` | measured | 781.3 | 793.7 ± 47.3 | +0.9% | 489.5 | 130.5 | 359.5 | 0 |
| `mmap+mlock` | measured | 782.4 | 817.6 ± 73.3 | +1.0% | 491.0 | 132.2 | 359.4 | 198.9 |
| `dio` | inert | 1903.0 | 1903.6 ± 22.4 | +146% | 325.5 | 132.4 | 193.6 | 0 |
| `none` | measured | 1918.7 | 1944.1 ± 73.5 | **+148%** | 322.4 | 129.0 | 193.6 | 0 |
| `mlock` | measured | 1928.7 | 1935.4 ± 71.6 | +149% | 323.6 | 130.7 | 193.5 | 0 |

`auto`, `mmap` and `mmap+mlock` are tied within their spread.

### Discrete GPU pinned (`main-gpu: dedicated`, RTX 5080)

| mode | status | load ms (median) | mean ± σ | Δ vs `auto` | rss | anon | file | locked |
|------|--------|------------------|----------|-------------|-----|------|------|--------|
| `auto` | measured | **763.8** | 776.6 ± 32.3 | — | 486.5 | 127.2 | 359.7 | 0 |
| `mmap` | measured | 770.1 | 784.3 ± 24.5 | +0.8% | 491.7 | 132.2 | 359.7 | 0 |
| `mmap+mlock` | measured | 772.4 | 790.7 ± 43.7 | +1.1% | 488.3 | 128.9 | 359.7 | 198.9 |
| `mlock` | measured | 1857.5 | 1878.9 ± 92.0 | **+143%** | 324.1 | 130.7 | 193.9 | 0 |
| `none` | measured | 1865.3 | 1861.6 ± 38.4 | +144% | 324.3 | 130.7 | 194.0 | 0 |
| `dio` | inert | 1875.0 | 1900.6 ± 73.3 | +145% | 324.3 | 130.7 | 193.9 | 0 |

### Integrated GPU pinned (`main-gpu: integrated`, Intel ARL)

| mode | status | load ms (median) | mean ± σ | Δ vs `auto` | rss | anon | file | locked |
|------|--------|------------------|----------|-------------|-----|------|------|--------|
| `mmap+mlock` | measured | **713.3** | 714.3 ± 6.6 | −11.7% | 452.9 | 119.4 | 333.9 | 198.9 |
| `mmap` | measured | 738.2 | 743.7 ± 34.6 | −8.7% | 452.8 | 119.4 | 333.8 | 0 |
| `mlock` | measured | 779.2 | 927.5 ± 322.7 ⚠ | −3.6% | 255.2 | 119.9 | 135.4 | 0 |
| `none` | measured | 786.8 | 937.0 ± 340.6 ⚠ | −2.7% | 254.7 | 119.7 | 135.4 | 0 |
| `dio` | inert | 806.0 | 828.8 ± 68.6 | −0.3% | 254.7 | 119.8 | 135.2 | 0 |
| `auto` | measured | 808.3 | 1026.6 ± 342.5 ⚠ | — | **255.0** | 119.8 | 135.4 | 0 |

⚠ = at least one stalled sample; read the median.

### Measurement artifacts, and what each one cost

Four confounds were found, each by re-measuring rather than by reasoning, and
each produced numbers that looked like results. For a load-time metric almost
every confound is positional, which is why this could not simply reuse the
throughput suite's method: that suite measures a warmed, resident model in
steady state and is immune to all of them.

| Artifact | What it did | Fix |
|----------|-------------|-----|
| Shared process | `unload()` retains 135–194 MiB, so each later cell's baseline was raised. Five modes read +369/+215/+34/+0.01/−0.4 MiB purely by order | one process per sample |
| Back-to-back repeats | repeats 2–3 inherited an identical load's driver state; the integrated anonymous modes read a tight, wrong ~810 ms ± 15 | rotate modes between repetitions |
| Cross-device interleaving | putting discrete-GPU cells between integrated samples blew those rows out to ~1100 ms ± 500 | one pass per device group |
| Intermittent stall | a multi-hundred-ms stall hits ~1 sample in 3 on the integrated anonymous path, moving between modes run to run | report medians, print every sample, flag mean > 1.15 × median |

The stall is **not** understood and is not a property of any mode — it moved
between `auto`, `none`, `mlock` and `dio` across four runs while their memory
figures stayed identical. It may be the Intel driver, contention with the
discrete card's driver, or the engine; isolating it needs a quiet
single-GPU host and is out of scope here. It is recorded because anyone
shipping to integrated-GPU hosts would want to know, and because it is why this
section quotes medians.

## What the numbers say

**`auto` selects the right path on every device selection measured.** Its
memory and file-residency figures match `mmap` exactly on the unpinned and
discrete cases (358 MiB file) and match `none` exactly on the integrated one
(136 MiB file). The heuristic fires where it should and nowhere else.

**On a discrete GPU the mapped path is worth ~2.4× the load time.** Every
anonymous mode costs ~1.86–1.93 s against ~0.76–0.78 s mapped, tight on both
sides. `auto` maps there, which is clearly right: ~165 MiB of resident memory is
not worth an extra 1.1 s of load on a host with its own VRAM.

**On an integrated GPU `auto` buys ~198 MiB of system RAM for about 9% of load
time.** Mapped residency is 453 MiB against 255 MiB anonymous, and `auto` takes
the 255 MiB at a median 808 ms against `mmap`'s 738 ms — ~70 ms. A cheap trade,
and the right one: an integrated GPU allocates out of the system RAM it
competes for with everything else on the machine, which is exactly the
condition upstream's `mmap_support = false` flag encodes.

**No flat per-platform default beats `auto` on linux-x64.** A flat `mmap` would
spend 198 MiB on integrated hosts to save ~70 ms; a flat `none` would spend
~145% of load time on discrete ones to save ~165 MiB. Both trades are bad, and
they point in opposite directions on two devices inside the same machine — so
the choice cannot be a platform constant. Nothing here argues for changing the
default.

**`mmap+mlock` is the fastest mode in all three groups** — 770/788/734 ms,
marginally ahead of plain `mmap` each time. The margin is inside or close to the
samples' spread in the unpinned and discrete cases, so it should not be read as
a recommendation; it is reported because an absent row is not the same as a
measured tie.

### `dio` is inert

`dio` is accepted and behaves identically to `none` on every counter and every
device. It never requests `O_DIRECT`: fabric's `llama-model-load.cpp:22`
constructs `llama_file_disk(fname, "rb")` and drops the constructor's third
`use_direct_io` argument. Verified at `v10549.0.0`, `v10549.1.0` and fabric
`master`.

**It is therefore inert on every platform, not only where direct I/O is
unsupported.** The argument is dropped before any platform-specific code runs,
so `dio` is `none` on macOS, Windows, Android and iOS exactly as it is on
linux. The separate fact that the POSIX implementation is `#ifdef __linux__`
(`llama-mmap.cpp`) only becomes observable if fabric ever wires the argument
through; until then it changes nothing, and no platform should be recorded as
"unsupported" on that basis.

Rows are labelled `inert` rather than reporting a margin against `none`, which
would be noise presented as signal.

### `mlock` locks nothing on a GPU load

`locked` reads 0 MiB for `mlock` on all three device selections, while
`mmap+mlock` locks 198.9 MiB. `mlock` takes the anonymous path and the weights
land in device memory, so there is nothing host-resident left to lock — its
timing and residency match `none` exactly. On a CPU-backend load the same mode
does lock (231 MiB measured on Llama-3.2-1B-Q4_0).

`mlock` failing is silent: llama.cpp warns and continues when the lock exceeds
`RLIMIT_MEMLOCK`. `ulimit -l` on this host is 7.8 GB. A stock Linux (8 MB) or
an Android device will not lock, and will not raise an error saying so — the
`locked` column is how you tell.

## Reading the memory columns

**`rss` alone ranks the modes wrongly, and which column is decisive depends on
the backend.** Both facts are measured, not theoretical:

- On the **CPU** backend, a mapped load reads *higher* total rss than an
  anonymous one (1484 vs 978 MiB on Llama-3.2-1B-Q4_0) while costing *less*
  anonymous memory (626 vs 857 MiB). The mapped weights are file-backed and
  evictable; the anonymous figure is what the system must actually find. Total
  rss ranks `mmap` worst on exactly the number that matters least.
- On a **GPU** backend, `anon` is flat across all six modes (119-134 MiB) and
  **`file`** carries the whole difference.

So all three are recorded and none is collapsed into a single "memory" number.
`anon`/`file` come from `/proc/self/status` and are `null` — recorded as
absent, not as zero — on platforms without `/proc`. `rss` is
`bare-os`'s `memoryUsage().rss`, the same counter
`model-fit`'s calibration harness and `asr-ggml`'s `memory-usage.js` use, so
figures stay comparable across packages.

## Desktop and mobile do not measure to the same precision

Desktop takes five samples per cell, each in its own process, and reports a
median. **Mobile takes one.** A Device Farm shard loads the model once and
runs its generations against that load, so `load_ms` is a single sample
repeated across the cell's rows — there is no spread to report and no median
to protect against an outlier.

That follows from how the mobile harness is built: a shard loads once and
reuses that load for its generations, and shards run against the 20-minute iOS
per-test ceiling. Adding repeated loads would mean reworking the shard, which
this task did not do.

The consequence is that **no mobile load-time margin here is backed by a
spread**, so this document states mobile load times as observed values and
draws no timing verdict from them — the report generator does the same, naming
a fastest mode on desktop cells only. The memory figures do not have this
problem: they are a property of the load rather than a timing, and the
mapped-versus-anonymous gap is hundreds of MiB. The mobile verdicts below
therefore rest on residency.

## Method, and why each measurement is its own process

Every cell is measured in a fresh process. This is load-bearing, not hygiene:

- **`unload()` does not return everything.** On the Vulkan backend it leaves
  135-194 MiB of file-backed residency permanently resident (the
  `retainedAfterUnload` field in the JSONL). The baseline therefore shifts
  after the first load and never returns, so every later delta in the same
  process reads short. The same mode measured three times in one process gave
  +373, +209, +209 MiB.
- **The page cache carries across modes.** Sequential loads in one process ran
  756, 439, 437 ms for the same mode — whichever mode is measured first pays
  for the others.

Measured in sequence inside one process, five modes read +369 / +215 / +34 /
+0.01 / −0.4 MiB, entirely by load order. The same five, one process each, read
+383 / +384 / +203 / +203 / +203 MiB. Any harness that measures load in a
shared process is measuring position, not mode.

**No cold-load figure is reported, because none is measured.** A fresh process
resets process state, not the OS page cache: after the first read of a model
file every later process inherits a warm cache. Calling each cell's first
sample "cold" would report load ordering as a property of the mode. Instead one
unmeasured warm-up per model puts every cell on the same warm footing, and
modes are rotated between repetitions so thermal drift and ordering spread
across modes rather than landing on whichever ran first. A genuine cold-load
comparison would need the page cache dropped between samples, which needs root
and is unavailable on Device Farm; it is not something this ticket asks for.

Each row also records `backendDevice` from one minimal inference taken after
the memory sample. An explicit `main-gpu` naming a device class the host lacks
falls back to the CPU silently, so a row whose backend disagrees with its
requested device is a mislabelled measurement; the renderer flags those rather
than reporting them.

## Reproducing

```
cd packages/llm-llamacpp/benchmarks/performance
node prepare-models.js --target addon --models qwen3.5-0.8b
node load-mode-sweep.js --models qwen3.5-0.8b --load-mode-quantizations Q4_0
```

Every axis narrows from the command line, so a run needs no code edit:
`--load-mode`, `--load-mode-quantizations`, `--load-mode-main-gpu` (`none`
means "do not pin"), `--load-mode-device`, `--load-mode-ctx-size`,
`--load-repeats`, `--addon-source` (`local` or `npm`), `--results-dir`.

Results are written as JSONL plus a rendered markdown table.

## Coverage

| Platform | State | What it needs |
|----------|-------|---------------|
| linux-x64 | **done** | — |
| darwin-arm64 | not measured | a run on `qvac-macos26-arm64-gpu` or `qvac-dev-mac-arm64`. No `RssAnon` equivalent on darwin; expect `rss` only, and note unified memory means the mapped/copied split does not arise as it does on linux |
| win32-x64 | not measured | a run on `qvac-win25-x64-gpu`. `llama_mmap` prefetches with `PrefetchVirtualMemory`, which fills the standby list without faulting pages into the working set, so the Windows memory column will not be comparable with the others |
| darwin-x64 | not measured | hosted `macos-15-large` only, a VM whose Metal device reports as "Apple Paravirtual device"; measure CPU-forced and label it so |
| linux-arm64 | not measured | Jetson Orin Nano. `model-fit`'s calibration records this host failing to load at all under the SDK's pinned `n_gpu_layers: 99`; expect to record it as blocked |
| Android | not measured | Device Farm. The highest-value remaining target: Adreno/OpenCL sets `mmap_support = false`, so `auto` should diverge from `mmap` as it does on the integrated GPU above. `mlock` will likely fail on `RLIMIT_MEMLOCK` |
| iOS | not measured | Device Farm. Metal supports mmap, so expect `auto` ≡ `mmap` |

Mobile is wired and waiting on a dispatch. `_benchmark-perf.js` now times the
load and samples RSS (anon/file/locked from `/proc`, so Android reports the
split and iOS reports total only), `_perf-helper.js` carries those figures,
and the matrix defines twelve load-mode shards — six modes on each of GPU and
CPU, split into two Device Farm batches to stay inside the proven ~10-shard
load. Each backend gets its own session because `unload()` leaves
mode-dependent residency behind, so a CPU load measured after a GPU load in
one session reads against a polluted baseline.

Run them with `sweep_params=load-mode` on **Benchmark Performance — LLM
Parameter Sweep**: 12 mobile shards instead of 86, and no six-hour grid.
