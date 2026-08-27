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
| `'layer'`| **Layer split.** Each transformer layer is assigned to a device. The scheduler may additionally overlap micro-batches between devices — see [pipeline parallelism](#pipeline-parallelism) — but only when every participating device supports async compute and events. Best for large batch or long-context workloads where layer count exceeds single-GPU VRAM. |
| `'tensor'`| **Tensor parallelism.** Each weight is sharded across devices and all-reduces are inserted, so every device works on the same tokens simultaneously. Requires a supported architecture, flash attention enabled, and a non-quantized KV cache — the load **fails** if any is unmet. Communication is far more frequent than layer split, so it wants a fast interconnect. |
| `'row'`  | **Deprecated, superseded by `'tensor'`.** Accepted but not effective on any shipped backend: degraded to `'layer'` at load with a warning, because no backend this package ships provides the split buffers row-split requires. **See [backend limitations](#why-row-is-never-effective) below.** |

> **Note:** `'row'` and `'tensor'` are different mechanisms, not aliases. `'row'`
> is the legacy split-buffer path described below; `'tensor'` is the current
> implementation and is unaffected by the split-buffer limitation.

Accepts both `split-mode` (hyphen) and `split_mode` (underscore). Providing both throws an error. Case-insensitive (`'LAYER'` works).

> **`'tensor'` has no memory-fit safety net.** qvac-fabric's memory-fit
> preflight (`fit_params`, on by default — there is no config key here to turn
> it off) does not support `SPLIT_MODE_TENSOR`. It fails internally, and
> qvac-fabric's own caller silently discards that failure and proceeds to load
> with `gpu_layers`/`ctx_size`/`tensor-split` exactly as configured, with no
> check against what actually fits across the split devices. A load that logs
> `common_fit_params: ... not implemented for SPLIT_MODE_TENSOR, abort` is
> **not failing** — that line means the fit step was skipped entirely, not
> that anything went wrong yet. An over-provisioned tensor-split load has
> nothing catching it before an OOM or a bad allocation partway through. Size
> `gpu_layers`/`ctx_size` for tensor mode by hand.

### Pipeline parallelism

Under `split-mode: 'layer'`, devices can either take turns (a relay — one busy
at a time) or overlap micro-batches so a later stage works on one ubatch while
an earlier stage starts the next. The overlap is what produces a throughput win.

It engages only when **all** of these hold, and is otherwise disabled **with no
warning** — only the enabled path logs, as `pipeline parallelism enabled`:

- `split-mode` is exactly `'layer'`
- more than one device participates
- `gpu_layers` exceeds the model's total layer count
- KV offload is on and no per-tensor overrides are set
- every non-CPU, non-ACCEL device reports async compute and events

Give it work to overlap: the batch size must exceed the ubatch size, and the
prompt must be long enough to produce several ubatches. A short prompt has
nothing to pipeline even when the feature is on.

To confirm it actually engaged, set `verbosity: '3'` and watch the native log
for `pipeline parallelism enabled`. Do not infer it from throughput alone.

### Why `'row'` is never effective

`'row'` requires a "split buffer" that slices each weight tensor across GPUs, exposed by a backend as `ggml_backend_split_buffer_type`. **Only the SYCL backend provides it** — CUDA dropped split buffers and moved tensor parallelism to a separate `LLAMA_SPLIT_MODE_TENSOR`. Vulkan, Metal and OpenCL never provided it.

That separate mode is what `split-mode: 'tensor'` now exposes, so tensor parallelism **is** available — it simply does not go through `'row'`. Everything below concerns `'row'` only.

This package ships Metal (Apple), Vulkan (Linux/Windows/Android), OpenCL (Android) and optionally HIP — **none of them, so `split-mode: 'row'` is never effective in a shipped build.**

Two things changed in the v10069 rebase:

- qvac-fabric no longer silently treats `row` as `layer` on a backend without split buffers; it **fails the model load** with `device <name> does not support split buffers`.
- So the addon now degrades `row` → `layer` itself before loading, and logs a `WARNING`. Models keep loading, and `row` keeps behaving like `layer` as before — but the fallback is now explicit and logged rather than implicit in qvac-fabric.

The degrade requires *every* GPU device to lack split buffers to be skipped, matching what qvac-fabric checks: it builds a split buffer for each device it distributes over and throws on the first one that cannot. A single unsupported backend registered in the process is enough.

This applies to both inference and finetuning. Only pipeline (layer) parallelism is effective, regardless of the `split-mode` value.

| Backend | `'layer'` | `'row'` |
|---------|-----------|---------|
| SYCL (not shipped) | Layer parallelism | True tensor parallelism (split buffers) |
| CUDA (not shipped) | Layer parallelism | Degraded to layer parallelism — split buffers dropped at v10069 |
| Vulkan  | Layer parallelism | Degraded to layer parallelism |
| Metal   | Layer parallelism | Degraded to layer parallelism |
| OpenCL  | Layer parallelism | Degraded to layer parallelism |
| HIP     | Layer parallelism | Degraded to layer parallelism |

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

## Distributed inference across machines (`rpc-servers`)

The devices a model is split across need not be local. `rpc-servers` attaches
remote GPUs exposed by `ggml-rpc-server` processes, letting one model run across
several machines — for a model too large for any single box, or to add
throughput. Every `split-mode` above applies unchanged to remote devices.

```js
const model = new LlmLlamacpp({
  files: { model: [modelPath] },
  config: {
    device: 'gpu',
    'rpc-servers': '10.0.0.1:50052,10.0.0.2:50052',
    devices: 'RPC0,RPC1',
    'split-mode': 'layer',
    'tensor-split': '1,1',
    gpu_layers: '999'
  }
})
```

On each worker machine:

```bash
ggml-rpc-server -H 0.0.0.0 -p 50052 -d MTL0   # -d takes a ggml device name
```

### `devices`

Remote devices are named `RPC0`, `RPC1`, … in the order given to `rpc-servers`.

Set `devices` to name exactly which ones take part. Without it, split modes
distribute across *every* visible device — sensible for local multi-GPU, but
rarely what you want here, because the registry then mixes local and remote.

Automatic backend selection never considers RPC devices on its own — it can't
reason about whether a remote device is reachable or suitable the way it can
for local hardware. **On a machine with no local GPU, `rpc-servers` without
`devices` fails the load** rather than silently running the model on the local
CPU. Set `devices` in that case (e.g. `'RPC0,RPC1'`).

### Requirements and caveats

- **Matching builds.** The RPC wire protocol is versioned. Client and every
  server must be built from the same qvac-fabric revision; mismatched builds
  refuse to connect.
- **Model file.** Needed only on the machine loading it. Weights are pushed to
  the remote devices.
- **Reachability at load.** Every endpoint must be reachable when the model
  loads. An unreachable one fails the load naming that endpoint rather than
  being skipped — connection attempts time out after ~5s.
- **Unauthenticated.** The channel has no authentication or encryption. Use it
  only on a trusted private network.
- **One server per pipeline stage.** A server handles one client connection
  serially, so devices behind the same server process are not pipelined against
  each other.
- **Not supported on mobile.** Rejected at load on Android and iOS.

### Verifying it actually distributed

A run that produces correct text is *not* evidence the model was distributed —
if remote devices are dropped, the load quietly falls back to local execution
and still generates fine. Set `verbosity: '3'` and check the native log for
per-layer placement:

```
load_tensors: layer   0 assigned to device RPC0
load_tensors: layer   9 assigned to device RPC1
```

## How the parameters interact

```
rpc-servers ──> Remote devices registered FIRST, so the steps below see them
  │              alongside local ones (RPC0, RPC1, ... in the order given)
  ▼
device ─── 'cpu' ──> All GPU params ignored, CPU inference
  │
  └── 'gpu' ──> Backend selection runs (considers main-gpu)
                  │
                  ├── No GPU found ──> CPU fallback
                  │   split-mode, tensor-split, main-gpu all cleared
                  │
                  └── GPU found
                        │
                        ├── devices = 'RPC0,RPC1' (any split-mode)
                        │   Passed through verbatim as --device; the two
                        │   branches below do not apply
                        │
                        ├── split-mode = 'none' (default)
                        │   Model pinned to single chosen GPU via --device
                        │   tensor-split has no effect
                        │
                        └── split-mode = 'layer' | 'row' | 'tensor'
                            --device is NOT passed (qvac-fabric sees every
                              device, local and remote alike)
                            tensor-split proportions forwarded as --tensor-split
                            main-gpu (integer only) forwarded as --main-gpu
                              row: selects GPU for intermediate results and KV
                              layer/tensor: not used for placement
```

### Interaction with `device` and backend selection

The `device` parameter is always required and is consumed first. When set to `'gpu'`:

1. **Backend selection** runs to detect available GPU backends (Vulkan, Metal, OpenCL, etc.)
2. `main-gpu` influences this selection: `'dedicated'` filters to discrete GPUs, `'integrated'` filters to iGPUs, an integer index selects a specific device
3. If no GPU is found, the system falls back to CPU and clears all split parameters

After backend selection, the split-mode determines the forwarding strategy:

- **`devices` set** (any split-mode): the list is passed through verbatim as `--device`, and the two rules below do not apply. This is the only way to constrain which devices take part while a split mode is active.
- **`split-mode: 'none'`** (or omitted): the chosen backend name is passed as `--device <backend>`, pinning inference to that single GPU.
- **`split-mode: 'layer'`, `'row'` or `'tensor'`**, with no `devices`: `--device` is intentionally **not** passed. This lets qvac-fabric discover all available devices and distribute the model according to `tensor-split`.

### Why `--device` is omitted in split modes

When a split mode is active, passing the single backend that `chooseBackend()` selected would pin all computation to it, defeating the purpose. Omitting it lets qvac-fabric's own enumeration distribute across every visible device.

That default assumes every visible device is one you want to use — true for local multi-GPU, but not once `rpc-servers` has added remote devices to the same registry. Set `devices` to name the participants explicitly in that case.

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

The `row` column describes what tensor parallelism would give on a split-buffer backend; it is kept for reference, not as available behaviour.

| Factor | `layer` (pipeline) | `row` (tensor) |
|--------|-------------------|----------------|
| GPU interconnect | Works over PCIe | Benefits from NVLink / fast PCIe |
| Latency | Higher per-token (sequential pipeline) | Lower per-token (parallel computation) |
| Throughput | Good for large batches | Good for interactive / low-latency |
| VRAM distribution | Even if layers are uniform | Even split of every layer |
| Complexity | Simpler scheduling | Requires cross-GPU communication per layer |
| Backend support | All backends | **SYCL only** (not shipped) — every shipped backend degrades to layer mode |

`row` can be set but is degraded to `layer` at load with a warning — see [above](#why-row-is-never-effective). Use `tensor` instead when you want tensor parallelism and the model's architecture supports it.

Start with `layer` mode and equal `tensor-split`. Reach for `tensor` when generation latency matters more than prompt throughput and the devices have a fast interconnect; the per-op all-reduces make it sensitive to link speed.
