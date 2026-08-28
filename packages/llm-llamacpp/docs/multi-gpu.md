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
| `'row'`  | **Legacy tensor parallelism. Accepted, but not effective on any shipped backend.** Degraded to `'layer'` at load with a warning, because no backend this package ships provides the split buffers row-split requires. **See [two kinds of tensor parallelism](#two-kinds-of-tensor-parallelism) below.** |
| `'tensor'`| **EXPERIMENTAL tensor parallelism** via qvac-fabric's meta device — weights *and* KV cache are split across every visible GPU. Desktop only. Requires flash attention, disables auto-fit, and is unavailable for some architectures. **See [two kinds of tensor parallelism](#two-kinds-of-tensor-parallelism) below.** |

Accepts both `split-mode` (hyphen) and `split_mode` (underscore). Providing both throws an error. Case-insensitive (`'LAYER'` works).

#### Two kinds of tensor parallelism

`row` and `tensor` are two different mechanisms with the same goal. Only `tensor` works on the backends this package ships.

**`row` — split buffers (legacy, never effective here).** Row-split requires a "split buffer" that slices each weight tensor across GPUs, exposed by a backend as `ggml_backend_split_buffer_type`. As of **qvac-fabric v10069, only the SYCL backend provides it** — CUDA dropped split buffers and moved tensor parallelism to a separate `LLAMA_SPLIT_MODE_TENSOR`. Vulkan, Metal and OpenCL never provided it.

This package ships Metal (Apple), Vulkan (Linux/Windows/Android), OpenCL (Android) and optionally HIP — **none of them, so `split-mode: 'row'` is never effective in a shipped build.**

**`tensor` — the meta device (supported, experimental).** `split-mode: 'tensor'` selects `LLAMA_SPLIT_MODE_TENSOR`, which distributes the model through qvac-fabric's meta-device abstraction instead of split buffers. It needs no backend-specific buffer type, so it is available on every shipped backend. Three constraints apply:

- **Flash attention is mandatory.** qvac-fabric fails context creation without it, so the addon rejects `flash-attn: 'off'` together with `split-mode: 'tensor'` up front (`InvalidArgument`). Leaving `flash-attn` unset is fine — it already defaults to `on`.
- **Auto-fit is disabled.** qvac-fabric's memory fitting is not implemented for this mode, so the addon turns it off explicitly and logs an INFO line. `gpu_layers` then defaults to every layer and `ctx_size` to the model's trained context. **Set `ctx_size` explicitly for large models**, or the load can OOM where auto-fit would have trimmed the context.
- **Not every architecture is supported.** qvac-fabric implements the tensor split per architecture; unsupported ones are rejected before loading with the architecture named. Mamba/Jamba-family, BitNet, Grok, T5, DeepSeek-V2/3.2/4, MiniMax, Qwen3-Next/3.5 and several others are excluded as of v10297.0.0. Common dense and MoE architectures (`llama`, `qwen2`, `qwen3`, `qwen3moe`, `gemma2`, `gemma3`, `phi3`, `mistral3`) are supported. Note the architecture names are the GGUF `general.architecture` values, not model marketing names — most Mistral GGUFs report `llama`, and `mistral4` is on the unsupported list.

**Device selection is pinned explicitly.** `layer` and `row` omit `--device` and let qvac-fabric pick, which is safe because its filtered selection path excludes integrated GPUs when discrete ones exist and deduplicates a physical GPU registered by two backends. `LLAMA_SPLIT_MODE_TENSOR` takes a different path in qvac-fabric that does neither — left to itself it would split weights and the KV cache onto the iGPU of any discrete + integrated host, pacing the whole model by the weakest participant, and would shard a dual-registered GPU (Vulkan + HIP under `GGML_BACKEND_DL`) twice. The addon therefore enumerates the devices itself for tensor mode and passes an explicit `--device` list: discrete GPUs when any are present, otherwise the integrated ones, deduplicated by device description. `main-gpu` still cannot select among them — qvac-fabric's `main_gpu` pruning is gated on `split-mode: 'none'`.

**`'tensor'` is not selectable through the SDK.** `@qvac/inference`'s `llamacppCompletionConfigSchema` still enumerates `'none' | 'layer' | 'row'`, so an SDK `loadModel` call with `'tensor'` fails Zod validation before it reaches the addon. For now the mode is reachable only through direct addon `loadModel`. Widening the SDK schema is separate SDK-pod work.

qvac-fabric documents `LLAMA_SPLIT_MODE_TENSOR` as **EXPERIMENTAL** and expects good performance primarily on multi-GPU CUDA. CUDA is not shipped here, and none of the shipped backends provide a tuned all-reduce — they use the meta backend's generic fallback reduction. It is correct, but do not assume it is faster than `layer` without measuring.

Two things changed in the v10069 rebase:

- qvac-fabric no longer silently treats `row` as `layer` on a backend without split buffers; it **fails the model load** with `device <name> does not support split buffers`.
- So the addon now degrades `row` → `layer` itself before loading, and logs a `WARNING`. Models keep loading, and `row` keeps behaving like `layer` as before — but the fallback is now explicit and logged rather than implicit in qvac-fabric.

The degrade requires *every* GPU device to lack split buffers to be skipped, matching what qvac-fabric checks: it builds a split buffer for each device it distributes over and throws on the first one that cannot. A single unsupported backend registered in the process is enough.

The `row` degrade applies to both inference and finetuning. Between `layer` and `row` alone, only pipeline (layer) parallelism is effective — `tensor` is the route to real tensor parallelism here.

| Backend | `'layer'` | `'row'` | `'tensor'` |
|---------|-----------|---------|------------|
| SYCL (not shipped) | Layer parallelism | True tensor parallelism (split buffers) | Meta device, generic all-reduce |
| CUDA (not shipped) | Layer parallelism | Degraded to layer parallelism — split buffers dropped at v10069 | Meta device, backend-specific all-reduce (the tuned path upstream vouches for) |
| Vulkan  | Layer parallelism | Degraded to layer parallelism | Meta device, generic all-reduce |
| Metal   | Layer parallelism | Degraded to layer parallelism | Meta device, generic all-reduce |
| OpenCL  | Layer parallelism | Degraded to layer parallelism | Meta device, generic all-reduce |
| HIP     | Layer parallelism | Degraded to layer parallelism | Meta device, generic all-reduce |

"Generic all-reduce" means the meta backend reduces with ordinary ggml graph ops rather than a backend-native collective. Every backend shipped here takes that path.

### `tensor-split`

A comma-separated string of proportions that control how much of the model each GPU receives.

```
'tensor-split': '1,1'     // equal 50/50 split across 2 GPUs
'tensor-split': '3,1'     // 75% on GPU 0, 25% on GPU 1
'tensor-split': '2,2,1'   // 40/40/20 across 3 GPUs
```

The values are relative weights, not absolute sizes. qvac-fabric normalizes them internally so `'1,1'` and `'50,50'` produce the same result.

- In `layer` mode: controls how many layers are assigned to each GPU (proportional to the weights).
- In `row` mode: only the layer assignment applies, since `row` is degraded to `layer` on every shipped backend (same as `layer` mode). On a split-buffer backend it would also control the row-wise split ratio within each layer's weight tensors.
- When `split-mode` is `'none'` (or omitted): `tensor-split` has no effect since only one GPU is used.

### `main-gpu`

Selects which GPU to use. The behavior depends on the split mode:

| Split mode | `main-gpu` role |
|------------|----------------|
| `'none'`   | Picks the **sole GPU** for the entire model. |
| `'row'`    | Selects the GPU for **intermediate results and KV cache** (per qvac-fabric CLI documentation). |
| `'layer'`  | Not used by qvac-fabric for layer distribution. |

In the qvac addon, `main-gpu` also influences **backend selection** (choosing between integrated and dedicated GPUs) before the split-mode logic runs.

| Value | Behavior |
|-------|----------|
| integer (e.g. `'0'`, `'1'`) | Select GPU by device index. Forwarded to qvac-fabric as `--main-gpu`. |
| `'integrated'` | Filter to integrated GPUs only during backend selection. In multi-GPU split modes, still affects backend selection (may cause CPU fallback if no matching GPU exists) but is **not forwarded** to qvac-fabric as `--main-gpu` (warning logged). Use an integer device index instead. |
| `'dedicated'`  | Filter to dedicated GPUs only during backend selection. In multi-GPU split modes, still affects backend selection (may cause CPU fallback if no matching GPU exists) but is **not forwarded** to qvac-fabric as `--main-gpu` (warning logged). Use an integer device index instead. |

Accepts both `main-gpu` (hyphen) and `main_gpu` (underscore). Providing both throws an error. The string values are case-insensitive.

**In `none` mode:** `main-gpu` selects the GPU for the entire model. Integer values pick by device index; `'integrated'`/`'dedicated'` filter by GPU type during [backend selection](#interaction-with-device-and-backend-selection).

**In `row` mode:** `main-gpu` (integer only) selects the GPU for intermediate results and KV cache. The `'integrated'`/`'dedicated'` string values still filter the device list during backend selection (which may cause CPU fallback if no matching GPU type exists), but are not forwarded to qvac-fabric as `--main-gpu`. A warning is logged — use an integer device index instead.

**In `layer` mode:** `main-gpu` has no effect on layer distribution — placement is controlled entirely by `tensor-split`. As with `row` mode, `'integrated'`/`'dedicated'` still affect backend selection but are not forwarded to qvac-fabric.

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
                        └── split-mode = 'layer' | 'row' | 'tensor'
                            --device is NOT passed (so qvac-fabric sees all GPUs)
                            tensor-split proportions forwarded as --tensor-split
                            main-gpu (integer only) forwarded as --main-gpu
                              row: selects GPU for intermediate results and KV
                              layer: not used for placement
                            tensor: additionally requires flash-attn on and a
                              supported architecture; auto-fit is disabled
```

### Interaction with `device` and backend selection

The `device` parameter is always required and is consumed first. When set to `'gpu'`:

1. **Backend selection** runs to detect available GPU backends (Vulkan, Metal, OpenCL, etc.)
2. `main-gpu` influences this selection: `'dedicated'` filters to discrete GPUs, `'integrated'` filters to iGPUs, an integer index selects a specific device
3. If no GPU is found, the system falls back to CPU and clears all split parameters

After backend selection, the split-mode determines the forwarding strategy:

- **`split-mode: 'none'`** (or omitted): the chosen backend name is passed as `--device <backend>`, pinning inference to that single GPU.
- **`split-mode: 'layer'` or `'row'`**: `--device` is intentionally **not** passed. This lets qvac-fabric discover all available GPUs and distribute the model according to `tensor-split`.

### Why `--device` is omitted in split modes

When a split mode is active, passing `--device` would pin all computation to the single backend that `chooseBackend()` selected, defeating the purpose of multi-GPU. By omitting it, qvac-fabric's own device enumeration distributes layers or rows across all visible GPU backends.

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

### Two-GPU unequal split (`row` requested, degraded to `layer`)

```js
const config = {
  device: 'gpu',
  gpu_layers: '999',
  'split-mode': 'row',
  'tensor-split': '3,1'
}
```

On every shipped backend this behaves identically to `'layer'` with the same proportions, and logs the degrade warning. On a split-buffer backend it would split each layer's weight matrix 75/25 across 2 GPUs, with both GPUs computing every layer in parallel and GPU 0 handling the larger portion.

### Row split with main-gpu

```js
const config = {
  device: 'gpu',
  gpu_layers: '999',
  'split-mode': 'row',
  'tensor-split': '1,1',
  'main-gpu': '0'
}
```

`main-gpu` designates GPU 0 for intermediate results and KV cache. On a split-buffer backend weight tensors would also be split row-wise across the 2 GPUs; on every shipped backend the request is degraded to `layer`.

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
| `split-mode: 'layer'` with `main-gpu: 'dedicated'` | `'dedicated'`/`'integrated'` still filters the device list during backend selection — on an iGPU-only system this causes CPU fallback (split-mode reset, tensor-split erased). If a matching GPU is found, a warning is logged and the string value is not forwarded to qvac-fabric; use an integer index |
| `split-mode: 'none'` with `tensor-split` set | `tensor-split` has no effect (only one GPU is used) |
| Invalid `split-mode` value | Throws `InvalidArgument` error |
| `split-mode: 'tensor'` with an unsupported architecture | Throws `InvalidArgument` before loading, naming the architecture and suggesting `'layer'` |
| `split-mode: 'tensor'` with `flash-attn: 'off'` | Throws `InvalidArgument` (qvac-fabric requires flash attention for this mode) |
| `split-mode: 'tensor'` on Android / iOS | Throws `InvalidArgument` — all multi-GPU params are rejected on mobile |
| `split-mode: 'tensor'` with `ctx_size` unset | Loads at the model's full trained context; auto-fit is disabled in this mode, so a large model can OOM |
| `split-mode: 'tensor'` with `fit: 'on'` | `fit` is ignored — the tensor-mode override is applied after argument parsing, because qvac-fabric cannot fit this mode at all |
| `split-mode: 'tensor'` on a discrete + integrated GPU host | Only the discrete GPUs participate; the addon passes an explicit `--device` list because qvac-fabric's tensor path would otherwise include the iGPU |
| `split-mode: 'tensor'` with no enumerable GPU device | Falls back to qvac-fabric's own device selection with a warning, rather than passing an empty `--device` |
| `split-mode: 'tensor'` through the SDK | Rejected by `@qvac/inference`'s Zod schema, which still enumerates `none`/`layer`/`row`; use direct addon `loadModel` |
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

The benchmark runs all four modes (none, layer, row, tensor) on the same model and prints a comparison summary with TTFT and TPS metrics. Note that `row` is degraded to `layer` on every shipped backend, so its numbers should match the `layer` row.

## Choosing a split strategy

The `row` column describes what tensor parallelism would give on a split-buffer backend; it is kept for reference, not as available behaviour.

| Factor | `layer` (pipeline) | `row` (legacy tensor) | `tensor` (meta device) |
|--------|-------------------|----------------|------------------------|
| GPU interconnect | Works over PCIe | Benefits from NVLink / fast PCIe | Benefits from NVLink / fast PCIe |
| Latency | Higher per-token (sequential pipeline) | Lower per-token (parallel computation) | Lower per-token (parallel computation) |
| Throughput | Good for large batches | Good for interactive / low-latency | Good for interactive / low-latency |
| VRAM distribution | Even if layers are uniform | Even split of every layer | Even split of every layer, KV cache included |
| Complexity | Simpler scheduling | Requires cross-GPU communication per layer | Requires cross-GPU communication per layer |
| Backend support | All backends | **SYCL only** (not shipped) — every shipped backend degrades to layer mode | All backends, via the meta device |
| Maturity | Stable | Stable where available | **EXPERIMENTAL**; upstream vouches for it mainly on multi-GPU CUDA |
| Auto-fit | Supported | Supported | **Not available** — set `ctx_size` explicitly |

**Start with `layer` and an equal `tensor-split`** — it is the compatible, mature default and the only one that works on mobile. Reach for `tensor` when single-stream latency matters more than throughput and you have a fast interconnect, and measure it against `layer` on your own hardware before committing: none of the shipped backends has a tuned all-reduce, so the win is not a given. `row` can still be set but is degraded to `layer` at load with a warning — see [two kinds of tensor parallelism](#two-kinds-of-tensor-parallelism).
