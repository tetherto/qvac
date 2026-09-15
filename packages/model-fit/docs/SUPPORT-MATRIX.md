# Fit addon packaging and platform support matrix

QVAC-22889. What `@qvac/model-fit` costs to ship, where the disposable-process
fit boundary is proven to work, and the explicit `unknown` policy for every
target that cannot safely invoke the fitter. Figures measured against the
published `@qvac/model-fit@0.7.0`; CI evidence from the protocol-v2 PR
([#3930](https://github.com/tetherto/qvac/pull/3930)) at its final head.

## Support matrix

"Process fit" is the production path: one disposable Bare child per fit,
spawned by the consumer's supervisor, speaking the versioned stdio protocol.
"In-process fit" is `fitParams()` called directly, which shares the caller's
process with any native fault.

| Target | Prebuild ships | Process fit | In-process fit | Advisory verdict |
|---|---|---|---|---|
| macOS arm64 (Node or Bare parent) | yes | **supported** | possible, not recommended¹ | produced |
| macOS x64 | yes | **supported** | possible, not recommended¹ | produced |
| Linux x64 (glibc) | yes | **supported** | possible, not recommended¹ | produced |
| Linux arm64 | yes | **supported** | possible, not recommended¹ | produced |
| Windows x64 | yes | **supported** (overlapped stdio²) | possible, not recommended¹ | produced |
| Android (arm64 + copies) | yes | **refused** — no disposable child | **refused** by the native layer³ | `unknown`, no child spawned |
| iOS / iOS simulator | yes | **refused** — no disposable child | **refused** by the native layer³ | `unknown`, no child spawned |
| Browser | n/a | **refused** | n/a | `unknown`, no child spawned |

1. A native trap inside the fitter (see the abort-containment section of the
   README) takes the calling process down. The process boundary exists so that
   this can never be the app; in-process calls are for tooling that accepts
   the risk.
2. Bare children on Windows require `overlapped` stdio pipes or they never see
   the request; both the supervisor and the test harness set this.
3. `normalizeLlamaLoadConfig` returns `unsupported-config` on mobile builds
   before touching the fitter, independently of the process refusal: a Bare
   worklet shares the app process and is not a crash-isolation boundary, so
   mobile must not invoke the fitter at all until that changes.

## The `unknown` policy

An advisory consumer (the QVAC-22629 integration) maps every one of these to
`unknown` and continues the ordinary load path unchanged:

- mobile / browser targets (no child is ever spawned);
- sharded, multimodal-projection, LoRA, and non-llama.cpp loads (refused
  before spawning);
- a load config carrying a key the consumer cannot classify (refused before
  spawning, so an unclassified memory-relevant key can never be silently
  dropped into a wrong verdict);
- `unsupported-config`, `model-unreadable`, `no-backend-device` from the
  fitter;
- crash, signal, timeout, cancellation, malformed or oversized child output,
  spawn failure, and any internal error in the supervisor.

`unknown` is the absence of evidence, never a denial. Nothing in this package
or its consumers blocks a load until the QVAC-22634 gates are met.

## Disposable-process evidence

The desktop integration matrix runs `npm run test:integration`, which includes
the full disposable-runner protocol suite (`test:process`: real spawned
children, request/response framing, byte caps, crash and hang handling) plus
real-GGUF fitting. All seven runners passed at the protocol-v2 head
([run 32566738048](https://github.com/tetherto/qvac/actions/runs/32566738048)):

| Runner | Job |
|---|---|
| darwin-arm64 | [97016669059](https://github.com/tetherto/qvac/actions/runs/32566738048/job/97016669059) |
| darwin-x64 | [97016669024](https://github.com/tetherto/qvac/actions/runs/32566738048/job/97016669024) |
| linux-x64 (22.04) | [97016669019](https://github.com/tetherto/qvac/actions/runs/32566738048/job/97016669019) |
| linux-x64 (24.04) | [97016669057](https://github.com/tetherto/qvac/actions/runs/32566738048/job/97016669057) |
| linux-arm64 (22.04) | [97016669006](https://github.com/tetherto/qvac/actions/runs/32566738048/job/97016669006) |
| linux-arm64 (24.04) | [97016669016](https://github.com/tetherto/qvac/actions/runs/32566738048/job/97016669016) |
| win32-x64 | [97016669031](https://github.com/tetherto/qvac/actions/runs/32566738048/job/97016669031) |

Supervisor-side (consumer) coverage: the QVAC-22629 engine suite drives real
disposable children through the actual `bare` spawn path on macOS (valid
response, abnormal exit, hang/timeout, kill-by-signal), plus a
hardware-validated end-to-end run recorded in the epic's evidence document.

## Size impact (`@qvac/model-fit@0.7.0`, published)

The npm archive carries every platform; an installed app ships only its own
platform's prebuild, so the per-target rows are what reach users.

| Artifact | Size |
|---|---|
| npm package, unpacked (all platforms) | 497 MiB (59 files) |
| JS layer (wrapper, codec, process runner) | < 0.2 MiB |
| **Per-target ship size** | |
| darwin-arm64 (`.bare` + exports) | **10.5 MiB** |
| darwin-x64 | **11.6 MiB** |
| ios-arm64 / simulators | **10.3 – 11.2 MiB** each |
| linux-x64 (`.bare` 10.4 MiB + dynamic ggml backends 123 MiB) | **133 MiB** |
| linux-arm64 | **109 MiB** |
| win32-x64 | **90 MiB** |
| android-arm64 | **111 MiB** |

Reading the split: Apple targets statically embed Metal, so the addon is a
single ~10 MiB binary. Linux, Windows and Android ship dynamic ggml backend
libraries beside the addon (on linux-x64: fourteen per-microarchitecture CPU
variants plus Vulkan), which is where the other ~100 MiB lives. This is the
same packaging model as the inference addons — but note the backends are
per-addon copies, so an app shipping both `@qvac/llm-llamacpp` and
`@qvac/model-fit` carries two sets.

The disposable child adds no steady-state footprint: one process per fit,
gone when the verdict returns (fits complete in ~0.4–0.5 s on an M4 Pro,
measured in the QVAC-22629 evidence run).

## Remaining gaps

- **On-device final-app deltas.** The per-target rows above are the installed
  prebuild sizes; actual .apk/.ipa/packaged-Electron deltas depend on each
  app's compression and should be measured in the consuming app's pipeline.
  (Mobile ships the prebuild today despite the fit being refused there —
  dropping it from mobile bundles is a possible follow-up saving of
  ~10–111 MiB per platform.)
- **Mobile process proof is intentionally absent**: the target is refused by
  policy, not untested by accident. Revisiting requires a real out-of-process
  boundary on Android/iOS first.
