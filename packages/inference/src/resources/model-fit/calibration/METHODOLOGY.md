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

| Platform     | Coefficients                              | Validated |
| ------------ | ----------------------------------------- | --------- |
| darwin-arm64 | measured 2026-08-31 (Metal, Apple M4 Pro) | yes       |

`darwin-arm64` was measured on an Apple M4 Pro against the Metal backend
(`q8_0` KV cache): held-out Qwen3-8B landed at 5.28 GiB against a predicted
upper of 5.34 GiB. LLM workloads return real verdicts there; audio workloads
still return `unknown` because the harness has no whisper pass yet, and
`estimateWhisper` refuses the zeroed audio coefficients rather than consuming
them. Adding a platform means: run the harness with `--write`, add the module
to `calibration/index.ts`, run prettier, and update the table above.
