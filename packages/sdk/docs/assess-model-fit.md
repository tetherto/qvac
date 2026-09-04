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

Headroom withheld from the budget: the larger of 2 GiB or 15% of `total` on
desktop, the larger of 1 GiB or 20% on mobile — the percentage applies to
whatever `total` means under the result's `basis`. Under `system-memory` that
headroom is left for the rest of the system; under `process-memory` it is left
inside the app's own ceiling, since jetsam acts on this app's footprint.

```text
budget = total − in use now − policy reserve

lower bound  > budget  → likely-too-large
upper bound <= budget  → likely-fits
otherwise              → unknown
```

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
  See [discrete-GPU desktops](#supported-surface) below and the
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

|           | Phase 1                                                                     |
| --------- | --------------------------------------------------------------------------- |
| Engines   | `llamacpp-completion`, `llamacpp-embedding`, `whispercpp-transcription`     |
| Workloads | `llm`, `audio`                                                              |
| Platforms | `darwin-arm64`, `linux-x64`, `win32-x64` — see the calibration status below |

Everything outside this table assesses as `unknown`. Parakeet, translation, TTS,
OCR, diffusion, and the vision projector (`mmproj-*`) half of a multimodal load
are phase 2.

**Calibration status.** A platform only reports estimates once its coefficients
have been measured on real hardware and a held-out model has validated inside
the bounds. `darwin-arm64` (Apple M4 Pro, Metal), `linux-x64` and `win32-x64`
have all cleared that for CPU-resident execution, and `linux-x64` on Vulkan has
cleared it for GPU-resident execution too, so LLM workloads return real
verdicts on those. Audio
workloads still return `unknown` on every platform: their coefficients await
the harness's whisper pass, and the estimator refuses the unmeasured
placeholders rather than consuming them. Every other platform returns `unknown`
until its own run lands. See
`@qvac/inference`'s `src/resources/model-fit/calibration/METHODOLOGY.md`.

**Discrete-GPU desktops.** The engine executes the model in the GPU's own
memory there, which system RAM cannot bound, so those platforms' `platforms`
fixtures describe CPU-only machines. When a GPU is present the assessment
switches to a `device-memory` basis and the backend's own coefficients — today
`linux-x64` on Vulkan — and reports the GPU's total, used and reserve in
`budget` as usual.

On Windows the readings are per-process rather than device-wide (DXGI
`CurrentUsage` and `Budget`), so the basis is `device-budget` instead: the GPU
memory the OS grants _this process_. It answers the same admission question.

Both device bases additionally require the **system-memory** budget to hold, on
every verdict — a GPU load is paid for in system RAM too (a 2382 MiB model
raised RSS by 2918 MiB on Windows, 868 MiB on linux), so a machine with the
card for it but not the RAM does not read as a fit.

It returns `unknown` instead whenever the evidence is not defensible:

- **More than one usable GPU.** The engine takes the first eligible ggml
  device, an order the SDK cannot observe, so the card cannot be identified.
  Adapters too small to hold any model are not counted as rivals — Windows
  classifies an Intel iGPU as dedicated because it declares 128 MiB of its own.
- **An uncalibrated backend**, or a GPU whose readings carry no usable scope.

Apple silicon is unaffected: its memory is unified, so a GPU allocation is
system RAM and the system basis already covers it.

## Relationship to `@qvac/model-fit`

`assessModelFit` is the zero-download tier: metadata only, available before a
single byte is fetched. `@qvac/model-fit` is the post-download tier — it reads
the real file and is the stronger evidence once you have it. They answer the
same question at different points in the lifecycle, and neither replaces the
other.
