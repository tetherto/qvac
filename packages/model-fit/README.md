# @qvac/model-fit

Memory-fit **preflight** addon for QVAC. It wraps llama.cpp's public
`common_fit_params` C API (the library behind the upstream `llama-fit-params`
tool) to project — **without loading any weights** — whether a GGUF model fits
the available device memory, and if so with what offload plan.

The fitter simulates allocations internally (`no_alloc`), reading GGUF metadata
and building the worst-case compute graph to size the model, KV/context and
compute buffers, then iteratively reduces context and moves tensors off the GPU
until the projection fits within a per-device free-memory margin.

## Why a separate addon / worklet

Probing device memory instantiates the GPU backend (Vulkan/Metal/CUDA), which
can wedge driver state on some mobile GPUs. Running the preflight in its own
short-lived worklet keeps any instability away from the inference worker. The
call is a **single shot**: run it, read the plan, tear the worklet down.

## API

```js
const { fitParams, FIT_STATUS } = require('@qvac/model-fit')

const plan = fitParams({
  modelPath: '/abs/path/model.gguf',
  nCtx: 4096,        // 0 => let the fitter choose (down to nCtxMin)
  nCtxMin: 4096,     // lower bound when reducing context to save memory
  marginMiB: 1024,   // free headroom to leave on every device
  backendsDir: '…'   // where the packaged ggml backends live (see below)
  // nBatch, nUbatch, nGpuLayers are optional
})

// plan = {
//   status,       // 0 SUCCESS | 1 FAILURE (won't fit) | 2 ERROR (unknown)
//   fits,         // status === SUCCESS
//   reason,       // 'fits' | 'does-not-fit' | 'model-unreadable' | 'no-backend-device'
//   buftOverrides,// placement the projection depended on, [] when none
//   nGpuLayers,   // fitted offload layer count
//   nCtx,         // fitted context size
//   nBatch, nUbatch,
//   splitMode,    // llama_split_mode — how the model splits across GPUs
//   mainGpu,      // device holding the model when splitMode is NONE
//   typeK, typeV, // ggml_type of the K/V cache — changes KV memory
//   flashAttnType,// llama_flash_attn_type — changes KV/compute memory
//   maxDevices,   // llama_max_devices() — a build-time bound, NOT a detection
//   nDevices,     // devices actually registered; 0 => ERROR
//   nGpuDevices,  // of those, GPU/iGPU; 0 => host-only projection
//   tensorSplit   // number[] offload proportion per device
// }
```

### Backend registration

`common_fit_params` does not load backends — it reads ggml's global device
registry, so whatever is registered when it runs is its entire view of the
machine. Registering is the caller's job, exactly as in upstream's
`tools/fit-params`, which relies on `llama_backend_init()`.

This addon registers backends before every fit. Statically linked backends
self-register, so `backendsDir` can be omitted; where backends ship as separate
shared libraries, pass the directory (`BACKENDS_SUBDIR` is appended) or the
fitter sees nothing. It must be absolute and must resolve to an existing
directory — every library found there is `dlopen`ed into the process, so it has
to be an application-controlled location, never remote or user input.

Registration is never undone. `llama_backend_free()` is not the inverse of
`llama_backend_init()` — it releases the process-global IQ dequantisation
tables that every llama consumer shares, so calling it here would break
inference running concurrently in `@qvac/llm-llamacpp`, which reference-counts
to avoid exactly that. Leaving the backends registered is free: ggml's registry
de-duplicates, and every fit wants the same device inventory.

An empty registry is reported as `ERROR`, never `SUCCESS` — a projection made
against a machine the fitter cannot see is worse than no projection. Check
`nDevices`/`nGpuDevices` rather than `maxDevices`, which is a compile-time
constant and is nonzero even when nothing was detected.

`fitParams` is synchronous and blocking. It never throws for a "won't fit"
outcome (that is a valid `FAILURE` result) or for a missing model file (`ERROR`);
it throws only on invalid arguments.

Calls are **serialised process-wide**. `common/fit.h` documents `common_fit_params` as
not thread safe because it mutates global llama logger state, and this addon's
C++ statics are shared across every worklet in a process, so concurrent callers
block rather than corrupt each other. Serialising also guarantees two backend
registrations never overlap, which is why the backend setup above needs no
reference counting.

### Fit semantics (from `common/fit.h`)

- `common_fit_params` only rewrites `mparams`/`cparams` fields that still hold
  their **default** value. Pinning `nGpuLayers` therefore *fixes* it and the
  fitter fits the rest around it; omit it to let the fitter choose.
- One consequence worth knowing: `-1` **is** the llama default for
  `n_gpu_layers`, so passing `nGpuLayers: -1` ("all layers") does not pin
  anything — it is indistinguishable from omitting the field, and the fitter
  stays free to rewrite it. Pin with `0`, a positive count, or any negative
  other than `-1`.
- Context is the documented exception: it is reduced **iff** `nCtx == 0`. A
  concrete `nCtx` is treated as a hard requirement and comes back unchanged.
- `nCtx` is **bounded by the model's declared `context_length`** and throws
  above it. llama.cpp only warns, because a caller can push past the trained
  length with RoPE scaling — but this addon exposes none of those knobs, so the
  only extension reachable through it is the model's own, and a YaRN-extended
  model already reports the extended figure as `context_length` (keeping the
  pre-extension value in `rope.scaling.original_context_length`). The bound
  therefore permits everything this API can legitimately ask for. It would need
  revisiting if RoPE scaling parameters were ever exposed.
- `nCtxMin` defaults to **4096** when left at 0, matching upstream's
  `common_params::fit_params_min_ctx`. Reducing towards a floor of zero
  could otherwise return a context nothing can run with. On a model trained
  shorter than that the default is **clamped to `context_length`** — a floor
  above the top of the reduction range constrains nothing.
- An **explicit** `nCtxMin` is bounded by `context_length` exactly as `nCtx`
  is, and throws above it. The `nCtxMin <= nCtx` check below cannot cover this:
  it only applies when `nCtx` is concrete, and `nCtx: 0` is the documented way
  to let the fitter choose.
- A `SUCCESS` always reports a concrete `nCtx`. When the fitter needs no
  reduction it leaves the context at the 0 it was handed — llama's encoding for
  "use the trained context" — so the trained value is read from GGUF metadata
  (KV block only, still no weights) and returned instead.

### Argument validation

`modelPath` must be **absolute**, as `backendsDir` must. A relative path
resolves against the process working directory, which nothing in a worklet
controls — the same call would then name a different file, or no file, from one
launch to the next. It is not required to exist: a missing model is the
documented `ERROR` / `model-unreadable` outcome rather than a thrown error.

Numeric fields cross into C++ as `uint32_t`/`int32_t`, where fractions truncate
and out-of-range values wrap — `marginMiB: -1` would otherwise become a margin
nothing can satisfy. All must be safe integers within the range of their target
type, with `nUbatch <= nBatch` and `nCtxMin <= nCtx`.

`nGpuLayers` is the one **signed** field. `llama.h` defines it as "number of
layers to store in VRAM, a negative value means all layers", so negatives are
valid input — `-1` is the llama default and what upstream's `llama-fit-params`
prints back. Read the same care into the *result*: a negative `nGpuLayers`
means the fitter never rewrote the field, which is what happens on a host with
no accelerator. Check `nGpuDevices` before treating it as an offload plan.

These checks are enforced **in the native binding as well as the JS wrapper**,
because `./binding.js` is a public export and can be called without passing
through `index.js`.

## Asking a question that can actually fail

`common_fit_params` fits to free **device** memory and, per `common/fit.h`, "assumes
system memory is unlimited". Where a GPU is present, nothing stops it moving
every layer to the host, so with default arguments it answers almost anything
with `SUCCESS` — an unsatisfiable multi-TiB margin still returns `SUCCESS` with
`nGpuLayers: 0`.

(On a **host-only** machine that fallback does not exist: the host is the only
device, the margin applies to it, and there is nowhere to move anything, so the
same call returns `FAILURE`. Do not read a host-only `FAILURE` as "this hardware
is too small" without checking `nGpuDevices` — it may just be an unmeetable
margin.)

**`fits` alone is therefore close to useless as an admission signal.** It means
"this could run somehow", which wherever a CPU fallback exists is nearly always
true.

To get a verdict that can fail, pin a constraint the fitter is not allowed to
relax. Only fields left at their llama default get rewritten, so pinning
`nGpuLayers` turns offload into a hard requirement:

```js
// "can this device run the model with at least 20 layers on the GPU?"
const plan = fitParams({ modelPath, nGpuLayers: 20, marginMiB: 1024 })
if (plan.status === FIT_STATUS.FAILURE) { /* a real "won't fit" */ }
```

The useful question is rarely "can this run at all" but "can this run *well
enough*" — which means asking about offload, context, or both, and reading the
plan rather than the flag.

## SDK usage (intended)

The SDK runs this preflight before handing a model to `@qvac/llm-llamacpp`:

1. sample device resources,
2. `fitParams(...)` in an isolated worklet → load plan + fit projection,
3. **admit/deny** — only deny when it can *prove* the model won't fit; on
   `ERROR`/unknown, proceed as today (advisory-only until the projection and
   device identity are proven reliable).

## Build

```bash
npm install
npm run build          # build:ts + build:native
```

Or the two halves separately:

```bash
npm run build:ts       # tsc: src/index.ts -> index.js + index.d.ts
npm run build:native   # bare-make generate && bare-make build && bare-make install
```

Consumes llama.cpp via the `qvac-fabric` vcpkg port (fork
`tetherto/qvac-fabric-llm.cpp`); JS↔C++ marshalling helpers come from the
header-only `qvac-lib-inference-addon-cpp` port.

### JS API source of truth

`src/index.ts` is the only hand-written copy of the JS API. Root `index.js` and
`index.d.ts` are **generated** by `npm run build:ts` and committed, so consumers
get types and runtime from one implementation rather than three files kept in
sync by hand — the arrangement `@qvac/embed-llamacpp` uses.

`npm run check:generated` rebuilds and fails if either artifact differs from
what is committed, so a change to `src/` that is not regenerated cannot merge.
It runs as part of `npm run test:types`.

Edit `src/index.ts`, never the generated files.

## Test

```bash
npm test                       # validation + enum tests (no model needed)
FIT_MODEL_PATH=/abs/model.gguf npm test   # also runs the real fit projection
npm run test:types             # typecheck + consumer narrowing test + drift check
npm run lint                   # standard (JS) + eslint (TS)
```

### Reading the outcome

`FitResult` is a TypeScript discriminated union on `status`, so narrowing tells
the compiler which fields carry meaning — the plan is valid only on `SUCCESS`.

`reason` gives a stable, machine-readable cause that `status` cannot express:
`does-not-fit` (ran to completion, nothing fits) is a different signal from
`model-unreadable` or `no-backend-device`, and an SDK needs to tell "this
hardware can't do it" from "try again once the model is downloaded".

`buftOverrides` reports the tensor placement the projection depended on. A
`SUCCESS` carrying overrides is only reproducible if the real load applies the
same placement — treat a non-empty array as part of the plan, not decoration.

### Reproducing a plan

The same caution applies to the whole plan, not just the overrides. `llama.h`
states that `common_fit_params` modifies "only parameters that have the same
value as in `llama_default_model_params`", and this addon hands it defaults for
everything the caller did not pin. So `splitMode`, `mainGpu`, `typeK`, `typeV`
and `flashAttnType` are all fields the fitter may have chosen, and they are
reported for that reason.

A load that reproduces the projection has to apply **every** plan field. Loading
with your own defaults for the ones you did not ask about is how a `SUCCESS`
turns into an out-of-memory at real load time: the projection was measured
against placement you then did not use. This is also why the plan is only
readable after narrowing to `SUCCESS` — on any other branch these fields carry
no decision.

### What you state vs. what the fitter decides

The split is deliberate:

| You state | The fitter decides |
| --- | --- |
| `nCtx`, `nCtxMin`, `nBatch`, `nUbatch` | `tensorSplit` — per-device offload proportions |
| `nGpuLayers`, `splitMode`, `mainGpu` | `buftOverrides` — per-tensor buffer placement |
| `typeK`, `typeV`, `flashAttnType` | anything above you leave unset |
| `marginMiB` | |

Everything in the left column is something a caller plausibly knows about the
load it intends to perform, and stating one makes it a hard constraint the
projection fits around.

`tensorSplit` and `buftOverrides` are deliberately **not** inputs. They are the
placement decisions that need knowledge of the model's tensor layout and the
machine's device inventory — an expert-FFN pattern pinned to CPU so a MoE model
fits in VRAM, for instance. A caller who already knew the right answer would not
need to ask. So the fitter always chooses them, and they always come back on the
plan.

The consequence, which matters: a `SUCCESS` is **conditional on applying the
placement it returns**. This addon cannot express "does this exact configuration
fit" with no degrees of freedom left, because placement is never the caller's to
pin. What it answers is "given what I have decided, is there a placement that
fits — and if so, which one". Acting on the first half while ignoring the second
is the failure this section exists to prevent.

## Known crash paths

`common_fit_params` can terminate the process on inputs this addon accepts. These
are aborts inside the fitter, not exceptions, so they cannot be caught and
turned into a status — the calling worklet dies with the process.

- **A large `nCtx` aborts.** `ggml_abort()` fires in
  `ggml_backend_sched_backend_id_from_cur` — "pre-allocated tensor (cache_k_l0)
  in a buffer (Vulkan0) that cannot run the operation (NONE)" — reached while
  the fitter builds a `no_alloc` context to measure memory. Reported upstream as
  [ggml-org/llama.cpp#26268](https://github.com/ggml-org/llama.cpp/issues/26268),
  where it reproduces in llama.cpp's own `llama-fit-params`. The threshold is
  hardware-dependent; on one machine the fitter reduced offload correctly at
  `-c 50000000` and aborted at `-c 75000000`.

`GGML_ABORT` is not catchable, so this cannot be contained in-process. On mobile
the Bare worklet shares the app's process, so there is no process boundary to
absorb it either — the whole app goes down.

Bounding `nCtx` by the model's declared `context_length` (see above) keeps the
absurd values that reproduce this out of llama's hands. It is **not** a fix:
the fault is KV-cache placement, so a large model on a small device can still
reach it at an entirely ordinary context. Treat it as a guard against nonsense
input while the upstream fix is pending.

A Windows-only integer divide-by-zero (SEH `0xC0000094`) used to occur here too
and was contained by a `__try/__except`. That handler has been removed: the
trap's root cause was the missing `llama_backend_init()` documented above —
with no registered device, a count reached a division as zero. Windows now
returns a real projection rather than `ERROR`.

## Limitations (v1)

- Narrow llama.cpp LLM path only. Multimodal `mmproj` GPU memory is **not**
  counted by the fitter yet (upstream issue) — projections under-count for
  VLM/OCR models, so treat those as "unknown".
- The per-device MiB breakdown is only emitted to the log by llama.cpp
  (`llama_memory_breakdown_print`); it is not exposed as data here. This addon
  returns the actionable plan (layers / context / split), not the raw byte
  breakdown.
