# Pre-download model fit assessment

`assessModelFit` answers one question before anything is downloaded: is this
model likely to fit in this device's memory? It reads generated catalog metadata
and a fresh system-memory sample. It never downloads weights, never loads a
model, and never runs a native probe.

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

Headroom left for the rest of the system: the larger of 2 GiB or 15% of total
RAM on desktop, the larger of 1 GiB or 20% on mobile.

```text
budget = total system RAM − RAM in use now − policy reserve

lower bound  > budget  → likely-too-large
upper bound <= budget  → likely-fits
otherwise              → unknown
```

Only system memory is used. GPU and VRAM metrics are `unverified`-scoped by
design and are deliberately excluded from the budget — see the
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
| Platforms | none validated yet — see the calibration status below                   |

Everything outside this table assesses as `unknown`. Parakeet, translation, TTS,
OCR, diffusion, and the vision projector (`mmproj-*`) half of a multimodal load
are phase 2.

**Calibration status.** A platform only reports estimates once its coefficients
have been measured on real hardware and a held-out model has validated inside
the bounds. No platform has cleared that yet, so `assessModelFit` currently
returns `unknown` everywhere; the machinery, the estimators and the harness are
in place. See
`@qvac/inference`'s `src/resources/model-fit/calibration/METHODOLOGY.md`.

## Relationship to `@qvac/model-fit`

`assessModelFit` is the zero-download tier: metadata only, available before a
single byte is fetched. `@qvac/model-fit` is the post-download tier — it reads
the real file and is the stronger evidence once you have it. They answer the
same question at different points in the lifecycle, and neither replaces the
other.
