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
darwin-x64) the harness loads with `gpu_layers: 0`: RSS cannot observe VRAM,
so the coefficients describe CPU-resident execution — the case where system
RAM is the binding constraint. Assessment on such platforms returns `unknown`
whenever a GPU is present; GPU-memory admission is out of scope for this
phase.

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

### Counter tripwire

Before fitting anything, the harness checks that the counter it read describes
allocation at all. The KV cache is the one term the file sizes exactly, so
between the two contexts every model's persistent delta must grow by at least
the computed KV growth — the per-token compute buffers can only add to it.
`kvObservation` (`calibration/fit.ts`, unit tested) sums that growth across
the fit models and the run stops when the counter saw less than 90% of it.
Summed rather than per model so a small model's growth, which sits inside
run-to-run noise, does not decide alone, and repeats enter as their median so
the cold page-cache transient on the run's first load (which lands on the
small context) does not read as a shortfall. darwin-arm64 sits at ~1.0.

### Windows

`memoryUsage().rss` is libuv's `uv_resident_set_memory`, which on win32 returns
`GetProcessMemoryInfo().WorkingSetSize`: the pages the OS is _currently_
keeping resident for the process. Windows trims working sets while the memory
stays allocated — pages move to the standby list or the compression store —
and it does so to anonymous memory too. The first CPU-forced CI run made that
concrete: a 2.4 GiB model read as 71–128 MiB persistent at 512 tokens, and at
8192 tokens the exactly computed 1152 MiB f16 KV cache alone read as ~717 MiB.
Over the three fit models the working set observed 56% of the KV growth
between the two contexts, so the tripwire above stops the run. macOS and Linux
RSS count touched pages and hold once a load settles; the Windows counter does
not describe allocation, so no delta read from it can be an upper bound.

The sound counter there is the commit charge —
`PROCESS_MEMORY_COUNTERS_EX.PrivateUsage`, "Private Bytes" in perfmon, "Commit
size" in Task Manager: committed private memory regardless of residency. It
covers the KV cache and compute buffers exactly but never file-backed
mappings, so under the mmap default the weights would be invisible to it. The
harness therefore pairs it with `load_mode: 'none'`, which reads the weights
into anonymous memory. A fixture measured that way is still an upper bound for
the default mmap load — a mapped weight set can keep at most the artifact size
resident, and the ratio measured on an anonymous copy is ≥ 1.0 — and the
fixture says so in `notes`.

`bare-os` does not expose the commit charge yet: `bare_os_memory_usage` in its
`binding.c` reads only `uv_resident_set_memory` plus the JS heap statistics.
The required change is a win32-only `GetProcessMemoryInfo` call with a
`PROCESS_MEMORY_COUNTERS_EX`, surfacing `PrivateUsage` as
`memoryUsage().committed` (absent on other platforms). Until then the harness
stops on win32 before loading anything, with the reason in its message; it
does not fall back to the working set.

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

| Platform     | Coefficients                                               | Validated |
| ------------ | ---------------------------------------------------------- | --------- |
| darwin-arm64 | measured 2026-08-31 (Metal, Apple M4 Pro)                  | yes       |
| win32-x64    | blocked: needs `bare-os` `memoryUsage().committed` (above) | no        |

`darwin-arm64` was measured on an Apple M4 Pro against the Metal backend
(`q8_0` KV cache): held-out Qwen3-8B landed at 5.28 GiB against a predicted
upper of 5.34 GiB. LLM workloads return real verdicts there; audio workloads
still return `unknown` because the harness has no whisper pass yet, and
`estimateWhisper` refuses the zeroed audio coefficients rather than consuming
them. Adding a platform means: run the harness with `--write`, add the module
to `calibration/index.ts`, run prettier, and update the table above.
