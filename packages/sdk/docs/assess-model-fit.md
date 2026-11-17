# Model fit assessment

`assessModelFit` answers one question before anything is downloaded: do these
models fit in this device's memory when loaded together? For every model it runs
the engine's own fitter, against the model where it is already on disk and
otherwise against the registry's weightless description of it, tens of KB, the
tensor list and the settings with no data section. Each fitter reports the memory
its load takes on each device. The SDK sums that memory per device and compares
the totals against what is free. It never downloads weights and never loads a
model.

It is **advisory**. It does not block `loadModel`, reserve memory, choose a model
for you, or make any claim about speed.

## Usage

```typescript
import { assessModelFit, QWEN3_8B_INST_Q4_K_M, WHISPER_EN_SMALL_Q8_0 } from '@qvac/sdk'

const result = await assessModelFit({
  models: [
    {
      modelSrc: QWEN3_8B_INST_Q4_K_M,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 8192 }
    },
    { modelSrc: WHISPER_EN_SMALL_Q8_0, modelType: 'whispercpp-transcription' }
  ]
})

if (result.verdict === 'does-not-fit') {
  // offer a smaller model, or a smaller context
}

for (const pool of result.pools) {
  console.log(pool.id, pool.usedBytes, pool.freeBytes)
}

for (const model of result.models) {
  console.log(model.status, model.devices)
}
```

### Each model is a load

A model takes the same parameters as `loadModel`: `modelSrc`, optional
`modelType`, and an optional `modelConfig`. `modelType` is inferred from
`modelSrc` when omitted. The engine's own plugin resolves that config, with the
same handling and the same artifact keys a real load gets, so the fitter reads
the settings the load would run with, and a compound load names its companion
files through `modelConfig` the way `loadModel` does.

Each source resolves to the registry's weightless description of the model, or
to the file itself where it is already on disk. Two fit-only fields describe a
workload the load does not carry: `transcriptionWorkload` for MOSS-Transcribe and
`ttsWorkload` for MOSS-TTS/TTSD and MOSS-SoundEffect.

## Result

```typescript
{
  verdict: 'fits' | 'does-not-fit' | 'unknown',
  pools: [{ id, unified, usedBytes, freeBytes?, totalBytes? }],
  models: [
    {
      status: 'fits' | 'does-not-fit' | 'unknown',
      devices: [{ id, name, unified, usedBytes, freeBytes?, totalBytes? }],
      stats: { ctxSize, gpuLayers } | {}
    }
  ]
}
```

`verdict` is the answer for every model loaded together. `pools` holds the
memory pools it was judged on: `host` for the host's memory, and one pool per
GPU with its own memory, keyed by the GPU's `id`. Each carries what the set takes
from it and the lowest free and total figures reported for it.

`models` holds one entry per model, in input order: the engine addon's own
`assessFit` result. `status` is that model's verdict alone, `devices` has one row
per device its load uses with the host last. For a llama.cpp model with a
verdict, `stats` holds the context size and GPU layers the load resolves to: the
ones the fitter settled on when it fits, the ones the load asked for when it does
not. It is empty for every other model. A model the SDK cannot size has
`status: 'unknown'`, no rows and empty `stats`.

`unknown` means the SDK cannot say. Show it as "can't say", never as "no". It is
the answer for a load that would start but cannot be sized: an engine with no
fitter, a load the fitter cannot project, a model with no registry description
that is not on disk, or a device that reported no free memory.

A load that `loadModel` would refuse makes `assessModelFit` throw the same
error: no plugin for the model type, a config the plugin's schema or
`resolveConfig` refuses, or the engine fitter rejecting the load, such as a
model it cannot read.

## How the verdict is reached

Each addon's `assessFit` returns its own verdict and one row per device its load
uses, with the fields `id`, `name`, `unified`, `usedBytes`, `freeBytes` and
`totalBytes`.

`id` is the device's PCI bus ID where the backend reports one, and its name
otherwise, so the same GPU matches across addons built on different backends.
`unified` marks memory the host owns: the CPU, an integrated GPU, Apple's Metal
GPU, Android's OpenCL GPU, and any device that reports no memory of its own. The
host row comes last, and its free memory is what the OS would grant a new
allocation; on iOS it is capped at the app's own limit.

The SDK groups the rows of every model into pools. Every unified row joins the
host pool; any other row joins the pool of its `id`. A pool's use is the sum of
its rows' `usedBytes`. Its free memory is the lowest figure reported for it.

For a single model, `verdict` is that model's `status`: the fitter applies the
engine's own margin to its devices. For several models:

```text
any pool uses more than 90% of its free memory  → does-not-fit
any model's fitter says does-not-fit            → does-not-fit
otherwise, any model unknown or any pool with
  no free figure                                → unknown
otherwise                                       → fits
```

Each fitter's margin covers its own model, so the set holds back 10% of every
pool for what the machine allocates between the check and the loads.
`does-not-fit` wins over `unknown`: the use known so far is a lower bound, so a
pool already overflowing stays overflowing whatever an unknown model adds.

A fitter's own `does-not-fit` stands even where the sums fit. The fitter knows
things the byte totals do not carry, such as no device being able to hold the
placement.

## Supported surface

The fitter runs for `llamacpp-completion`, `llamacpp-embedding`,
`whispercpp-transcription`, `parakeet-transcription`, `moss-transcribe`,
`bci-whispercpp-transcription`, `tts-ggml`, `audiogen-ggml`, `sdcpp-generation`,
`ggml-ocr` and `nmtcpp-translation`, on every platform the engine's addon is built
for.

What each engine's rows cover:

- **llama.cpp completion and embedding**: model, context and compute memory on
  each device the model is assigned to, then the host. With `load_mode: 'mmap'`
  the host row leaves out the mapped weights, which the OS can evict. A CPU
  load, a LoRA adapter, a multimodal projector, or `fit` turned off is
  `unknown`.
- **whisper, parakeet, MOSS-Transcribe, BCI and TTS**: the device and the host.
  A CPU load is one host row. Parakeet's Core ML diarizer bundles are host
  memory. The BCI host row includes the embedder, read from `bci-embedder.bin`
  beside the model or from the load's `embedderModelSrc`.
- **audiogen**: each device's peak across the pipeline phases, then the host.
- **diffusion**: the placement stable-diffusion.cpp measures, per device and for
  the host, for image generation, video, standalone `mode: 'upscale'` and
  `mode: 'world'`. A configured ESRGAN `upscaler` is fitted together with its
  model. A world load needs its `taehvModelSrc` and a pre-built `sceneSrc`, and
  `world.fitSteps` (default 100) sets how many walk steps the fit covers. A load
  the engine can place only by changing its backend assignment is
  `does-not-fit`. A load pinned to one device, by `mainGpu`, a `device` of
  `cpu`, or a module-specific `paramsBackend`, is `unknown`.
- **OCR**: the weights alone, leaving the memory an image needs uncounted.
- **translation**: one allowance for the whole load, from the model and
  vocabulary files themselves, so it answers for files on disk only.

Everything else is `unknown`: `onnx-tts`, `ggml-vla` and `ggml-classification`,
a translation model not yet downloaded, MOSS-Speech, a TTS load with a LavaSR
enhancer or denoiser, a diffusion world load without a `sceneSrc`, a load naming
an ESRGAN checkpoint not yet downloaded (the catalog's `.pth` checkpoints have no
registry description), a split model, a multimodal completion load naming a
projection model, and any model whose registry description cannot be fetched
within `fitStubBudgetMs`.

## Relationship to the load-time check

`assessModelFit` answers before the weights exist locally. The check `loadModel`
runs reads the real files once they are downloaded and uses the same calculation
for that one load. `getLoadedModelInfo` reports it as `fitProbe`, in the same
shape as an `assessModelFit` result with one model. Its verdicts
appear on the SDK log stream as `[advisory-fit:…]` lines, which name why a load
is `unknown` and list every pool and every device row. `assessModelFit` logs the
same accounting as a `[model-fit]` line. Unlike `assessModelFit`, the load check never throws: a fitter
that rejects the load is logged and the verdict is `unknown`.

`modelFitPolicy` decides what the load check's verdict does: `log` (the default)
reports it, `refuse` rejects a `does-not-fit` load with `MODEL_FIT_REFUSED`
before the addon allocates anything, and `off` skips the check.
