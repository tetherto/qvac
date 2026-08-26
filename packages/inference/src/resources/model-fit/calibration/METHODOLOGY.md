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

`scripts/calibrate-model-fit.mjs` on the platform being calibrated:

1. For each of three models (small, medium, large) at two contexts (512 and
   8192 tokens): settle, read RSS, load, settle, read RSS again — the difference
   is **persistent**. Then sample RSS every 25 ms across one completion; the peak
   minus the post-load reading is **working**.
2. `weightUpperCoeff` is the worst `persistent / artifactBytes` ratio observed,
   floored at 1.0.
3. Subtract the KV cache from each working measurement — the cache the engine
   _actually allocated_, taken from the estimator's own `kvElementBytes` rather
   than assumed. On a Metal or Vulkan backend the default is `q8_0`, so a fixed
   `f16` assumption over-subtracts by nearly 2×; because that error scales with
   context it lands in the per-token slope rather than the intercept, corrupting
   the one coefficient step 3 exists to isolate. What remains is a residual that
   should be linear in context, so a least-squares fit over all six points
   separates `fixedOverheadBytes` from `computeBufferBytesPerToken`. Two contexts
   per model is the minimum that can tell those apart. A negative residual means
   the subtracted cache was larger than the memory measured — the harness stops
   rather than fitting nonsense, since the fit floors its output at zero and
   would otherwise emit a plausible-looking `{ lower: 0, upper: 0 }`.
4. Bounds are set at ±20% of the fit, with the upper bound additionally floored
   at the worst residual seen — an upper bound that does not cover an observed
   point is not an upper bound.
5. **Held-out check.** A fourth model, excluded from the fit, is measured the
   same way. `validated` is set only when its measured total lands at or below
   the predicted upper bound. A failing held-out check means the coefficients do
   not ship.

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

| Platform     | Coefficients           | Validated |
| ------------ | ---------------------- | --------- |
| darwin-arm64 | placeholder shape only | no        |

`darwin-arm64` currently ships an unvalidated placeholder, so every assessment
on it returns `unknown`. Run the harness on Apple silicon to replace it. Adding
a platform means: run the harness with `--write`, add the module to
`calibration/index.ts`, run prettier, and update the table above.
