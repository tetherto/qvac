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
| `'row'`  | **Tensor parallelism if supported by the backend.** On CUDA/SYCL, each layer's weight matrices are split row-wise across GPUs — all GPUs compute every layer in parallel. On Vulkan/Metal, falls back to layer assignment (same as `'layer'`). **See [backend limitations](#tensor-parallelism-on-vulkan) below.** |

Accepts both `split-mode` (hyphen) and `split_mode` (underscore). Providing both throws an error. Case-insensitive (`'LAYER'` works).

#### Tensor parallelism on Vulkan

True tensor parallelism (`row` mode) requires a "split buffer" that slices each weight tensor across GPUs. Only **CUDA** and **SYCL** backends implement split buffers. **Vulkan and Metal do not**, so `split-mode: 'row'` falls back to layer assignment on those backends — behaving identically to `split-mode: 'layer'`.

This applies to both inference and finetuning. On Vulkan and Metal, only pipeline (layer) parallelism is effective regardless of the `split-mode` value.

| Backend | `'layer'` | `'row'` |
|---------|-----------|---------|
| CUDA    | Layer parallelism | True tensor parallelism (split buffers) |
| SYCL    | Layer parallelism | True tensor parallelism (split buffers) |
| Vulkan  | Layer parallelism | Falls back to layer parallelism |
| Metal   | Layer parallelism | Falls back to layer parallelism |

### `tensor-split`

A comma-separated string of proportions that control how much of the model each GPU receives.

```
'tensor-split': '1,1'     // equal 50/50 split across 2 GPUs
'tensor-split': '3,1'     // 75% on GPU 0, 25% on GPU 1
'tensor-split': '2,2,1'   // 40/40/20 across 3 GPUs
```

The values are relative weights, not absolute sizes. qvac-fabric normalizes them internally so `'1,1'` and `'50,50'` produce the same result.

- In `layer` mode: controls how many layers are assigned to each GPU (proportional to the weights).
- In `row` mode on CUDA/SYCL: controls both layer assignment **and** the row-wise split ratio within each layer's weight tensors. On Vulkan/Metal, only the layer assignment applies (same as `layer` mode).
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
                        └── split-mode = 'layer' | 'row'
                            --device is NOT passed (so qvac-fabric sees all GPUs)
                            tensor-split proportions forwarded as --tensor-split
                            main-gpu (integer only) forwarded as --main-gpu
                              row: selects GPU for intermediate results and KV
                              layer: not used for placement
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

### Two-GPU unequal split (tensor parallelism, CUDA/SYCL)

```js
const config = {
  device: 'gpu',
  gpu_layers: '999',
  'split-mode': 'row',
  'tensor-split': '3,1'
}
```

On CUDA/SYCL, splits each layer's weight matrix 75/25 across 2 GPUs. Both GPUs compute every layer in parallel, with GPU 0 handling the larger portion. On Vulkan/Metal, this behaves identically to `'layer'` with the same proportions.

### Row split with main-gpu (CUDA/SYCL)

```js
const config = {
  device: 'gpu',
  gpu_layers: '999',
  'split-mode': 'row',
  'tensor-split': '1,1',
  'main-gpu': '0'
}
```

Weight tensors are split row-wise across 2 GPUs (CUDA/SYCL only). GPU 0 is designated for intermediate results and KV cache via `main-gpu`.

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

The benchmark runs all three modes (none, layer, row) on the same model and prints a comparison summary with TTFT and TPS metrics.

## Choosing a split strategy

| Factor | `layer` (pipeline) | `row` (tensor) |
|--------|-------------------|----------------|
| GPU interconnect | Works over PCIe | Benefits from NVLink / fast PCIe |
| Latency | Higher per-token (sequential pipeline) | Lower per-token (parallel computation) |
| Throughput | Good for large batches | Good for interactive / low-latency |
| VRAM distribution | Even if layers are uniform | Even split of every layer |
| Complexity | Simpler scheduling | Requires cross-GPU communication per layer |
| Backend support | All backends (CUDA, SYCL, Vulkan, Metal) | **CUDA/SYCL only** — Vulkan/Metal fall back to layer mode |

For Vulkan and Metal systems, `layer` is the only effective strategy. `row` can be set but behaves identically to `layer`.

For CUDA/SYCL systems with 2 GPUs over NVLink or fast PCIe, `row` mode provides lower per-token latency. Otherwise start with `layer` mode and equal `tensor-split`.
