# @qvac/model-fit

Memory-fit **preflight** addon for QVAC. It wraps llama.cpp's public
`llama_params_fit` C API (the library behind the upstream `llama-fit-params`
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
//   nGpuLayers,   // fitted offload layer count
//   nCtx,         // fitted context size
//   nBatch, nUbatch,
//   maxDevices,   // llama_max_devices() — a build-time bound, NOT a detection
//   nDevices,     // devices actually registered; 0 => ERROR
//   nGpuDevices,  // of those, GPU/iGPU; 0 => host-only projection
//   tensorSplit   // number[] offload proportion per device
// }
```

### Backend registration

`llama_params_fit` does not load backends — it reads ggml's global device
registry, so whatever is registered when it runs is its entire view of the
machine. Registering is the caller's job, exactly as in upstream's
`tools/fit-params`, which relies on `llama_backend_init()`.

This addon owns that lifecycle for the duration of a call. Statically linked
backends self-register, so `backendsDir` can be omitted; where backends ship as
separate shared libraries, pass the directory (`BACKENDS_SUBDIR` is appended)
or the fitter sees nothing.

An empty registry is reported as `ERROR`, never `SUCCESS` — a projection made
against a machine the fitter cannot see is worse than no projection. Check
`nDevices`/`nGpuDevices` rather than `maxDevices`, which is a compile-time
constant and is nonzero even when nothing was detected.

`fitParams` is synchronous and blocking. It never throws for a "won't fit"
outcome (that is a valid `FAILURE` result) or for a missing model file (`ERROR`);
it throws only on invalid arguments.

Calls are **serialised process-wide**. `llama.h` documents `llama_params_fit` as
not thread safe because it mutates global llama logger state, and this addon's
C++ statics are shared across every worklet in a process, so concurrent callers
block rather than corrupt each other. Serialising also guarantees two backend
scopes never overlap, which is why the backend lifecycle below needs no
reference counting.

### Fit semantics (from `llama.h`)

- `llama_params_fit` only rewrites `mparams`/`cparams` fields that still hold
  their **default** value. Pinning `nGpuLayers` therefore *fixes* it and the
  fitter fits the rest around it; omit it to let the fitter choose.
- Context is the documented exception: it is reduced **iff** `nCtx == 0`. A
  concrete `nCtx` is treated as a hard requirement and comes back unchanged.
- `nCtxMin` defaults to **4096** when left at 0, matching upstream's
  `common_params::fit_params_min_ctx`. Reducing towards a floor of zero
  could otherwise return a context nothing can run with.
- A `SUCCESS` always reports a concrete `nCtx`. When the fitter needs no
  reduction it leaves the context at the 0 it was handed — llama's encoding for
  "use the trained context" — so the trained value is read from GGUF metadata
  (KV block only, still no weights) and returned instead.

### Argument validation

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

`llama_params_fit` fits to free **device** memory and, per `llama.h`, "assumes
system memory is unlimited". Nothing stops it moving every layer to the host, so
with default arguments it answers almost anything with `SUCCESS` — an
unsatisfiable multi-TiB margin still returns `SUCCESS` with `nGpuLayers: 0`.

**`fits` alone is therefore close to useless as an admission signal.** It means
"this could run somehow", which for a CPU fallback is nearly always true.

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
bare-make generate
bare-make build
bare-make install
```

Consumes llama.cpp via the `qvac-fabric` vcpkg port (fork
`tetherto/qvac-fabric-llm.cpp`); JS↔C++ marshalling helpers come from the
header-only `qvac-lib-inference-addon-cpp` port.

## Test

```bash
npm test                       # validation + enum tests (no model needed)
FIT_MODEL_PATH=/abs/model.gguf npm test   # also runs the real fit projection
```

## Known crash paths

`llama_params_fit` can terminate the process on inputs this addon accepts. These
are aborts inside the fitter, not exceptions, so they cannot be caught and
turned into a status — the calling worklet dies with the process.

- **A large `nCtx` aborts.** `ggml_abort()` fires in
  `llama_context::graph_reserve` while sizing the worst-case compute graph,
  reached from `llama_get_device_memory_data`. Reproduced on linux-x64 with
  `nCtx: 100000000`, which is a perfectly valid `uint32_t`. The threshold is
  model-dependent and not discoverable from outside.
- **Windows GPU runners hit an integer divide-by-zero** (SEH `0xC0000094`)
  inside the fit math. Currently contained by a Windows-only `__try/__except`
  that reports `ERROR`; see the discussion on the trade-off in #3493.

This is the argument for running the preflight in a **disposable** worklet and
treating abnormal termination as `ERROR` in the parent: in-process containment
cannot cover `abort()`, only the SEH case.

## Limitations (v1)

- Narrow llama.cpp LLM path only. Multimodal `mmproj` GPU memory is **not**
  counted by the fitter yet (upstream issue) — projections under-count for
  VLM/OCR models, so treat those as "unknown".
- The per-device MiB breakdown is only emitted to the log by llama.cpp
  (`llama_memory_breakdown_print`); it is not exposed as data here. This addon
  returns the actionable plan (layers / context / split), not the raw byte
  breakdown.
