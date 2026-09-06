# assessModelFit calibration

`assessModelFit` turns catalog metadata into a memory bound. The metadata gives
the parts that are computable — artifact bytes and the KV cache — and this
directory holds the parts that are not: the runtime overhead that only a real
load can tell you. A platform without validated coefficients here assesses as
`unknown`, because an uncalibrated formula is not evidence.

## What is computed vs measured

| Term                      | Source                                                     |
| ------------------------- | ---------------------------------------------------------- |
| Weights, lower bound      | `artifactBytes` from the catalog profile                   |
| Weights, upper bound      | `artifactBytes × weightUpperCoeff` (measured)              |
| KV cache                  | Computed from `ggufFacts` and the requested context        |
| Fixed runtime overhead    | Measured (`fixedOverheadBytes`)                            |
| Compute/graph buffers     | Measured, per context token (`computeBufferBytesPerToken`) |
| One operation's peak      | Measured (`workingPeakBytes`)                              |
| Whisper 30 s window       | Measured (`audioWindowBytes`)                              |
| Whisper streaming session | Measured (`audioStreamingBytes`)                           |

The KV cache is computed rather than measured because it is the term that varies
most between models, and the file describes it exactly — see `estimators/llm.ts`
for the per-layer accounting.

## Procedure

The procedure is `calibration/harness.ts`, exported as
`@qvac/inference/model-fit-calibration`. On desktop,
`scripts/calibrate-model-fit.ts` runs it on the platform being calibrated (bare
≥ 1.30 runs the script directly via type-stripping) and writes the fixture. On
a phone the same module runs inside the SDK e2e consumer's calibration plugin
and the fixture comes back as the test output — see "Mobile" below.

llama.cpp allocates **almost everything at load** — weights, KV cache, engine
overhead and the context-scaled compute buffers — so a load's RSS delta is the
bulk of the cost, and the fit reads persistent deltas rather than working
samples.

What a completion adds on top is measured separately, into
`workingPeakBytes`, and is not part of the fit. It was long believed to be
zero, on evidence that turned out to be a bug: the harness awaited a property
`CompletionRun` does not have, so the sampler stopped before any token was
generated and every point recorded 0. With that fixed it is 3–9 MiB on linux,
windows and Apple silicon, and 73 MiB on darwin-x64 — above the harness's own
64 MiB drift threshold, which had therefore never fired. It belongs in `working` rather than
in the resident terms because it is released afterwards: `sequential`
aggregation counts it once, `concurrent` counts it per model.

On platforms where a GPU means discrete device memory (linux, windows,
darwin-x64) the harness loads with `device: 'cpu'`: RSS cannot observe VRAM,
so the coefficients describe CPU-resident execution — the case where system
RAM is the binding constraint. A second `--gpu` pass then measures the same
models resident on the device, against the GPU counter, and writes a fixture
keyed by backend; assessment uses those when a GPU is present and falls back
to `unknown` where it cannot identify the device or trust its readings.

A third `--igpu` pass covers the host in between, and the most common one: a
machine whose only GPU is integrated. There the engine runs on the GPU, but an
integrated device allocates out of system RAM, so RSS is still the right
counter and the budget is still the system one. The pass pins the class of
device with `main-gpu: 'integrated'` — the class, not an index, so a host that
also has a discrete card still measures the integrated one — keeps the SDK's
default load mode, and writes `<platform>-<backend>-shared.ts`. Its
coefficients are not interchangeable with either neighbour's: the buffers are
the backend's, as in a `--gpu` pass, but they are spent against the system
budget, as in a CPU-forced one.

Forcing the CPU has to use the `device` key rather than `gpu_layers: 0`: the
addon derives its KV-cache default from the backend that key selects
(`LoadFitNormalization.cpp`, `isGpu`), so `gpu_layers: 0` on a host with a
Vulkan-capable GPU still builds a `q8_0` cache while every layer runs on the
CPU, and the `f16` subtracted for a CPU run would be twice what the engine
allocated. The first Windows run failed exactly that way (see "Windows").

Every pass asserts what the engine reported executing on (`backendDevice` in
the completion stats) before it accepts a point. A `--igpu` pass on a host with
no integrated ggml device would otherwise fall back to the CPU inside
`chooseBackend` and file CPU numbers under a GPU backend key.

1. For each of three models (small, medium, large) at two contexts, **three
   times each**: settle, read RSS, load, settle, read RSS again — the difference
   is **persistent**. Single-shot loads were observed to vary by up to ~100 MiB
   run to run, so every repeat enters the fit. The model set and contexts come
   from a per-platform-family profile in the harness: desktop uses 600M/1B/4B at
   512/8192 with 8B held out; mobile uses 600M/1B/1.7B at 512/4096 with 4B held
   out, because every load must stay well under a phone's per-process ceiling —
   iOS jetsam kills near it, and a killed harness measures nothing (needs a
   device with at least 6 GB of RAM).
2. Subtract the KV cache from each persistent delta — the cache the engine
   _actually allocated_, taken from the estimator's own `kvElementBytes` rather
   than assumed. On a Metal or Vulkan backend the default is `q8_0`, so a fixed
   `f16` assumption over-subtracts by nearly 2×; because that error scales with
   context it lands in the per-token slope rather than the intercept, corrupting
   the one coefficient the two-context design exists to isolate. A point that
   measures less than the cache being subtracted stops the run — it is the
   signature of subtracting a cache the engine never allocated.
3. What remains is `ratio × artifactBytes + fixed + perToken × context`, so a
   three-parameter least squares over all points (`calibration/fit.ts`, unit
   tested) separates `weightUpperCoeff` (the marginal resident bytes per
   artifact byte), `fixedOverheadBytes`, and `computeBufferBytesPerToken`. Two
   contexts per model is the minimum that can tell the last two apart; three
   artifact sizes pin the ratio.
4. Bounds are set at ±20% of the fit, with the fixed-overhead upper bound
   additionally floored at the worst point observed above the fitted plane — an
   upper bound that does not cover an observed point is not an upper bound. The
   weight ratio carries 1% rather than 20%, because it multiplies the largest
   term: 20% of a 5 GB model would be a gigabyte of invented headroom, and 0%
   is what cost linux-x64 a held-out failure (below).
5. **Held-out check.** A fourth model, excluded from the fit, is measured the
   same three times, and its predicted upper bound is assembled the way the
   estimator assembles one — the working peak included. `validated` is set only
   when the worst measured total lands at or below it. A failing held-out check
   means the coefficients do not ship.

### Why the weight ratio needs a margin of its own

`weightUpperCoeff` shipped as `max(1, fittedRatio)`, so a fitted 0.995 became
exactly 1.000: a claim that resident weights never exceed the artifact by a
single byte, while every other coefficient carried ±20%.

linux-x64 failed its held-out check on that (run 33795110381): 5.83 GiB
measured against 5.82 predicted. The fit there put the intercept at ~0 —
correctly, since an anonymous load makes resident ≈ artifact + cache almost
exactly — which left nothing to absorb the extrapolation from a 2.5 GB largest
fit point to a 4.7 GB held-out model, whose real fixed cost measured ~21 MiB.
Two earlier runs on the same host passed by 0.2% and 1%, so the gate was a coin
flip rather than a bound.

1% is the scale the fitted slope moves by between runs on one host (0.995 and
0.997 on linux, 1.078 and 1.079 on arm). On a 5 GB model it is ~50 MiB, against
an interactive reserve of 2 GiB — two orders of magnitude inside the headroom
the policy already keeps.

## RSS and mmap

RSS is read from `bare-os`'s `memoryUsage().rss` rather than `getrusage(2)`
`maxRSS`, whose units differ by OS. This is the same choice
`packages/asr-ggml/test/integration/memory-usage.js` makes, so figures stay
comparable across packages.

llama.cpp maps weights by default, so the resident weight pages are file-backed
and evictable rather than anonymous RAM. The estimator counts them at full size
anyway — the conservative reading, recorded as an assumption on every result.
Measure with the same defaults the SDK uses, or the residuals will not describe
what users actually run.

One observed consequence: the very first load of a freshly downloaded file ran
~250 MiB of RSS above the warm repeats of the same load (page-cache effects on
a 2.4 GiB model). The committed coefficients describe warm loads and do not
cover that transient — deliberately, because the excess is file-backed and
evictable, so it is not memory the system has to find under pressure.

The same effect shows up per process, not just per download: the first load of
a run reads high whatever the page cache holds. Measured, it appeared on every
desktop platform as a first repeat well above the next two, which agreed with
each other exactly (linux 857 / 645 / 645 MiB) — reported by the repeat check
as a busy host, and enough to skew the linux weight ratio to 1.7. The harness
therefore performs one unmeasured warm-up load before the measurement loop.

### KV-growth tripwire

Before fitting anything, the harness checks the points against the one term
the file sizes exactly. Between the two contexts every model's persistent delta
must grow by at least the computed KV growth — the per-token compute buffers
can only add to it. `kvObservation` (`calibration/fit.ts`, unit tested) sums
that growth across the fit models and the run stops when the deltas grew by
less than 90% of it, printing what the same growth would read as at the other
KV element width: a shortfall means either the engine built a different cache
type than the one subtracted, or RSS is missing allocation, and no fit on top
of either is an upper bound. Summed rather than per model so a small model's
growth, which sits inside run-to-run noise, does not decide alone; repeats
enter as their median so the cold page-cache transient on the run's first load
(which lands on the small context) does not read as a shortfall. darwin-arm64
sits at ~1.0.

### Windows

`memoryUsage().rss` is libuv's `uv_resident_set_memory`, which on win32 returns
`GetProcessMemoryInfo().WorkingSetSize` — the pages currently resident for the
process. Two things distinguish it from RSS on the other desktops, and only one
of them turned out to matter.

The first CPU-forced run (`gpu_layers: 0` on a host with an Intel iGPU) aborted
with 10 of 18 points below the f16 KV cache being subtracted: a 2.4 GiB model
read as 71–128 MiB persistent at 512 tokens, and at 8192 tokens the deltas
were ~717 MiB against a computed 1152 MiB. A probe on the same runner that
read `WorkingSet64` and `PrivateMemorySize64` (the commit charge, which no
trimming can lower) side by side settled it: both counters saw the same
growth between the contexts, 58–60% of the f16 figure — which is 105–110% of
a `q8_0` cache. The engine had defaulted the cache to `q8_0` because the
`device: 'gpu'` default selected the Vulkan backend regardless of
`gpu_layers`, and the harness subtracted `f16`. Anonymous memory — KV cache
and compute buffers — was fully present in the working set; no trimming was
observed. `device: 'cpu'` is the fix (see the procedure above).

The second difference is the mapped weights. `llama_mmap`
prefetches the file with `PrefetchVirtualMemory`, which fills the standby list
without faulting pages into the working set, so right after a load RSS shows
almost none of them (16 MiB of a 2.4 GiB model) and the weight ratio cannot
be fitted. The harness therefore loads with `load_mode: 'none'`,
which reads the weights into anonymous memory; the probe measured the working
set at artifact + KV + ~30 MiB in that mode, with the 8192-token growth at
110% of the KV growth (the rest being compute buffers). A fixture measured
that way is still an upper bound for the mmap default users run — a mapped
weight set can keep at most the artifact size resident — and the fixture says
so in `notes`. The commit charge was evaluated as an alternative counter and
rejected: it sees the same KV growth as the working set but carries ~0.8 GiB
of committed, never-touched backend memory that physical RAM never pays for.

Every CPU-forced platform loads anonymously, for two different reasons. Linux
counts mapped weights the opposite way round: with the CPU backend selected it
copies them into its own buffers and RSS counts both copies, so a 2382 MiB
artifact read as 4118 MiB persistent and the weight ratio fitted at 1.71. That
is not memory the system must find — the mapped half is file-backed and
evictable — so linux takes `load_mode: 'none'` too, and measures the anonymous
copy alone.

Measured under `device: 'gpu'` linux reads ~1.0 (2415 MiB for the same
artifact), because no CPU-backend copy exists there. That number does not
transfer to a CPU-forced run, and reading it across cost a calibration round.

## Which fixture a host gets

`assess.ts` classifies the GPUs the collector reports before it picks
coefficients, because the classification decides both the budget and which
fixture describes the load. Two kinds of reported device are discounted first,
both because `chooseBackend` would pass them over and fall back to the CPU: a
paravirtual display adapter (`type` is `VIRTUAL` — the virtio / VMware /
Hyper-V device a VM or cloud host exposes; the hosted arm64 runner is one, and
llama.cpp reports "no usable GPU found" there), and a device with no graphics
API this build talks to. The driver flags are library-presence checks —
`libvulkan.so.1`, `vulkan-1.dll` — which is what ggml's own backend needs in
order to load, so their absence is evidence about the engine and not only
about the collector.

What remains decides the placement:

| Host                              | Basis                   | Fixture                       |
| --------------------------------- | ----------------------- | ----------------------------- |
| No usable GPU                     | system memory           | `<platform>`                  |
| Only integrated GPUs              | system memory           | `<platform>-<backend>-shared` |
| One or more cards with own memory | device memory or budget | `<platform>-<backend>`        |

An integrated GPU is one that says so (`unifiedMemory`) or one whose declared
memory is under 1 GiB — the Windows iGPU declares a 128 MiB carve-out of its
own and is therefore typed dedicated, and nothing but that size separates it
from a real card.

Where several cards have their own memory, all of them are carried. The engine
pins the model to one (`--device`, with split mode `none` by default) and which
one is a ggml enumeration order the SDK cannot see, so the cards are
alternatives rather than bounds to intersect: a fit has to hold on the smallest
and a refusal on the largest, and anything between the two is `unknown`. Cards
that disagree on the backend, or on whether their readings are device- or
process-scoped, have no single set of coefficients and yield `unknown`.

A discrete-GPU verdict is additionally bound by system memory, because that
load is paid for in RAM as well — a 2382 MiB model raised RSS by 2918 MiB on
win32 and 868 MiB on linux.

## Mobile

A phone has no shell to run the script from, and `@qvac/sdk` reaches the
engine only through its worker, so the harness runs where the engine lives:
the SDK e2e consumer bundles a `custom-calibration-plugin` whose single
streaming handler calls `runModelFitCalibration` inside the worker and relays
its log lines and result. The e2e test `calibration-model-fit` (suite
`calibration`) drives it and returns the run — coefficients, held-out check,
warnings and the `<platform>.ts` source — as its output, so the producer's
`results-<runId>.json` carries the fixture off the device without parsing
logcat. Every run except a calibration dispatch drops the test producer-side
with `--exclude-suite calibration`; the definition itself always ships, because
a consumer resolves incoming testIds against that list.

Two hosts run that test: `npx qvac-test run:local:android|ios` against an idle
physical device plugged in with a registry-reachable network, or the test-sdk
dispatch with `calibration: android|ios`, which builds the consumer, uploads it
to a Device Farm pool, runs only that test, and publishes the fixture as a
`calibration-fixture-<platform>-<runId>` artifact. Device Farm gives each run
a device to itself, so there is no equivalent of the desktop drain-stop hook to
arrange; the busy-host warnings still apply and a warned fixture still does not
ship.

What RSS means there differs by OS. Android's counter is the same Linux RSS as
desktop. On iOS `uv_resident_set_memory` reads `task_info` resident size, which
counts touched file-backed pages; jetsam's budget is `phys_footprint`, which
does not. RSS therefore reads at or above what jetsam charges for the same
load, so a fixture measured on it stays an upper bound for the per-process
budget `assessModelFit` compares against on iOS — conservative, not
optimistic. Per-process measurement also means the app hosting the worker is
part of the baseline; every delta subtracts a settled reading taken in the same
process, so the host's own footprint cancels.

A calibrated iOS fixture is necessary but not sufficient. iOS assesses on the
`process-memory` basis, whose budget is `os_proc_available_memory()` plus the
current footprint, and no native source supplies the first term today —
`resolveBudget` returns `unknown` before calibration is ever consulted. So an
iOS run here is worth doing (the coefficients are what they will be), but iOS
keeps returning `unknown` until that native metric lands. Android has no such
gap: it assesses on `system-memory`, and only the fixture is missing.

Both mobile platforms are in `forcesCpu`, which is not what unified memory
would suggest. The first two Android runs left the engine to choose its own
device and it chose the GPU on every point — while `bare-gpu-info` reported no
GPU at all, because it has no Android backend at the pinned `libgpuinfo`. Two
things broke at once: RSS never saw the allocation (persistent deltas flat at
~200–290 MiB for every model at every context, KV growth −3% of computed), and
`hasGpu` read false, so the harness subtracted an `f16` cache while a GPU
backend builds `q8_0`. Forcing the CPU makes the counter and the subtracted
cache agree again, at the price of describing CPU-resident execution only —
the same trade the discrete-GPU desktops make. A phone's GPU cannot be
calibrated until the collector can name the device.

## Scope of a fixture

Coefficients are keyed by **platform**, while several of the buffers they cover
are allocated by the **backend**. A `linux-x64` fixture measured on a CUDA host
is therefore applied to CPU-only hosts on the same platform too.

That is a deliberate choice, not an oversight. Splitting the key by backend would
multiply the number of runs needed before the feature returns anything useful
anywhere, and the ±20% bounds are wide enough to absorb some of the spread. What
makes it safe to defer is that every fixture records the conditions it was
measured under — `measuredOn.backend`, the GPU name, and the KV element width the
residuals were computed against — and every assessment echoes them as an
assumption on the result. So if a backend spread later proves wider than the
bounds absorb, the key can gain a backend dimension without re-measuring
anything, because each existing fixture already states which backend it
describes.

Practically: prefer to calibrate on the backend most users of that platform will
actually hit, and read `measuredOn` before trusting a fixture for a different
one.

## Status

| Platform                    | Measured                                     | Held-out Qwen3-8B, measured / predicted | Run         |
| --------------------------- | -------------------------------------------- | --------------------------------------- | ----------- |
| darwin-arm64                | Metal, Apple M4 Max                          | 5.28 / 5.41 GiB                         | 33796876756 |
| darwin-x64                  | CPU-forced, macos-15-large (hosted)          | 5.92 / 6.07 GiB                         | 33796616019 |
| linux-arm64                 | CPU-forced, ubuntu-22.04-arm (hosted)        | 5.87 / 6.45 GiB                         | 33796582408 |
| linux-x64                   | CPU-forced, RTX 4000 SFF host                | 5.81 / 5.89 GiB                         | 33796564146 |
| win32-x64                   | CPU-forced, RTX 4000 SFF host                | 5.87 / 5.99 GiB                         | 33796554816 |
| linux-x64 \| vulkan         | GPU-resident, RTX 4000 SFF Ada               | 5.25 / 5.71 GiB                         | 33796564146 |
| win32-x64 \| vulkan         | GPU-resident, RTX 4000 SFF Ada (DXGI budget) | 5.25 / 5.70 GiB                         | 33796554816 |
| win32-x64 \| vulkan, shared | Integrated, Intel UHD Graphics 770           | 9.72 / 10.53 GiB                        | 33796554816 |
| android-arm64               | CPU-forced, Pixel 10 Pro XL (Device Farm)    | 3.33 / 3.57 GiB (Qwen3-4B)              | 34044819621 |
| ios-arm64                   | not run                                      | —                                       | —           |

Every measured row is `validated: true`: its held-out model landed inside the
bound, and no run shipped from a log carrying a busy-host warning.

`android-arm64` took three runs to measure. The first two aborted on the KV
tripwire; the second recorded `backendDevice` and named the cause — the engine
executed on the GPU on every point, including the warm-up, while the collector
reported no GPU at all. See "Mobile" for what that broke. Once CPU-forced, the
same device read KV growth at 99/129/102% of computed and the held-out model
landed inside the bound. Its `weightUpperCoeff` of 1.219 is the highest of any
platform, which is what `load_mode: 'none'` costs on a phone: the anonymous
copy is counted alongside pages the mapping already made resident.

One caveat on the table: `linux-x64 | vulkan` carries `workingPeakBytes: 0`
from a run that took no device sample, not from a measurement. `win32-x64 |
vulkan` has since been re-measured with the device counter polled across each
completion — 0 MiB on 17 of 18 points and 5 MiB on one, so 6.3 MiB after the
margin — and the linux equivalent is pending: the first attempt came back with
a 94%-of-mean repeat spread and a 0.897 weight ratio while the CPU pass in the
same run was stable, so it was discarded, and the re-run is waiting on the
runner.

Two of the rows are worth reading twice.

`win32-x64 | vulkan, shared` fits a weight ratio of **2.04** where the same
host's device-resident row fits 1.02 and its CPU row 1.01. An integrated GPU
allocates out of system RAM, so a load holds the weights mapped _and_ copied
into the Vulkan buffers at once, and its held-out peak is 9.72 GiB where the
CPU coefficients would have predicted 5.9. That is why an integrated host gets
its own fixture rather than the platform's.

`darwin-x64` is the one platform whose working peak matters: a completion added
72–73 MiB there on Llama-3.2-1B, against 2–13 MiB everywhere else.

### Not covered, and what each needs

| Gap                    | What it needs                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| linux-x64 iGPU         | a host with integrated graphics; both linux runners have discrete NVIDIA cards. An AMD APU is additionally unplaceable — see below                                                                  |
| linux-arm64 iGPU       | more than a host — see below                                                                                                                                                                        |
| darwin-x64 GPU         | a real Intel Mac. `macos-15-large` is a VM whose Metal device reports as "Apple Paravirtual device" with `hasUnifiedMemory: false`, so calibrating it would describe a hypervisor rather than a GPU |
| win32-arm64            | an engine addon built for it; `@qvac/llm-llamacpp` ships nine prebuild targets and that is not one                                                                                                  |
| CUDA, ROCm, Level Zero | the addon does not build them — `prebuilds-llm-llamacpp.yml` enables the Vulkan SDK only                                                                                                            |
| Audio, every platform  | a whisper pass in the harness. `estimateWhisper` refuses the zeroed audio coefficients rather than consuming them                                                                                   |

### An AMD GPU on linux cannot be placed

libgpuinfo infers dedicated-vs-integrated on linux from amdgpu's
`mem_info_vram_total`, which an APU also exposes for its carve-out. A Ryzen
5000U laptop ("Lucienne") therefore reports `unifiedMemory: false` with over a
gigabyte of "VRAM", and is indistinguishable from a small discrete Radeon.
Vulkan calls the same device `INTEGRATED_GPU`, but that is not in the collector.

Placing it wrongly is worse than not placing it: the device basis would budget
against the carve-out and apply the RTX 4000's coefficients. So an AMD GPU on
linux assesses as `unknown` until the engine's own device type reaches JS —
`chooseBackend` already distinguishes `GGML_BACKEND_DEVICE_TYPE_IGPU`, so the
fix is to expose what it knows.

Classification is not the only blocker there. An `--igpu` pass on a Ryzen AI
MAX+ 395 (Radeon 8060S, RADV, 121 GiB) aborted on the KV tripwire with **0%**
observed growth: RSS read 122 / 206 / 305 MiB for the three fit models
regardless of size or context, because RADV puts the weights and the cache in
amdgpu's carve-out and GTT, which process RSS cannot see. The same load moved
the _system-wide_ used figure by 2008 MiB against an RSS delta of 493.

So the shared methodology is driver-dependent, and now measured on three:

| Driver              | `--igpu` outcome                               |
| ------------------- | ---------------------------------------------- |
| Intel UHD, win32    | works; host-visible allocations land in RSS    |
| RADV, linux         | invisible to RSS — needs a system-wide counter |
| NVIDIA Tegra, linux | the load itself fails (see below)              |

Calibrating an AMD APU therefore needs the shared pass to read system-wide used
memory rather than RSS. That is the counter the system basis is derived from
anyway, so it is the more principled choice — but it needs its own design pass:
which pages count, what to do about the page cache holding mapped weights (the
2008 MiB above is 67% of artifact plus cache, not all of it), and the noise
floor on a machine that is not idle.

### linux-arm64 on an integrated GPU: measured, and it does not load

Tried on a Jetson Orin Nano 8 GB. ggml sees the device correctly
(`NVIDIA Tegra Orin (nvgpu) | uma: 1`) and the collector classifies it as
integrated, but the load fails on the 0.6B warm-up model:

```
common_fit_params: failed to fit params to free device memory: n_gpu_layers already set by user to 99, abort
ggml_vulkan: Device memory allocation of size 313262080 failed.
```

Two separate things, both worth knowing before anyone measures this platform:

- The SDK pins `n_gpu_layers: 99`, so llama.cpp's own fit cannot reduce the
  layer count to what the device can hold, and the load hard-fails instead of
  degrading. That is a product-level issue on small unified-memory devices,
  independent of this feature.
- `vulkaninfo` reports the heap as 7.44 GiB (all of system RAM, `uma: 1`) but
  the **budget** as 1.09 GiB. So the system-memory basis would not bound a load
  here even if it succeeded, which is the assumption the `shared` placement
  rests on. It holds for Metal and for the Intel UHD measured above; it does
  not hold on Tegra. A `linux-arm64` shared fixture should not ship until the
  budget is readable from the collector.

Today the host assesses as `unknown` for want of a fixture, which is the right
answer for the wrong reason.

Adding a platform means: run the harness with `--write`, add the module to
`calibration/index.ts`, run prettier, and update the table above.
