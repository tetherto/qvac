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
| Whisper 30 s window       | Measured (`audioWindowBytes`)                              |
| Whisper streaming session | Measured (`audioStreamingBytes`)                           |

The KV cache is computed rather than measured because it is the term that varies
most between models, and the file describes it exactly — see `estimators/llm.ts`
for the per-layer accounting.

## Procedure

`scripts/calibrate-model-fit.ts` on the platform being calibrated (bare ≥ 1.30
runs it directly via type-stripping):

llama.cpp allocates **everything at load** — weights, KV cache, engine
overhead and the context-scaled compute buffers — so a load's RSS delta is the
whole cost and the delta during a completion is ~0. The first real runs on
Apple silicon confirmed this, which is why the fit reads persistent deltas
rather than working samples. The harness still samples RSS across one
completion per point and warns if that working delta grows past 64 MiB: that
would mean the engine's allocation behaviour changed and this methodology
needs re-checking.

On platforms where a GPU means discrete device memory (linux, windows,
darwin-x64) the harness loads with `device: 'cpu'`: RSS cannot observe VRAM,
so the coefficients describe CPU-resident execution — the case where system
RAM is the binding constraint. A second `--gpu` pass then measures the same
models resident on the device, against the GPU counter, and writes a fixture
keyed by backend; assessment uses those when a GPU is present and falls back
to `unknown` where it cannot identify the device or trust its readings.
It has to be the `device` key rather than `gpu_layers: 0`: the addon
derives its KV-cache default from the backend that key selects
(`LoadFitNormalization.cpp`, `isGpu`), so `gpu_layers: 0` on a host with a
Vulkan-capable GPU still builds a `q8_0` cache while every layer runs on the
CPU, and the `f16` subtracted for a CPU run would be twice what the engine
allocated. The first Windows run failed exactly that way (see "Windows").

1. For each of three models (small, medium, large) at two contexts (512 and
   8192 tokens), **three times each**: settle, read RSS, load, settle, read RSS
   again — the difference is **persistent**. Single-shot loads were observed to
   vary by up to ~100 MiB run to run, so every repeat enters the fit.
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
   upper bound that does not cover an observed point is not an upper bound.
5. **Held-out check.** A fourth model, excluded from the fit, is measured the
   same three times. `validated` is set only when its worst measured total
   lands at or below the predicted upper bound. A failing held-out check means
   the coefficients do not ship.

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

| Platform            | Coefficients                                         | Validated |
| ------------------- | ---------------------------------------------------- | --------- |
| darwin-arm64        | measured 2026-08-31 (Metal, Apple M4 Pro)            | yes       |
| linux-x64           | measured 2026-09-03 (CPU-forced, RTX 4000 SFF host)  | yes       |
| win32-x64           | measured 2026-09-03 (CPU-forced, RTX 4000 SFF host)  | yes       |
| linux-x64 \| vulkan | measured 2026-09-03 (GPU-resident, RTX 4000 SFF Ada) | yes       |

`darwin-arm64` was measured on an Apple M4 Pro against the Metal backend
(`q8_0` KV cache): held-out Qwen3-8B landed at 5.28 GiB against a predicted
upper of 5.34 GiB. `linux-x64` and `win32-x64` were measured on CI (run 33777205517) with the CPU backend forced and weights loaded anonymously;
held-out Qwen3-8B landed at 5.82 GiB against 5.82 predicted, and 5.84 against
5.94. Both hosts report a discrete GPU, so those coefficients serve CPU-only
machines on the same platform.

`linux-x64 | vulkan` is the first GPU-resident entry, measured on the same run
against the RTX 4000's own memory: held-out Qwen3-8B at 5.25 GiB against 5.67
predicted. It is keyed by backend because a platform can run several, and it
applies only where a single dedicated GPU is present — with more than one the
estimator cannot tell which card the engine will take, and returns `unknown`.
There is no `win32-x64` GPU entry: Windows reports per-process GPU memory
(DXGI `CurrentUsage` and `Budget`), which cannot bound a device. LLM workloads return real verdicts there; audio workloads
still return `unknown` because the harness has no whisper pass yet, and
`estimateWhisper` refuses the zeroed audio coefficients rather than consuming
them. Adding a platform means: run the harness with `--write`, add the module
to `calibration/index.ts`, run prettier, and update the table above.
