# Multi-GPU Inference

Distribute a model across multiple GPUs to run models that exceed single-GPU VRAM or to increase throughput via parallelism. This is controlled by four config parameters that work together: `device`, `split-mode`, `tensor-split`, and `main-gpu`.

## Parameters

### `device` (required)

Selects the device class. Must be `'gpu'` or `'cpu'`.

When `device` is `'cpu'`, all GPU-related parameters (`split-mode`, `tensor-split`, `main-gpu`) are silently ignored and inference runs entirely on CPU.

### `split-mode`

Controls how the model is distributed across GPUs.

| Value    | Behavior |
|----------|----------|
| `'none'` | **Default.** Pin the entire model to a single GPU selected by `main-gpu` (or auto-detected). No multi-GPU. |
| `'layer'`| **Pipeline parallelism.** Each transformer layer is assigned to a GPU. Layers flow sequentially through GPUs. Best for large batch or long-context workloads where layer count exceeds single-GPU VRAM. |
| `'tensor'`| **EXPERIMENTAL tensor parallelism** via qvac-fabric's meta device — weights *and* KV cache are split across every visible GPU. Desktop only. Requires flash attention, disables auto-fit, and is unavailable for some architectures. **See [tensor parallelism](#tensor-parallelism) below.** |

Accepts both `split-mode` (hyphen) and `split_mode` (underscore). Providing both throws an error. Case-insensitive (`'LAYER'` works).

`'row'` — llama.cpp's legacy split-buffer tensor parallelism — is **not** accepted: the load is rejected with `InvalidArgument` and the error directs callers to `'layer'` or `'tensor'`. It was removed because only the SYCL backend provides the split buffers it needs and SYCL is outside this package's backend allowlist, so a `'row'` request could never take effect and silently ran as `'layer'`.

#### Tensor parallelism

`split-mode: 'tensor'` selects `LLAMA_SPLIT_MODE_TENSOR`, which distributes the model through qvac-fabric's meta-device abstraction. It needs no backend-specific buffer type, so it is available on every shipped backend. Three constraints apply:

- **Flash attention is mandatory.** qvac-fabric fails context creation without it, so the addon rejects a falsey `flash-attn` together with `split-mode: 'tensor'` up front (`InvalidArgument`). qvac-fabric treats `off`, `disabled`, `false` and `0` as equivalent, and all four are rejected under both the `flash-attn` and `flash_attn` spellings. Leaving it unset is fine — it already defaults to `on`. `'auto'` is accepted too, since qvac-fabric promotes it to ENABLED for this mode itself — but note that makes tensor mode the one place `'auto'` does *not* preserve the runtime capability probe, because the mode requires flash attention unconditionally.
- **Auto-fit is disabled.** qvac-fabric's memory fitting is not implemented for this mode, so the addon turns it off explicitly and logs a WARNING. The override is applied after argument parsing, so an explicit `fit: 'on'` cannot re-enable it. `gpu_layers` then defaults to every layer and `ctx_size` to the model's trained context. **Set `ctx_size` explicitly for large models**, or the load can OOM where auto-fit would have trimmed the context.
- **Not every architecture is supported.** qvac-fabric implements the tensor split per architecture; unsupported ones are rejected before loading with the architecture named. Mamba/Jamba-family, BitNet, Grok, T5, DeepSeek-V2/3.2, MiniMax, Qwen3-Next and several others are excluded as of v10297.1.1. The list shrinks as well as grows — `deepseek4`, `qwen35` and `qwen35moe` were excluded at v10297.0.0 and are supported from v10297.1.0. Common dense and MoE architectures (`llama`, `qwen2`, `qwen3`, `qwen3moe`, `gemma2`, `gemma3`, `phi3`, `mistral3`) are supported. Note the architecture names are the GGUF `general.architecture` values, not model marketing names — most Mistral GGUFs report `llama`, and `mistral4` is on the unsupported list.

**Device selection is pinned explicitly in every split mode.** Both `layer` and `tensor` hand qvac-fabric an explicit device list that the addon builds itself, rather than letting it enumerate. The addon cannot delegate this any more, because a device fabric registers is not necessarily one this package is allowed to run on: the backend allowlist admits Vulkan, Metal/MTL, the Adreno OpenCL path, CUDA and RPC, and rejects HIP/ROCm, SYCL, MUSA and unknown families. If the addon omitted the list, fabric could place layers on a rejected backend.

The list is built once and used for everything: placement, the device handles, the OpenCL/Metal/Adreno traits and the device count. It follows qvac-fabric's own ordering so behaviour matches what fabric would have done within the eligible set: RPC devices first, then discrete GPUs, or the integrated ones only when no discrete GPU is present, deduplicated on the backend-reported `device_id` (the PCI bus id). Deduplication compares that id byte for byte, the same way fabric does, so a CUDA MPS or MIG virtual device keeps its distinct `-v<n>` identity instead of collapsing onto its parent. Description is deliberately **not** used: two identical cards report identical descriptions, so deduplicating on it would collapse a 2× RTX 4090 host to a single GPU.

This matters most for `tensor`. qvac-fabric's tensor path does no filtering of its own, so left to itself it would split weights and the KV cache onto the iGPU of any discrete + integrated host, pacing the whole model by the weakest participant, and would shard a dual-registered GPU twice.

`main-gpu` cannot select among split devices in any split mode. qvac-fabric reads `main_gpu` only under `split-mode: 'none'`, so the addon ignores it in `layer` and `tensor` and logs a warning.

**`'tensor'` is not selectable through the SDK.** `@qvac/inference`'s `llamacppCompletionConfigSchema` does not yet include `'tensor'`, so an SDK `loadModel` call with `'tensor'` fails Zod validation before it reaches the addon. For now the mode is reachable only through direct addon `loadModel`. Widening the SDK schema is separate SDK-pod work.

qvac-fabric documents `LLAMA_SPLIT_MODE_TENSOR` as **EXPERIMENTAL** and expects good performance primarily on multi-GPU CUDA. No backend qvac-fabric currently builds provides a tuned all-reduce, so they use the meta backend's generic fallback reduction. It is correct, but do not assume it is faster than `layer` without measuring.

The second column is the backend allowlist: whether this package will run on a device from that family at all, independent of whether qvac-fabric builds it today.

| Backend | Eligible here? | `'tensor'` all-reduce |
|---------|----------------|------------------------|
| Vulkan  | Yes | Meta device, generic all-reduce |
| Metal / MTL | Yes | Meta device, generic all-reduce |
| OpenCL  | Yes, the Adreno path | Meta device, generic all-reduce |
| CUDA    | Yes, but qvac-fabric does not build it yet | Backend-specific all-reduce, the tuned path upstream vouches for |
| RPC     | Yes, but qvac-fabric does not build it yet | Meta device, generic all-reduce |
| HIP / ROCm | **No**, rejected by the allowlist | n/a |
| SYCL    | **No**, rejected by the allowlist | n/a |
| MUSA    | **No**, rejected by the allowlist | n/a |
| anything unrecognised | **No**, rejected by the allowlist | n/a |

"Generic all-reduce" means the meta backend reduces with ordinary ggml graph ops rather than a backend-native collective. Every backend currently reachable here takes that path.

CUDA and RPC are admitted ahead of the qvac-fabric builds that will ship them, so that arrival needs no change in this package. Until then they simply never appear in the registry. HIP/ROCm is rejected deliberately: `vla-ggml` prefers ROCm on purpose for its own reasons, but this package has never been validated on it, and qvac-fabric can now ship it.

### `tensor-split`

A comma-separated string of proportions that control how much of the model each GPU receives.

```
'tensor-split': '1,1'     // equal 50/50 split across 2 GPUs
'tensor-split': '3,1'     // 75% on GPU 0, 25% on GPU 1
'tensor-split': '2,2,1'   // 40/40/20 across 3 GPUs
```

The values are relative weights, not absolute sizes. qvac-fabric normalizes them internally so `'1,1'` and `'50,50'` produce the same result.

- In `layer` mode: controls how many layers are assigned to each GPU (proportional to the weights).
- In `tensor` mode: controls each GPU's share of every split tensor and of the KV cache.
- When `split-mode` is `'none'` (or omitted): `tensor-split` has no effect since only one GPU is used.

**The values are positional, so they are remapped when filtering changes the device list.** A share list is written against the GPUs as the registry reports them, but the list the addon pins can be shorter or in a different order once ineligible backends are dropped, duplicates are merged and RPC is moved to the front. Passing the original list through unchanged would hand share 0 to a different GPU than the caller meant.

The addon therefore accepts either of two cardinalities, checked in this order:

1. one value per **eligible device**, taken as already being in final order, or
2. one value per **registered GPU**, remapped through to the final list.

If the count matches neither, the load is rejected with `InvalidArgument`. It is not truncated or zero-padded, because qvac-fabric pads a short list with zeros, which silently leaves a participating GPU with no layers at all, and drops the tail of a long one.

**Final order wins when the two counts are equal.** On a host where every registered GPU is eligible, a share list is read positionally against the pinned list, which is what qvac-fabric itself does with the `params.devices` the addon supplies. So if RPC hoisting or deduplication reordered the list relative to the registry, write the shares in the pinned order, not the registry order. The pinned order is logged at load time.

Values are tokenized the way qvac-fabric does, on runs of `,` or `/`, so `'1,,2'` and `'1, 2'` both mean two shares.

### `main-gpu`

Selects which GPU to use. The behavior depends on the split mode:

| Split mode | `main-gpu` role |
|------------|----------------|
| `'none'`   | Picks the **sole GPU** for the entire model. |
| `'layer'`  | **Ignored entirely** (warning logged). Placement is controlled by `tensor-split`. |
| `'tensor'` | **Ignored entirely** (warning logged). Every eligible device participates. |

`main-gpu` is only meaningful in `'none'` mode, because qvac-fabric reads `main_gpu` only under `LLAMA_SPLIT_MODE_NONE`. In `layer` and `tensor` the addon parses the value, logs a warning that it is being ignored, and drops it. It does **not** filter the split device list and cannot cause CPU fallback in those modes.

| Value | Behavior in `'none'` mode |
|-------|----------|
| integer (e.g. `'0'`, `'1'`) | Selects a GPU by its index in the raw ggml device registry, matching qvac-fabric's own indexing. If that device is not in the backend allowlist, the load falls back to CPU rather than silently sliding onto a different GPU. |
| `'integrated'` | Filters to integrated GPUs only during backend selection. Falls back to CPU if none is eligible. |
| `'dedicated'`  | Filters to dedicated GPUs only during backend selection. Falls back to CPU if none is eligible. |

Accepts both `main-gpu` (hyphen) and `main_gpu` (underscore). Providing both throws an error. The string values are case-insensitive.

Note the index is against the **raw** registry, not the filtered list. This is deliberate: it is the same index space qvac-fabric and the other addons use, so a given integer means the same device everywhere regardless of which backends the allowlist happens to admit on that host.

## How the parameters interact

```
device ─── 'cpu' ──> All GPU params ignored, CPU inference
  │
  └── 'gpu' ──> Backend selection runs (considers main-gpu)
                  │
                  ├── No GPU found ──> CPU fallback
                  │   split-mode, tensor-split, main-gpu all cleared
                  │
                  └── GPU found
                        │
                        ├── split-mode = 'none' (default)
                        │   Model pinned to single chosen GPU via --device
                        │   tensor-split has no effect
                        │
                        └── split-mode = 'layer' | 'tensor'
                            Eligible device list built first, then pinned:
                              params.devices = every eligible device, in
                              qvac-fabric's order (RPC first, discrete over
                              integrated, deduped on device_id)
                            tensor-split remapped to that list, then forwarded
                            main-gpu ignored entirely (warning logged)
                            tensor: additionally requires flash-attn on and a
                              supported architecture; auto-fit is disabled
```

### Interaction with `device` and backend selection

The `device` parameter is always required and is consumed first. When set to `'gpu'`:

The path taken depends on the split mode, and the two are genuinely different code paths:

- **`split-mode: 'none'`** (or omitted): `chooseBackend()` picks a single device, honouring `main-gpu`. The chosen backend name is passed as `--device <backend>`, pinning inference to that one GPU.
- **`split-mode: 'layer'` or `'tensor'`**: `chooseBackend()` is not used at all. The eligible device list is built first, and everything is derived from it: placement, the device handles, the OpenCL/Metal/Adreno traits and the device count. `main-gpu` is ignored.

In both cases, only devices whose backend family is in the allowlist are considered. If nothing survives, a warning names the rejected device and registry identities, and the load falls back to CPU with `split-mode` reset to `'none'` and `tensor-split` erased.

### Why the device list is pinned in split modes

The addon cannot let qvac-fabric enumerate for itself, because fabric registers backends this package is not allowed to run on. Its own filtered path would also make a different choice than the addon's: it does not know about the allowlist. Building the list in the addon and passing it as `params.devices` is what keeps placement, the traits and the tensor shares describing the same set of devices.

The list deliberately reproduces fabric's ordering rules within the eligible set, so pinning it changes which backends can participate but not how fabric would have ranked the ones that do.

## Usage examples

### Two-GPU equal split (layer parallelism)

```js
const config = {
  device: 'gpu',
  gpu_layers: '999',
  'split-mode': 'layer',
  'tensor-split': '1,1'
}
```

Distributes transformer layers equally across 2 GPUs. Each GPU processes roughly half the layers sequentially.

### Two-GPU unequal split (layer parallelism)

```js
const config = {
  device: 'gpu',
  gpu_layers: '999',
  'split-mode': 'layer',
  'tensor-split': '3,1'
}
```

Assigns roughly 75% of the layers to GPU 0 and 25% to GPU 1. Use this when the GPUs have unequal VRAM.

### Two-GPU tensor parallelism (EXPERIMENTAL)

```js
const config = {
  device: 'gpu',
  gpu_layers: '999',
  'split-mode': 'tensor',
  'tensor-split': '1,1',
  ctx_size: '4096' // set explicitly: auto-fit is disabled in tensor mode
}
```

Splits both the weights and the KV cache across the 2 GPUs via the meta device. `ctx_size` is set explicitly on purpose — without it the context defaults to the model's full trained context, which can OOM on a large model where auto-fit would have trimmed it. Leave `flash-attn` unset (it defaults to `on`); passing `'flash-attn': 'off'` here is rejected with `InvalidArgument`.

### Single GPU (explicit)

```js
const config = {
  device: 'gpu',
  gpu_layers: '999',
  'split-mode': 'none'   // default, can be omitted
}
```

Standard single-GPU inference. The system auto-selects the best available GPU.

### Dedicated GPU only (single GPU)

```js
const config = {
  device: 'gpu',
  gpu_layers: '999',
  'main-gpu': 'dedicated'
}
```

Skips integrated GPUs during backend selection. Falls back to CPU if no discrete GPU is found. `split-mode` defaults to `'none'`.

## Fallback behavior

| Scenario | Result |
|----------|--------|
| `device: 'cpu'` with split params set | All split params silently ignored |
| `device: 'gpu'` but no GPU available | Falls back to CPU; `split-mode` reset to `'none'`, `tensor-split` erased, warning logged |
| `split-mode: 'layer'` or `'tensor'` with any `main-gpu` | `main-gpu` is ignored and a warning is logged. It does not filter the split device list and cannot by itself cause CPU fallback. Every eligible device participates |
| `split-mode: 'none'` with `tensor-split` set | `tensor-split` has no effect (only one GPU is used) |
| Invalid `split-mode` value | Throws `InvalidArgument` error |
| `split-mode: 'row'` | Throws `InvalidArgument` — the mode was removed; the error directs callers to `'layer'` or `'tensor'` |
| `split-mode: 'tensor'` with an unsupported architecture | Throws `InvalidArgument` before loading, naming the architecture and suggesting `'layer'` |
| `split-mode: 'tensor'` with a falsey `flash-attn` (`off`, `disabled`, `false`, `0`, under either spelling) | Throws `InvalidArgument` (qvac-fabric requires flash attention for this mode) |
| `split-mode: 'tensor'` on Android / iOS | Throws `InvalidArgument` — all multi-GPU params are rejected on mobile |
| `split-mode: 'tensor'` with `ctx_size` unset | Loads at the model's full trained context; auto-fit is disabled in this mode, so a large model can OOM |
| `split-mode: 'tensor'` with `fit: 'on'` | `fit` is ignored — the tensor-mode override is applied after argument parsing, because qvac-fabric cannot fit this mode at all |
| `split-mode: 'tensor'` on a discrete + integrated GPU host | Only the discrete GPUs participate; the addon passes an explicit `--device` list because qvac-fabric's tensor path would otherwise include the iGPU |
| `split-mode: 'layer'` or `'tensor'` with no eligible GPU device | Falls back to CPU with a warning naming the rejected devices. `split-mode` is reset to `'none'`, `main-gpu` to `-1`, `tensor-split` is erased, and `--device none` is emitted. An empty device list is never passed to qvac-fabric, which treats it as a hard error in tensor mode |
| `tensor-split` with a value count matching neither the registered GPU count nor the eligible device count | Throws `InvalidArgument` rather than letting qvac-fabric silently pad with zeros, which would leave a participating GPU with no layers |
| `split-mode: 'tensor'` through the SDK | Rejected by `@qvac/inference`'s Zod schema, which does not yet include `'tensor'`; use direct addon `loadModel` |
| Both `split-mode` and `split_mode` provided | Throws `InvalidArgument` error |
| Both `main-gpu` and `main_gpu` provided | Throws `InvalidArgument` error |

## Benchmarking

Use the multi-GPU benchmark example to compare split strategies:

```bash
bare examples/multiGpuBenchmark.js [options]
```

Options:
- `--tensor-split=1,1` — GPU split proportions (default: `1,1`)
- `--runs=5` — measured runs per mode
- `--warmup=2` — warmup runs per mode
- `--ctx-size=4096` — context size
- `--gpu-layers=999` — layers to offload

The benchmark runs all three modes (none, layer, tensor) on the same model and prints a comparison summary with TTFT and TPS metrics.

## Choosing a split strategy

| Factor | `layer` (pipeline) | `tensor` (meta device) |
|--------|-------------------|------------------------|
| GPU interconnect | Works over PCIe | Benefits from NVLink / fast PCIe |
| Latency | Higher per-token (sequential pipeline) | Lower per-token (parallel computation) |
| Throughput | Good for large batches | Good for interactive / low-latency |
| VRAM distribution | Even if layers are uniform | Even split of every layer, KV cache included |
| Complexity | Simpler scheduling | Requires cross-GPU communication per layer |
| Backend support | All backends | All backends, via the meta device |
| Maturity | Stable | **EXPERIMENTAL**; upstream vouches for it mainly on multi-GPU CUDA |
| Auto-fit | Supported | **Not available** — set `ctx_size` explicitly |

**Start with `layer` and an equal `tensor-split`** — it is the compatible, mature default and the only one that works on mobile. Reach for `tensor` when single-stream latency matters more than throughput and you have a fast interconnect, and measure it against `layer` on your own hardware before committing: none of the shipped backends has a tuned all-reduce, so the win is not a given.
