# System resources support matrix

`getSystemResources` reports observations from `bare-cpu-info` and
`bare-gpu-info`. A `supported` metric means that the collector returned a value
which passed SDK normalization. It does not guarantee that a model fits, reserve
resources, or prove equivalent semantics on every operating system or device.

## Evidence levels

Packaging and runtime evidence are separate:

| Target         | Collector prebuilds               | Runtime evidence               |
| -------------- | --------------------------------- | ------------------------------ |
| `darwin-arm64` | Present                           | Local Bare run on Apple M4 Pro |
| `darwin-x64`   | Present                           | Not run                        |
| `linux-arm64`  | Present                           | Not run                        |
| `linux-x64`    | Present                           | Not run                        |
| `win32-arm64`  | Present                           | Not run                        |
| `win32-x64`    | Present                           | Not run                        |
| Android        | Not in the desktop packaging gate | No physical-device acceptance  |
| iOS            | Not in the desktop packaging gate | No physical-device acceptance  |

The desktop packaging gate verified that both collector addons were in the
linked worker graph and addon manifest, that each listed desktop target had
prebuilds, and that their packaged size stayed within the configured budgets.
The 2 MiB compressed and 5 MiB uncompressed budgets are release ceilings for catching accidental packaging expansion, not fine-grained size regression thresholds.
Prebuild presence is compile and packaging evidence only; it does not prove that
a metric works on target hardware.

The `darwin-arm64` runtime observation exercised collector initialization,
capability queries, sampling, schema validation, and teardown on the current
development host. It is not a general physical-device support claim. Android
and iOS remain without runtime support claims until physical-device acceptance
is recorded.

## Status semantics

Every metric uses one of the public schema statuses:

- `supported`: a value passed normalization and includes `provenance`.
- `unavailable`: the native collector returned no value for that metric.
- `unverified`: a value was present but failed normalization, or its meaning or
  scope could not be verified.
- `failed`: the collector module, initialization, inventory query, or sample
  operation failed.

An unavailable individual field does not fail its enclosing CPU or GPU
observation. If GPU enumeration succeeds and finds no devices, `gpus` is
`supported` with an empty array. That is a supported observation, not a
collector failure.

## Source and scope

The exact collector source strings are `bare-cpu-info`, `bare-gpu-info`, and
`bare-os` (the process-scoped memory metrics).
When present, scope is one of `system`, `process`, `device`, `budget`, or
`shared-system`. Scope is optional: the current collector omits it where the
native value does not establish one, rather than inventing a scope.

## Metric behavior

| Public metric                                | Accepted value                              | Source and scope when `supported`                                          | Current runtime evidence                                                                                    |
| -------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `capabilities.cpu.value.logicalCores`        | Positive integer                            | `bare-cpu-info`; scope omitted                                             | `supported` on `darwin-arm64`                                                                               |
| `sample.cpu`                                 | Number from 0 through 1                     | `bare-cpu-info`; `system`                                                  | `supported` on `darwin-arm64`                                                                               |
| `capabilities.memory.totalBytes`             | Positive integer                            | `bare-cpu-info`; `system`                                                  | `supported` on `darwin-arm64`                                                                               |
| `sample.memory.usedBytes`                    | Non-negative integer                        | `bare-cpu-info`; `system`                                                  | `supported` on `darwin-arm64`                                                                               |
| `sample.memory.totalBytes`                   | Positive integer                            | `bare-cpu-info`; `system`                                                  | `supported` on `darwin-arm64`                                                                               |
| `sample.memory.processUsedBytes`             | Non-negative integer                        | `bare-os`; `process`                                                       | `supported` where `bare-os` reports RSS                                                                     |
| `sample.memory.processAvailableBytes`        | Non-negative integer                        | `bare-os`; `process`                                                       | `unavailable` everywhere — iOS needs a native `os_proc_available_memory` source before this reports a value |
| `capabilities.gpus`                          | Array, including an empty array             | `bare-gpu-info`; scope omitted                                             | `supported` with one GPU on `darwin-arm64`                                                                  |
| `capabilities.gpus.value[].memoryTotalBytes` | Non-negative number                         | `bare-gpu-info`; `device`, when not unified memory                         | `unverified` on `darwin-arm64` (unified)                                                                    |
| `sample.gpus`                                | Array aligned with the cached GPU inventory | `bare-gpu-info`; scope omitted                                             | `supported` with one GPU sample on `darwin-arm64`                                                           |
| `sample.gpus.value[].compute`                | Number from 0 through 1                     | `bare-gpu-info`; `device`                                                  | `supported` on `darwin-arm64`                                                                               |
| `sample.gpus.value[].encode`                 | Number from 0 through 1                     | `bare-gpu-info`; `device`                                                  | `unavailable` on `darwin-arm64`                                                                             |
| `sample.gpus.value[].decode`                 | Number from 0 through 1                     | `bare-gpu-info`; `device`                                                  | `unavailable` on `darwin-arm64`                                                                             |
| `sample.gpus.value[].memoryUsedBytes`        | Non-negative number                         | `bare-gpu-info`; `device`, when the sample agrees with the declared memory | `unverified` on `darwin-arm64` (unified)                                                                    |
| `sample.gpus.value[].memoryTotalBytes`       | Non-negative number                         | `bare-gpu-info`; `device`, when the sample agrees with the declared memory | `unverified` on `darwin-arm64` (unified)                                                                    |
| `sample.gpus.value[].powerWatts`             | Non-negative number                         | `bare-gpu-info`; `device`                                                  | `unavailable` on `darwin-arm64`                                                                             |
| `sample.gpus.value[].temperatureCelsius`     | Non-negative number                         | `bare-gpu-info`; `device`                                                  | `unavailable` on `darwin-arm64`                                                                             |

For GPU memory, a missing native value becomes `unavailable`. The native API
does not identify the scope of a present value, so the SDK establishes it
itself, per device, and reports `unverified` wherever it cannot:

- A GPU that reports `unifiedMemory` is never device-scoped — its allocation is
  system RAM, which the memory budget already accounts for. Apple readings are
  `unverified` for this reason, and are a working-set recommendation rather
  than a device pool (an M4 Max reports 81% of system RAM).
- On Windows the values come from DXGI's `QueryVideoMemoryInfo` — `CurrentUsage`
  and `Budget`, which are what this process uses and may use. They are reported
  under the `budget` scope rather than discarded: what a process is allowed to
  allocate is what an admission decision needs. They are not device totals, and
  on an idle machine `Budget` is indistinguishable from VRAM, so no value-level
  check can separate them.
- Otherwise a sample is trusted as `device` only when its total agrees with the
  memory the device declares for itself, within 10%. A discrete card agrees
  (measured 1.00 and 0.96); an Intel iGPU declares 128 MiB and samples half of
  system RAM, because it is reporting the shared pool.

Declared memory (`capabilities`) is therefore `supported` on any non-unified
GPU, while the per-sample readings additionally require that agreement.

## Platform limitations

- On Windows, the upstream CPU collector documents that per-core sampling covers
  only the first processor group, at most 64 logical processors. The SDK exposes
  aggregate CPU usage without processor-group coverage metadata, so systems
  with more than 64 logical processors are not validated as whole-system
  observations.
- Apple GPU memory is unified with system RAM and can fall back to process-local
  allocation without exposing which path produced the value. GPU total and used
  memory therefore remain `unverified` there.
- GPU compute, encode, decode, power, and temperature depend on OS and driver
  telemetry. Missing native readings become `unavailable`; desktop prebuild
  presence does not change that status.
- A successful empty GPU inventory means no GPU was enumerated. It should not be
  interpreted as a failed collector or as proof that the machine has no GPU.
- Driver names, versions, and graphics API flags are passive observations. They
  cannot establish backend compatibility. Only a machine-readable addon probe
  may report `compatible` or `incompatible`; missing evidence remains
  `unknown`.
