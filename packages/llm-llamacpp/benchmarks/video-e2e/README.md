# Video input latency study (QVAC-23856)

This is an opt-in research harness, not the production video API. It feeds sampled
frames as **independent images in one turn**. It does not measure Qwen's native
temporal pairing. It does not change fabric or the addon implementation.

## Work measured

- Three SHA-256-pinned videos: 10-second 720p animation, 18-second 1080p iPhone
  HEVC/HDR footage, and the first 60 seconds of a 3840x1644 Xperia HEVC/HDR clip.
- Full software decoding versus FFmpeg `skip_frame=nokey`. Both retain at most
  32 images, at up to one image per second, downscaled to a 448-pixel longest side.
- Qwen3.5-0.8B Q8 and Gemma4-E2B Q4_K_M, with their pinned projectors from the
  existing integration model manifest; 8192 context and up to 48 output tokens.
- A controlled 1/2/4/8/16/32-image sweep using identical pixels, extra text with
  eight images, and a one-second / 30-image all-frame stress test.

All constants and source URLs live in `video-config.cjs`. The Xperia filename
says 120 fps, but the measured playback timestamps are approximately 24 fps.
The test follows presentation timestamps, not the filename.

## Timing rules and limitations

Downloads and model loading are recorded separately. `e2eMs` covers extraction
through the completed answer with the model already loaded. A model-load-plus-
request estimate is explicitly marked as an estimate, not a measured cold start.
Only one one-image warmup runs; first-use GPU shader compilation for larger shapes
can still appear in later cells. These are single-run observations, not medians.

The addon records wall-clock time to the first nonempty output, completion time,
and its native vision / token counters. Native TTFT is **not** an exclusive
text-prefill timer: do not add it to vision time as independent stages.
Remaining generation wall time is completion minus first-output time.

Frames are RGB8 PNM buffers. This isolates the model from JPEG quality and encode
cost. There is no audio processing, scene detection, tone mapping, native video
pairing, or production cancellation API. HDR-to-RGB conversion is a performance
baseline, not a validated HDR color pipeline. Key-frame sampling can miss actions.
HEVC key-only warnings on the Xperia sample must be reported alongside results.
The 32-frame budget bounds retained pixels, not decoder or model peak memory.

Desktop CLI results use an explicitly recorded upstream build and GPU device.
Phone results use the existing QVAC in-app harness. The addon prefixes all images
before the text timestamp index; the CLI helper interleaves timestamps and image
markers. Therefore cross-engine comparisons are descriptive, not isolated
hardware comparisons. A Windows run of the phone helper is the closer control.

## Running locally

Use Bare and the package's existing native dependencies, plus `bare-ffmpeg@1.5.0`
and `bare-https@3.1.0`. `core-selftest.cjs` downloads the small reference clip and
tests checksums, delayed-frame flushing, scaling, sparse keys and the burst.

From the addon directory:

```text
bare benchmarks/video-e2e/core-selftest.cjs
node benchmarks/video-e2e/stage.cjs
bare test/integration/video-e2e.test.js
```

Staging copies the benchmark into the existing mobile test framework and updates
generated test/model lists and temporary dependencies. Do not commit those
generated copies. Run the project's mobile list/manifest validators after staging.
`extract-desktop.cjs` and `run-cli.cjs` support the separate desktop CLI matrix.

## Cost-bounded mobile CI

Dispatch the **existing** `benchmark-vlm-model-comparison.yml` workflow on the
research branch with `video_e2e=true`. The ordinary image benchmark is not run.
The wrapper selects exactly one Samsung Galaxy S25 Ultra and one Apple iPhone
16 Pro, with exact model matching and `maxDevices: 1` in the shared scheduler.
It submits one filtered test per platform, sequentially, with no automatic retry.
Each paid device run has a 30-minute hard ceiling; the test has a 20-minute ceiling
and its external Mocha wrapper has a 21-minute margin. The wrapper's timeout
rewriter rejects a no-op 20-to-20 override, so setting that override to 20 fails
before Device Farm is scheduled.
Model pre-staging reuses the existing pinned US object-store cache. Videos download
directly to the phone from their original public URLs, once per phone; the app
does not bundle or repeatedly transfer the video corpus.

The pinned addon is `@tetherto/llm-llamacpp-mono@0.51.0-tmp.runid-34220546522`,
from [the successful main build](https://github.com/tetherto/qvac/actions/runs/34220546522),
using fabric 10297.1.2. The older npm 0.50.0 / fabric 10297.1.1 crashes on the
Qwen multi-image control and is not an acceptable benchmark baseline.
No native rebuild or additional model family is requested by the mobile workflow.

Results are emitted as JSON lines prefixed `[VIDEO-E2E]` in the collected
`bare_console.log` / Device Farm customer artifacts. Require the final `done`
record and the test assertions; a green app build alone is not benchmark success.

Qwen3.6 Registry weights start at 27B and are excluded from this two-phone matrix
on memory grounds. Any desktop-only 3.6 test must be reported separately; do not
substitute Qwen3.5 timings for Qwen3.6 or describe it as phone-tested.
