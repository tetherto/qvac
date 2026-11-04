# Four-platform diffusion evaluation, 3 November 2026

**Research campaign concluded.** This snapshot preserves completed measurements,
rejected experiments and explicit remaining coverage gaps. It does not change
production defaults, engine dependencies, model checkpoints or addon versions.
No PR was opened as part of this research step.

| Platform | Accelerator | API measured | Date |
| --- | --- | --- | --- |
| Linux x64 | NVIDIA GeForce RTX 5090 | CUDA and Vulkan, separate configurations | 3 November |
| Linux arm64, DGX Spark | NVIDIA GB10 | CUDA only, retained historical results | 29 October |
| macOS arm64, Mac Studio | Apple M3 Ultra, 60 GPU cores, 96 GiB unified memory | Metal | 3 November |
| Linux x64, Strix Halo | Ryzen AI MAX+ 395 / Radeon 8060S, gfx1151 | Vulkan/RADV and HIP/ROCm, separate configurations | 3 November |

The [October report](../evaluation-2026-10-29/README.md) measured CUDA on both
NVIDIA platforms. Its Vulkan CI correctness checks were not performance
measurements. Do not attribute this campaign's Vulkan results to Spark.

## Contents

- [REPORT.md](REPORT.md): concise team report with approach counts, one matrix
  per model, measured combinations, quality/memory tradeoffs, method tags,
  implementation effort and release limits. Metrics use one decimal place;
  related settings share an approach group. No comparison images are included.
- `report-content.json`: detailed research record with original-precision
  metrics, individual decision tables, measured and incomplete profiles,
  technical scope, source links and remaining gates.
- `reproduction-records.json`: individually hashed UTF-8 virtual files for
  completed measurements, benchmark inputs, source/checkpoint identities,
  numerical quality comparisons and validation records. Verify each content
  SHA256 when extracting it. Unfinished or invalid probes remain identifiable
  and must not be treated as successful measurements.
- `experiments/`: unapplied focused patches, their source identities and the
  operator tests executed for the recorded experiments. These files do not
  modify the engine packaged with this addon.

Native measurements use published addon 0.33.0, engine
`67fd0f590e8de432e6bb95fb05b0c3fdfdb2a1dd` and GGML
`a4adfcb1304fb05b64473f1fe8d678bbce7a9ce0`. The older isolated H3 experiments
and retained Spark results use separately recorded revisions. Their absolute
times and validation must not be mixed with the pinned-engine experiments.

Warm native request latency, load plus first request, and fresh-process CLI
generation time are distinct metrics. Fresh-process timers can include lazy
checkpoint reads. The first apparent Metal packing speedup was I/O-confounded
and is not an accepted performance gain. Cumulative results require a directly
measured combined profile.

The custom native HIP backend uses the published addon's tensor-name ABI
(`GGML_MAX_NAME=128`). Earlier incompatible native HIP probes are excluded.
Whole-engine CLI experiments have an internally consistent separate ABI.
Mac measurements overlapping another workload are excluded.

## Implementation gate

Enable a profile only for its validated model, API, accelerator and request
envelope, preserving explicit overrides and the current baseline elsewhere.
Higher-memory profiles need a proven capacity check: an unknown fit estimate
does not establish fit. Different APIs can produce different seeded content,
so switching API is not a transparent quality-preserving optimization.

Accepted engine changes still require a focused implementation, temporary
addon overlay validation and the full affected desktop CI matrix. Follow the
engine, separate registry repin and addon PR sequence. Changelog/version work
belongs in a later separate PR. This research snapshot is not release-ready
implementation validation.

Raw media and private operational logs remain outside Git in verified local
evidence storage. No model weights, binaries, credentials or host connection
details are included here. The three November project directories, including
models and build/test files, were removed after archive verification and branch
preservation. Cleanup receipts are included in the reproduction records; no
files outside those project directories were changed by cleanup.

The evidence supports scoped implementation of the selected profiles, not a
release-ready automatic policy. Remaining gaps include clean full-size HIP H3
latency, Strix LTX stability/precision follow-ups, rocWMMA, other Apple capacities,
other model variants and the actual implementation's full desktop CI matrix.
The completed HIP H3 full-size run validates one output pair only. Spark retains
its dated CUDA evidence and was not accessed during this campaign.
