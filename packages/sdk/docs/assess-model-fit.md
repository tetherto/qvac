# Pre-download model fit assessment

`assessModelFit` answers one question before anything is downloaded: is this
model likely to fit in this device's memory? It reads generated catalog metadata
and a fresh memory sample — system-wide or process-scoped, depending on the
result's [`basis`](#policy-interactive-v1). It never downloads weights, never
loads a model, and never runs a native probe.

It is **advisory**. It does not block `loadModel`, reserve memory, choose a
model for you, or make any claim about speed.

## Three verdicts

| Verdict            | Meaning                                                   |
| ------------------ | --------------------------------------------------------- |
| `likely-fits`      | The conservative upper bound is within the memory budget. |
| `likely-too-large` | Even the optimistic lower bound exceeds the budget.       |
| `unknown`          | The evidence does not support either claim.               |

`unknown` is a real answer, not an error. Show it as "can't say" — never as "no".
It is what you get when the catalog has no GGUF metadata for a model, when the
platform has no validated calibration, when memory metrics are unsupported, or
when a requested engine has no estimator yet. If any one model in a call is
`unknown`, the combined verdict is `unknown`; each model still reports its own.

## Usage

```typescript
import { assessModelFit, QWEN3_8B_INST_Q4_K_M, WHISPER_EN_SMALL_Q8_0 } from '@qvac/sdk'

const result = await assessModelFit({
  models: [
    { model: QWEN3_8B_INST_Q4_K_M, workload: { kind: 'llm', contextTokens: 8192 } },
    { model: WHISPER_EN_SMALL_Q8_0, workload: { kind: 'audio', windowMs: 30_000, streaming: true } }
  ],
  execution: 'sequential',
  policy: 'interactive-v1'
})

if (result.verdict === 'likely-too-large') {
  // offer a smaller model, or a smaller context
}

for (const model of result.models) {
  console.log(model.name, model.verdict, model.reasons)
}
```

### `execution` is a declared assumption

`sequential` counts every model as resident but adds only the largest single
working peak; `concurrent` adds every peak. It describes what you intend to do
so the numbers match your plan — the SDK does not schedule, serialize, or
reserve anything on the strength of it.

### `policy: 'interactive-v1'`

Headroom withheld from the budget: 20% of the memory available right now,
capped at 2 GiB on desktop and 1 GiB on mobile. It is a share of what is free,
not of `total`, so it can never exceed the headroom it is carved from — a busy
host with 3 GiB free keeps a 2.4 GiB budget rather than none. Under
`system-memory` that headroom is left for the rest of the system; under
`process-memory` it is left inside the app's own ceiling, since jetsam acts on
this app's footprint.

```text
available = total − in use now
budget    = available − min(cap, 20% × available)

lower bound  > budget  → likely-too-large
upper bound <= budget  → likely-fits
otherwise              → unknown
```

The result's `budget` carries every term — `totalBytes`, `usedBytes`,
`availableBytes`, `reservedBytes`, `availableAfterReserveBytes` — so a verdict
can be read back to the numbers it came from.

What "total" and "in use" mean depends on the result's `basis`:

- **`system-memory`** — device RAM and system-wide use. Desktop, and Android
  by explicit decision: its low-memory killer acts system-wide, and native
  allocations carry no per-process cap.
- **`process-memory`** — the app's own ceiling. iOS jetsam terminates an app
  on its per-process footprint against a limit well below device RAM, so a
  system budget there would defend verdicts the OS does not honor. The budget
  comes from `os_proc_available_memory()` plus the current footprint; until
  that per-process metric is available on a build, iOS assessments return
  `unknown` rather than a confidently wrong `likely-fits`.

- **`device-memory`** — a discrete GPU's own memory, used when the model will
  execute there. Only for a GPU whose readings the collector established are
  device-scoped; everything else keeps the system basis or returns `unknown`.
  See [desktops with a GPU](#supported-surface) below and the
  [system resources support matrix](./system-resources-support-matrix.md).

## Why the estimate is a range

Two things are genuinely undetermined before a load, so the result is bounds
rather than a number:

- **The KV-cache type.** On a Metal or Vulkan GPU backend with flash attention
  on — the SDK's defaults — `llm-llamacpp` defaults the cache to `q8_0`; on CPU
  and OpenCL it stays `f16`. The lower bound assumes the cheaper case, the upper
  bound the dearer one. If you pass an explicit `cache-type-k`/`cache-type-v` in
  `modelConfig`, the assessment does not know, and its assumptions say so.
- **Which blocks hold a cache.** Models that describe attention per block (for
  example `gemma4`) are summed exactly, with sliding-window blocks capped at
  their window. Models that declare a window without a per-block pattern (for
  example `gpt-oss`) get a deliberately wide bound, because the pattern lives in
  the engine, not the file. Hybrid attention/recurrent models (for example
  `qwen35`) are sized for their full-attention blocks plus a fixed recurrent
  state.

A context above the model's trained window is clamped to it, and that clamp is
reported in `assumptions`.

## Supported surface

|           | Phase 1                                                                 |
| --------- | ----------------------------------------------------------------------- |
| Engines   | `llamacpp-completion`, `llamacpp-embedding`, `whispercpp-transcription` |
| Workloads | `llm`, `audio`                                                          |
| Platforms | every desktop except `win32-arm64` — see the calibration status below   |

Everything outside this table assesses as `unknown`. Parakeet, translation, TTS,
OCR, diffusion, and the vision projector (`mmproj-*`) half of a multimodal load
are phase 2.

**Calibration status.** A platform only reports estimates once its coefficients
have been measured on real hardware and a held-out model has validated inside
the bounds. Where a GPU would run the model, the fixture has to be one measured
on that placement too — the CPU numbers do not describe a GPU load. The table
below is what that gives today for LLM workloads (`llamacpp-completion`,
`llamacpp-embedding`). "Verdicts" means `likely-fits` / `likely-too-large` are
possible; everything else is `unknown`, and the result's `reasons` say which
row you landed in.

| Platform        | No usable GPU reported                                                         | Integrated GPU                                      | Discrete GPU                                                          |
| --------------- | ------------------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------- |
| `darwin-arm64`  | verdicts                                                                       | verdicts (unified memory, one fixture)              | —                                                                     |
| `darwin-x64`    | verdicts                                                                       | `unknown` — no GPU fixture                          | `unknown` — no GPU fixture                                            |
| `linux-x64`     | verdicts                                                                       | `unknown` — no fixture; an AMD APU cannot be placed | verdicts on Vulkan (`device-memory`); AMD cards `unknown` — see below |
| `linux-arm64`   | verdicts                                                                       | `unknown` — no fixture                              | `unknown` — no fixture                                                |
| `win32-x64`     | verdicts                                                                       | verdicts on Vulkan (Intel UHD measured)             | verdicts on Vulkan (`device-budget`)                                  |
| `win32-arm64`   | `unknown` — no engine addon is built for it                                    |                                                     |                                                                       |
| `android-arm64` | `unknown` — no fixture yet; budget and reserve are in place                    |                                                     |                                                                       |
| `ios-arm64`     | `unknown` — the per-process memory metric is not available yet, and no fixture |                                                     |                                                                       |

Two rows deserve a plain-language reading. Every real Intel Mac reports a GPU,
so `darwin-x64` returns verdicts only on hosts where the collector sees none
(virtual machines, whose paravirtual adapter is discounted). And a discrete GPU
only gets verdicts through the Vulkan backend, because that is the only GPU
backend `@qvac/llm-llamacpp` ships; a card reachable through another API alone
is `unknown`.

Audio workloads (`whispercpp-transcription`) return `unknown` on every platform:
their coefficients await the harness's whisper pass, and the estimator refuses
the unmeasured placeholders rather than consuming them. Every other engine
returns `unknown` because it has no estimator yet.

The per-platform numbers, the held-out results and the gaps still open are in
`@qvac/inference`'s `src/resources/model-fit/calibration/METHODOLOGY.md`.

**Desktops with a GPU.** On linux, Windows and Intel macOS the platform's own
coefficients describe CPU-resident execution, so when a GPU is present the
assessment first works out where the model would actually go. Devices the
engine cannot use are discounted: a VM's paravirtual display adapter, and any
device with no graphics API the build talks to. What remains decides the basis.

- **A card with its own memory** → `device-memory`, the backend's own
  coefficients, and the GPU's total, used and reserve in `budget` as usual.
  Where several cards qualify, they are alternatives rather than one pool: the
  engine pins the model to one and which one is not observable, so a
  `likely-fits` has to hold on the smallest and a `likely-too-large` on the
  largest. In between the answer is `unknown`. Adapters too small to hold any
  model are not counted as rivals — Windows classifies an Intel iGPU as
  dedicated because it declares 128 MiB of its own.
- **Only integrated GPUs** → the model runs on the GPU, but an integrated
  device allocates out of system RAM, so the basis stays `system-memory`. The
  coefficients are still the backend's, measured on an integrated device;
  without such a fixture for that platform and backend the result is `unknown`
  rather than the platform's CPU-forced numbers, which do not describe a GPU
  load.

On Windows a card's readings are per-process rather than device-wide (DXGI
`CurrentUsage` and `Budget`), so the basis is `device-budget` instead: the GPU
memory the OS grants _this process_. It answers the same admission question.

Both device bases additionally require the **system-memory** budget to hold, on
every verdict — a GPU load is paid for in system RAM too (a 2382 MiB model
raised RSS by 2918 MiB on Windows, 868 MiB on linux), so a machine with the
card for it but not the RAM does not read as a fit.

It returns `unknown` whenever the evidence is not defensible: **an uncalibrated
backend** for the placement in play, a GPU whose readings carry no usable
scope, or cards that disagree on the backend or on the scope of their readings.

Apple silicon is unaffected: its memory is unified, so a GPU allocation is
system RAM and the system basis already covers it.

**AMD GPUs on linux** are `unknown` whether integrated or discrete. The
collector infers dedicated-versus-integrated from the driver's reported VRAM,
and an APU exposes its carve-out the same way a small discrete card exposes its
memory, so the two cannot be told apart from JS. Placing the model wrongly would
budget against the wrong memory with the wrong coefficients, so the assessment
declines instead.

### Mobile

Both mobile platforms are unified memory, so no GPU placement is involved; the
budget is the whole story.

- **`android-arm64`** uses the `system-memory` basis by explicit decision (its
  low-memory killer acts system-wide), and applies the mobile reserve. What is
  missing is the calibration fixture: the harness has not yet run on a device.
  Until it has, every Android assessment is `unknown` with the reason
  `no validated calibration for android-arm64`.
- **`ios-arm64`** uses the `process-memory` basis, because jetsam terminates an
  app on its own footprint against a limit well below device RAM. That budget
  needs `sample.memory.processAvailableBytes`, which no build supplies yet, so
  iOS returns `unknown` before any calibration is consulted. A fixture alone
  will not change that; the per-process metric has to exist first.

## Why a result is `unknown`

Every `unknown` names its cause in `reasons` — on the model when it is about
that model, on the result when it is about the machine. The strings below are
the ones the current release emits, grouped by what you can do about them.

| Reason (abridged)                                                                             | Cause                                                                            | What helps                                                                        |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `no validated calibration for <platform>`                                                     | The platform has no measured fixture (Android, `win32-arm64`).                   | Nothing on the caller's side; a fixture has to land.                              |
| `no validated calibration for <platform> on <backend>`                                        | A discrete GPU would run the model and no fixture describes that placement.      | Same. Today only `linux-x64` and `win32-x64` on Vulkan are covered.               |
| `no validated calibration for <platform> on an integrated <backend> GPU`                      | An integrated GPU would run the model and no fixture describes it.               | Same. Today only `win32-x64` on Vulkan is covered.                                |
| `a GPU is reported but its readings cannot say where the model would execute`                 | The GPU cannot be placed (an AMD GPU on linux; readings with no usable scope).   | None yet; needs the engine's own device type exposed to JS.                       |
| `the runtime platform is not one this assessment covers`                                      | Running somewhere outside the eight platforms the SDK knows.                     | None.                                                                             |
| `iOS budgets are per-process … the per-process allowance metric is not available`             | `processAvailableBytes` is `unavailable` on this build.                          | Needs a native source for `os_proc_available_memory()`.                           |
| `system-memory metrics are not supported on this platform` / `no memory sample was available` | The collector could not produce `sample.memory.{total,used}Bytes`.               | Check `getSystemResources({ sample: true })` on the host; see the support matrix. |
| `no resource profile in the catalog for this checksum`                                        | The model is not a generated catalog constant (a local file, a custom source).   | Only catalog constants can be assessed before download.                           |
| `no GGUF metadata for this model in the catalog, so the KV cache cannot be sized`             | The registry could not extract the header for this entry (some GGUF v3 files).   | None on the caller's side; the catalog entry has no transformer facts.            |
| `engine '<engine>' has no estimator in this phase`                                            | Parakeet, translation, TTS, OCR, diffusion, the `mmproj-*` projector, and so on. | Phase 2.                                                                          |
| `the audio window coefficient for this platform has not been measured`                        | Any `audio` workload, on any platform.                                           | Awaits the whisper calibration pass.                                              |
| `workload kind '<kind>' is not supported by <estimator>`                                      | An `llm` workload on a whisper model, or an `audio` workload on an LLM.          | Match the workload kind to the model's engine.                                    |
| `an entry in artifacts has no resource profile in the catalog`                                | A companion constant in `artifacts` is not in the generated catalog.             | Pass catalog constants only.                                                      |

Two more `unknown`s carry no dedicated reason because they are the verdict rule
working as designed: the estimate's bounds straddle the budget (lower bound
under it, upper bound over it), and, with several discrete GPUs, a fit that
holds on the largest card but not the smallest. In both cases the `estimate`
and `budget` fields are present, so the caller can see how close it was.

## Relationship to `@qvac/model-fit`

`assessModelFit` is the zero-download tier: metadata only, available before a
single byte is fetched. `@qvac/model-fit` is the post-download tier — it reads
the real file and is the stronger evidence once you have it. They answer the
same question at different points in the lifecycle, and neither replaces the
other.
