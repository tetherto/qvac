# Pre-download model fit assessment

`assessModelFit` answers one question before anything is downloaded: is this
model likely to fit in this device's memory? For every candidate it runs the
engine's own fitter — against the artifact where it is already on disk, and
otherwise against the registry's weightless description of it, tens of KB, the
tensor list and the settings with no data section. It also reads generated
catalog metadata and a fresh memory sample, system-wide or process-scoped
depending on the result's [`basis`](#policy-interactive-v1). It never downloads
weights and never loads a model.

It is **advisory**. It does not block `loadModel`, reserve memory, choose a
model for you, or make any claim about speed.

## Three verdicts

| Verdict            | Meaning                                                 |
| ------------------ | ------------------------------------------------------- |
| `likely-fits`      | The measured demand is within the memory budget.        |
| `likely-too-large` | The demand exceeds the budget, or an engine refused it. |
| `unknown`          | The evidence does not support either claim.             |

`unknown` is a real answer, not an error. Show it as "can't say" — never as "no".
It is what you get when the catalog has no profile for a model, when memory
metrics are unsupported, and whenever the only evidence is a
[computed floor](#two-kinds-of-evidence) that the model does not exceed. If any
one model in a call is `unknown`, the combined verdict is `unknown`; each model
still reports its own.

## Two kinds of evidence

Every verdict says what it rests on, in `evidence` — on the result and on each
model:

| `evidence`      | What it is                                                                                                          | Can say                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `native-fit`    | The engine's own fitter, run against the artifact on disk, or against the registry's weightless description of it.  | any verdict                     |
| `computed-only` | A floor from catalog facts alone: artifact bytes, plus the KV cache for llama.cpp models. Reported as `floorBytes`. | `likely-too-large` or `unknown` |

`native-fit` is the answer the loader itself would give on this machine, so it
is what a verdict rests on wherever the fitter reaches one. The fitter reports
the bytes it would allocate, split into weights, context and compute, and those
bytes compose: each candidate is measured against the whole machine on its own,
and the set is summed under one budget according to `execution`.

A refusal from the engine stands on its own. The fitter knows things the byte
total does not carry — no device could hold the placement, a load shape it will
not run — so a `does-not-fit` makes the model and the set `likely-too-large`
whatever the arithmetic says. Some engines report a refusal with no byte
breakdown at all; it still stands.

The engine comes from the caller's `modelType` when passed, and otherwise from
`modelSrc` the same way `loadModel` infers it. The load's own config is what the
fitter reads: a completion load is fitted at its `ctx_size`, an embedding load at
the context window the model declares.

`computed-only` is the fallback wherever the fitter reaches no verdict — no
registry description for the source, a load shape the SDK will not represent, an
engine with no fitter behind it. The floor omits everything that only a real load
can tell you — engine overhead, compute buffers, a completion's working peak —
and all of those are non-negative, so it never overstates the cost. That makes it
valid on every platform and backend: a model whose floor alone exceeds the budget
is `likely-too-large` anywhere. It is also why it can never say `likely-fits`:
how far above the floor the load lands is unmeasured there.

A set of candidates rests on its weakest evidence. One `computed-only` model
makes the combined `evidence` `computed-only`, and the combined verdict can then
refuse the set but not confirm it. Under `computed-only` `floorBytes` carries the
bound, aggregated under `execution` for the combined result. When a candidate
could not be assessed at all — no catalog profile, a companion source outside the
catalog — the combined `evidence` is absent: the set rests on nothing it can
name, and its `unknown` says so in `reasons`.

Branch on `evidence`, not on the verdict alone: an `unknown` under
`computed-only` for a small model is "no measurement here", not "too close to
call". A UI that hides `likely-too-large` models and shows the rest works
identically under both kinds of evidence; one that wants to promote a
`likely-fits` needs `native-fit`.

The floor is only compared where the model executes out of the memory the budget
measures — unified-memory devices, CPU-only desktops, integrated GPUs. On a
desktop with a discrete GPU and no engine verdict the result is `unknown`, since
the weights would live in the card's memory and the system budget bounds nothing
about them.

## Usage

```typescript
import { assessModelFit, QWEN3_8B_INST_Q4_K_M, WHISPER_EN_SMALL_Q8_0 } from '@qvac/sdk'

const result = await assessModelFit({
  models: [
    { modelSrc: QWEN3_8B_INST_Q4_K_M, modelType: 'llm', modelConfig: { ctx_size: 8192 } },
    {
      modelSrc: WHISPER_EN_SMALL_Q8_0,
      modelType: 'whisper',
      modelConfig: { duration_ms: 30_000 }
    }
  ],
  execution: 'sequential',
  policy: 'interactive-v1'
})

if (result.verdict === 'likely-too-large') {
  // offer a smaller model, or a smaller context
}

for (const model of result.models) {
  // `evidence` says whether an `unknown` is a near-miss or just unmeasured
  console.log(model.name, model.verdict, model.evidence, model.reasons)
}
```

### Each candidate is a load

A candidate takes the same parameters as `loadModel`: `modelSrc`, optional
`modelType`, and an optional `modelConfig`. `modelType` is inferred from
`modelSrc` when omitted. The engine's own plugin resolves that config — the same
handling and the same artifact keys a real load gets — so the fitter reads the
settings the load would run with, and a compound load names its companion files
through `modelConfig` the way `loadModel` does.

Each source resolves to the registry's weightless description of the artifact, or
to the file itself where it is already on disk. The floor reads its workload from
the same config: `ctx_size` for a token context, `duration_ms` for an audio
window.

### `execution` is a declared assumption

`sequential` counts every model as resident but adds only the largest single
working peak; `concurrent` adds every peak. It describes what you intend to do so
the numbers match your plan — the SDK does not schedule, serialize, or reserve
anything on the strength of it.

### `policy: 'interactive-v1'`

Headroom withheld from the budget: 20% of the memory available right now, capped
at 2 GiB on desktop and 1 GiB on mobile. It is a share of what is free, not of
`total`, so it can never exceed the headroom it is carved from — a busy host with
3 GiB free keeps a 2.4 GiB budget rather than none. Under `system-memory` that
headroom is left for the rest of the system; under `process-memory` it is left
inside the app's own ceiling, since jetsam acts on this app's footprint.

```text
available = total − in use now
budget    = available − min(cap, 20% × available)

demand > budget  → likely-too-large
otherwise        → likely-fits
```

A `computed-only` set is compared the same way, except that only the refusal half
applies: a floor under the budget is `unknown`.

This reserve is the SDK's, independent of the headroom the engine's fitter
leaves for itself. A model the fitter calls a fit can therefore be
`likely-too-large` here: the fitter answers whether the load places, this
answers whether it places inside the policy's budget.

The result's `budget` carries every term — `totalBytes`, `usedBytes`,
`availableBytes`, `reservedBytes`, `availableAfterReserveBytes` — so a verdict
can be read back to the numbers it came from.

What "total" and "in use" mean depends on the result's `basis`:

- **`system-memory`** — device RAM and system-wide use. Desktop, and Android by
  explicit decision: its low-memory killer acts system-wide, and native
  allocations carry no per-process cap.
- **`process-memory`** — the app's own ceiling. iOS jetsam terminates an app on
  its per-process footprint against a limit well below device RAM, so a system
  budget there would defend verdicts the OS does not honor. The budget is the
  per-process allowance the OS reports plus the current footprint. A build that
  cannot state that allowance assesses as `unknown` rather than returning a
  confidently wrong `likely-fits`; the computed floor is still reported, it just
  has nothing to be compared against.

- **`device-memory`** — a discrete GPU's own memory, used when the model will
  execute there. Only for a GPU whose readings the collector established are
  device-scoped; everything else keeps the system basis. See
  [desktops with a GPU](#supported-surface) below and the
  [system resources support matrix](./system-resources-support-matrix.md).

## Supported surface

The fitter runs for `llamacpp-completion`, `llamacpp-embedding`,
`whispercpp-transcription`, `parakeet-transcription`,
`bci-whispercpp-transcription`, `tts-ggml`, `audiogen-ggml` and
`sdcpp-generation`, on every platform the engine's addon is built for.

Of those, llama.cpp, whisper, parakeet, BCI whisper and TTS report a byte
breakdown, so their measurements compose into a combined verdict. Audiogen
reports a peak across pipeline phases and diffusion a per-module table; neither
divides into bytes that can be summed under one budget, so a `fit` from them
falls back to the [computed floor](#two-kinds-of-evidence) while a refusal still
stands. `nmtcpp-translation`, `onnx-tts`, `ggml-ocr`, `ggml-vla` and
`ggml-classification` have no fitter yet and assess from the floor.

Two shapes the SDK refuses to put to an engine, so that it is never asked a
question it cannot answer: a sharded model, which every fitter reads as whole
files, and a multimodal completion load naming a projection model, which is a
second resident file the projection does not count. Both fall back to the floor.

A verdict beyond the floor needs three things: the fitter reaching one, a usable
memory sample, and a runtime platform among `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`, `android-arm64` and
`ios-arm64`. Anything else is `unknown`, and the result's `reasons` say which.

**Desktops with a GPU.** Where a GPU is present the assessment works out where
the model would actually go, because that decides which memory the budget
measures. Devices the engine cannot use are discounted: a VM's paravirtual
display adapter, and any device with no graphics API the build talks to. What
remains decides the basis.

- **A card with its own memory** → `device-memory`, with the GPU's total, used
  and reserve in `budget` as usual. Where several cards qualify, they are
  alternatives rather than one pool: the engine pins the model to one and which
  one is not observable, so a `likely-fits` has to hold on the smallest and a
  `likely-too-large` on the largest. In between the answer is `unknown`. Adapters
  too small to hold any model are not counted as rivals — Windows classifies an
  Intel iGPU as dedicated because it declares 128 MiB of its own.
- **Only integrated GPUs** → the model runs on the GPU, but an integrated device
  allocates out of system RAM, so the basis stays `system-memory`.

On Windows a card's readings are per-process rather than device-wide (DXGI
`CurrentUsage` and `Budget`), so the basis is `device-budget` instead: the GPU
memory the OS grants _this process_. It answers the same admission question.

Both device bases additionally require the **system-memory** budget to hold, on
every verdict — a GPU load is paid for in system RAM too (a 2382 MiB model raised
RSS by 2918 MiB on Windows, 868 MiB on linux), so a machine with the card for it
but not the RAM does not read as a fit.

Where no single device can be named — cards that disagree on the backend or on
the scope of their readings, a GPU whose readings carry no usable scope, an AMD
GPU on linux — the basis stays `system-memory`. The collector infers
dedicated-versus-integrated from the driver's reported VRAM, and an AMD APU
exposes its carve-out the same way a small discrete card exposes its memory, so
the two cannot be told apart from JS; budgeting against the carve-out would be
wrong. The system budget still bounds the load, and an engine that cannot place
the model refuses it outright.

Apple silicon is unaffected: its memory is unified, so a GPU allocation is system
RAM and the system basis already covers it.

### Mobile

Both mobile platforms are unified memory, so no GPU placement is involved; the
budget is the whole story.

- **`android-arm64`** uses the `system-memory` basis by explicit decision (its
  low-memory killer acts system-wide), and applies the mobile reserve.
- **`ios-arm64`** uses the `process-memory` basis, because jetsam terminates an
  app on its own footprint against a limit well below device RAM. The budget is
  the per-process allowance the collector reports on iOS plus the current
  footprint; a build whose collector does not report the allowance has no budget
  and returns `unknown`.

## Why a result is `unknown`

Every `unknown` names its cause in `reasons` — on the model when it is about that
model, on the result when it is about the machine. The strings below are the ones
the current release emits, grouped by what you can do about them.

| Reason (abridged)                                                                             | Cause                                                                                                                                            | What helps                                                                        |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `no engine fit for <model>: <detail>`                                                         | The fitter could not be asked: no plugin for the model type, a load shape the SDK will not represent, or no registry description for the source. | Read the detail; a catalog constant with a published fit stub is the usual fix.   |
| `the engine fitter reached no verdict for <model>: <detail>`                                  | The fitter ran and declined — a config it will not project from, a model it could not read.                                                      | Read the detail; often a setting in `modelConfig` the engine refuses to fit.      |
| `no engine verdict, and the floor has no budget to be compared against`                       | A discrete GPU would run the model, so the system budget bounds nothing about it, and no engine verdict replaced it.                             | None on the caller's side; needs the fitter to reach a verdict on that host.      |
| `the runtime platform is not one this assessment covers`                                      | Running somewhere outside the eight platforms the SDK knows.                                                                                     | None.                                                                             |
| `iOS budgets are per-process … the per-process allowance metric is not available`             | The collector on this build does not report `processAvailableBytes`.                                                                             | Update to a build whose collector reports the iOS per-process allowance.          |
| `system-memory metrics are not supported on this platform` / `no memory sample was available` | The collector could not produce `sample.memory.{total,used}Bytes`.                                                                               | Check `getSystemResources({ sample: true })` on the host; see the support matrix. |
| `system-memory metrics are inconsistent` / `process-memory metrics are inconsistent`          | The sample reported more used than total, or a negative value.                                                                                   | Re-sample; if it persists, the collector on that host is misreporting.            |
| `no resource profile in the catalog for this checksum`                                        | The model is not a generated catalog constant (a local file, a custom source).                                                                   | Only catalog constants can be assessed before download.                           |
| `an entry in artifacts has no resource profile in the catalog`                                | A companion source named in the load's config is not in the generated catalog.                                                                   | Pass catalog constants only.                                                      |
| `no GGUF metadata for this model in the catalog, so the floor counts weights only`            | The entry has no `ggufMetadata`, or it lacks the keys the KV cache is sized from.                                                                | None on the caller's side; the floor is just looser.                              |
| `at least one model could not be assessed, so the combined verdict is unknown`                | On the result: one model in the set is `unknown`, so the set cannot be judged.                                                                   | Read that model's own `reasons`; assess it alone if needed.                       |

Two more `unknown`s carry no dedicated reason because they are the verdict rule
working as designed: a `computed-only` floor that lands under the budget, and,
with several discrete GPUs, a fit that holds on the largest card but not the
smallest. In both cases `budget` is present, so the caller can see how close it
was.

## Relationship to the load-time probe

`assessModelFit` is the pre-download tier: it reads the registry's weightless
description of a model, so it answers before the weights exist locally. The probe
`loadModel` runs, reported as `fitProbe` on `getLoadedModelInfo`, is the
post-download tier — it reads the real file and is the stronger evidence once you
have it. Both call the same engine fitter, at different points in the lifecycle,
and neither replaces the other.
