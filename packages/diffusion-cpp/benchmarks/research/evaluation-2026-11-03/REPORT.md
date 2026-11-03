# QVAC diffusion performance: four platforms, six API configurations

**DRAFT - validation in progress**

RTX, Mac and Strix: 3 November 2026. DGX Spark: retained 29 October 2026 measurements at their original revisions. The original RTX and Spark report measured CUDA only. This extension adds RTX Vulkan, Strix Vulkan and HIP/ROCm, and Mac Metal. Vulkan correctness checks in the older CI record were not performance measurements.

Research branch: [codex/diffusion-performance](https://github.com/tetherto/qvac/tree/codex/diffusion-performance). No PR has been opened.

| Platform | System | Accelerator | Measured API | Date |
| --- | --- | --- | --- | --- |
| RTX 5090 | Linux x64 | NVIDIA GeForce RTX 5090 | CUDA, Vulkan | 2026-11-03 |
| DGX Spark | Linux arm64 | NVIDIA GB10 | CUDA | 2026-10-29 |
| Mac Studio | macOS arm64 | Apple M3 Ultra, 60 GPU cores | Metal | 2026-11-03 |
| AMD Strix Halo | Linux x64 | Radeon 8060S, gfx1151 | Vulkan/RADV, HIP/ROCm | 2026-11-03 |

## Reading the results

**V** means tried and measured, not automatically recommended. **Partial** identifies incomplete coverage. **Not checked** is not a pass. Spark cells retain 29 October revisions; all other dated cells retain their stated cohort. A negative latency percentage is faster. Speed ratios compare the stated baseline with the candidate.

- Use the same checkpoint bytes, prompt, seed, dimensions, frame count, sampling steps and output codec within each pair. Different APIs can produce different seeded outputs, so an API switch is a separate choice rather than a transparent optimization.
- Native figures are warm request medians after one excluded warmup per prompt. Fresh-process CLI generation times are a separate experiment. Neither is a cold-boot measurement. Report startup and memory alongside warm speed where a profile trades them off.
- All reported latency tests run one request at a time. They do not establish concurrent serving throughput. Warm-context research CLI tests repeat generation in one engine context and exclude the explicitly marked warmup; they remain separate from both native addon timings and fresh-process CLI timings.
- Validate every output with hashes and full decoded image/video comparisons, including audio samples. Inspect representative native-resolution images/crops or video frame pairs. Numerical similarity and sampled visual inspection do not prove equivalence for all prompts.
- PSNR and SSIM measure agreement with the baseline output, not prompt adherence or an absolute quality score. No improvement in semantic quality, FVD or a blinded human preference score is claimed.
- PSNR around 59 dB means an RMS difference of approximately 0.29 on a 0-255 color-channel scale; it is not a percentage of quality retained. Report maximum channel error, SSIM and visible differences separately.
- Report directly measured combined profiles. Do not multiply separately measured speedups. Small changes within run variation remain neutral or provisional.
- Exclude the Mac runs that overlapped the external workload. Exclude native Strix HIP modules built with the wrong GGML tensor-name ABI; use the corrected GGML_MAX_NAME=128 modules. Whole-engine CLI builds have their own internally consistent ABI.
- Fresh-process stage timers may include lazy checkpoint reads. The initial apparent 5.15% Metal packing gain was confounded by I/O and is not accepted as a compute improvement. The measured decoder stage was slower.

Full per-output numerical comparisons, individual repetitions, source/checkpoint hashes and input configurations are retained in [reproduction-records.json](reproduction-records.json). The structured report is [report-content.json](report-content.json). No comparison pictures are required to use this report.

## 1. MiniMax-H3 FL2VA Q4

A text-to-video model that generates synchronized video and audio. This campaign uses the current QVAC H3 checkpoint set, with short 512 x 288 / 39-frame screens and 960 x 544 / 124-frame confirmations.

### Approach × platform/API results

| Approach and type | RTX 5090 / CUDA | RTX 5090 / Vulkan | DGX Spark GB10 / CUDA (29 Oct) | M3 Ultra / Metal | Strix 8060S / Vulkan | Strix 8060S / HIP | Implement or reject — why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Global flash attention**<br>`[params tuning]` | **V**<br>120.407 -> 113.771 s;  -5.51% latency;  1.058x<br>Visually identical in reviewed outputs; audio exact | **V**<br>103.638 -> 94.686 s;  -8.64% latency;  1.095x<br>Visually identical in reviewed outputs; audio exact | **V - dated**<br>659.693 -> 604.903 s;  -8.31% latency;  1.091x<br>Visually identical in reviewed outputs; audio exact | **V**<br>135.831 -> 100.164 s;  -26.26% latency;  1.356x<br>Visually identical in reviewed outputs; audio exact | **V**<br>101.173 -> 96.131 s;  -4.98% latency;  1.052x<br>Visually identical in reviewed outputs; audio exact | **V**<br>68.679 -> 61.573 s;  -10.35% latency;  1.115x<br>Visually identical in reviewed outputs; audio exact | **RTX 5090 / CUDA:** Recommend a model/API-scoped profile after the final implementation checks; retain the current baseline elsewhere.<br>**RTX 5090 / Vulkan:** Recommend a model/API-scoped profile after the final implementation checks; retain the current baseline elsewhere.<br>**M3 Ultra / Metal:** Provisional until full-size, quality and repeated-request checks complete.<br>**Radeon 8060S / Vulkan:** Provisional until full-size, quality and repeated-request checks complete.<br>**Radeon 8060S / HIP:** Provisional until full-size, quality and repeated-request checks complete.<br>**DGX Spark GB10 / CUDA, 29 Oct:** Retain the dated recommendation; revalidate on the implementation revision. |
| **Minimal SwiGLU + QKV views**<br>`[graph optimization]` | **V - 1/3 prompts**<br>119.697 -> 117.369 s;  -1.94% latency;  1.020x<br>Output byte-exact | **V**<br>116.760 -> 107.940 s;  -7.55% latency;  1.082x<br>Output byte-exact | Not checked | **V**<br>142.645 -> 145.870 s;  +2.26% latency;  0.978x<br>Video/audio differ; parity not established | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **RTX 5090 / CUDA:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged.<br>**RTX 5090 / Vulkan:** Provisional: accept only a reproducible gain with the required quality tier; no automatic enablement from a single screen.<br>**M3 Ultra / Metal:** Reject as the preferred Metal profile: output/audio change and the initial non-FA screen is slower. Keep the original graph.<br>**Radeon 8060S / Vulkan:** Provisional: accept only a reproducible gain with the required quality tier; no automatic enablement from a single screen.<br>**Radeon 8060S / HIP:** Provisional: accept only a reproducible gain with the required quality tier; no automatic enablement from a single screen. |
| **Minimal operations + global FA**<br>`[combined profile]` | **V - 1/3 prompts**<br>119.697 -> 110.573 s;  -7.62% latency;  1.083x<br>Visually identical in reviewed outputs; audio exact | **V**<br>116.760 -> 98.975 s;  -15.23% latency;  1.180x<br>Numerically compared; see quality details | Not checked | **V**<br>142.645 -> 108.140 s;  -24.19% latency;  1.319x<br>Video/audio differ; parity not established | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **RTX 5090 / CUDA:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged.<br>**RTX 5090 / Vulkan:** Provisional pending incremental benefit and output validation.<br>**M3 Ultra / Metal:** Use global FA alone on Metal. Adding the patch measured only 3.8% extra speed with PSNR 37.20 dB and audio SNR 25.18 dB; perceptual audio parity is not established.<br>**Radeon 8060S / Vulkan:** Provisional pending incremental benefit and output validation.<br>**Radeon 8060S / HIP:** Provisional pending incremental benefit and output validation. |
| **Operations added after global FA**<br>`[incremental engine benefit]` | **V - 1/3 prompts**<br>113.102 -> 110.573 s;  -2.24% latency;  1.023x<br>Output byte-exact | Not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged. |
| **Older isolated H3 operations**<br>`[kernel optimization]` | Not checked | Not checked | Not checked | **V**<br>80.180 -> 70.595 s;  -11.95% latency;  1.136x<br>Video/audio differ; parity not established | **V**<br>90.065 -> 84.655 s;  -6.01% latency;  1.064x<br>Output byte-exact | **V**<br>72.410 -> 63.990 s;  -11.63% latency;  1.132x<br>Video/audio differ; parity not established | **M3 Ultra / Metal:** Reject any strict-parity claim when audio changes; otherwise assess the broader backport separately.<br>**Radeon 8060S / Vulkan:** Reject any strict-parity claim when audio changes; otherwise assess the broader backport separately.<br>**Radeon 8060S / HIP:** Reject on HIP: visible video changes and audio SNR only 1.09 dB; speed does not meet the requested quality tier. |
| **Parameter residency**<br>`[memory placement]` | Not checked | Not checked | Not checked | **V**<br>135.831 -> 131.249 s;  -3.37% latency;  1.035x<br>Output byte-exact | **V**<br>101.173 -> 97.740 s;  -3.39% latency;  1.035x<br>Output byte-exact | **V**<br>68.679 -> 68.846 s;  +0.24% latency;  0.998x<br>Output byte-exact | **M3 Ultra / Metal:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation.<br>**Radeon 8060S / Vulkan:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation.<br>**Radeon 8060S / HIP:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation. |
| **SGLang / vLLM comparison**<br>`[runtime choice]` | Not checked | Not checked | **V / partial - dated**<br>Spark SGLang: 604.903 -> 172.799 s;  -71.43% latency;  3.501x<br>Different content; not equivalent | Not checked | Not checked | Not checked | **GB10 / CUDA, 29 Oct:** Separate runtime option, not a drop-in quality-preserving optimization. |
| **2D VAE GEMM control**<br>`[params tuning]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **V**<br>101.173 -> 100.647 s;  -0.52% latency;  1.005x<br>Output byte-exact | **V**<br>68.679 -> 69.237 s;  +0.81% latency;  0.992x<br>Output byte-exact | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / HIP:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Metal commands per buffer: 2**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Metal commands per buffer: 4**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Metal serial encoding**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Vulkan host-memory selection**<br>`[memory placement]` | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | **V**<br>101.173 -> 102.655 s;  +1.46% latency;  0.986x<br>Output byte-exact | Not applicable to this API | **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Vulkan synchronized submits**<br>`[scheduling tuning]` | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | **V**<br>101.173 -> 100.957 s;  -0.21% latency;  1.002x<br>Output byte-exact | Not applicable to this API | **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **HIP rocWMMA attention after global FA**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Decide from diffusion results; published LLM results are not a diffusion validation. |
| **HIP force-blas**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. |
| **HIP force-mmq**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. |
| **Memory-mapped checkpoint reads**<br>`[model I/O]` | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled.<br>**RTX 5090 / Vulkan:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled. |
| **Global FA + residency (full)**<br>`[combined profile]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Confirm combined speed and memory; preserve the offloaded baseline on unvalidated capacities. |
| **Residency added after global FA (full)**<br>`[memory placement]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Use only if the memory/speed tradeoff remains reliable over repeated requests. |
| **Global FA + residency (short)**<br>`[combined profile]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Confirm combined speed and memory; preserve the offloaded baseline on unvalidated capacities. |
| **Residency added after global FA (short)**<br>`[memory placement]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Use only if the memory/speed tradeoff remains reliable over repeated requests. |

### Additional and partially checked approaches

| Improvement | Type | Checked | Speed effect: seconds, percent, ratio | Quality | Platform / API | Memory, tradeoffs and scope | Implement or reject: why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Older isolated operations + VAE-only FA | Measured combination | V - dated | RTX: 104.180 -> 89.550 s; -14.04% latency; 1.163x; 14.630 s saved; Spark: 401.450 -> 307.420 s; -23.42% latency; 1.306x; 94.030 s saved | PSNR approximately 52-56 dB; audio exact; reviewed frames visually unchanged. | RTX and GB10 / CUDA, 29 Oct | Fresh-context CLI; TE FA disabled. Additional prompts confirm the direction. A VAE-only selector is needed. | A candidate for the focused engine/selector work; new minimal patch does not inherit this validation. |
| Graphs, launch queues, thread count and VAE convolution | Scheduling / parameters | V | No reliable general speed gain; see individual reproduction records. | Exact or numerically compared where valid. | API-specific screens; CUDA history and new Metal/Vulkan/HIP trials | Defaults differ by backend. Do not treat an already-enabled fast path as a new gain. | Keep existing defaults unless a specific confirmed profile is listed above. |
| Vulkan large-token MLP chunking / NVFP4 TE / new decoder | Conditional engine / model work | Source review | Not measured in the tested request envelope. | Not established for these changes. | Potential Vulkan / CUDA targets | MLP chunking addresses a >4 GiB individual buffer at larger token counts; NVFP4 requires loader/checkpoint work. Current small conditioning cost limits warm-speed upside. | Defer; no demonstrated benefit in the booked cases and broader compatibility scope. |

### Retained CUDA screens and remaining ideas

Retained CUDA-only screens from 29 October, at the older revisions. These include rejected alternatives and unmeasured ideas; V means tried, not recommended. They do not establish Metal, Vulkan or HIP performance. Round-two controls already include H3 flash attention, FLUX GEMM and LTX residency as stated in the original records.

| Improvement | Type | Checked | Speed effect: seconds, percent, ratio | Quality | Platform / API | Memory, tradeoffs and scope | Implement or reject: why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Full upstream PR #2240 | Engine algorithm/layout + kernels | V - dated | RTX screen: 102.11 to 90.04 s; 1.134x; 11.82% lower generation latency. Spark second fresh invocation: 347.05 to 294.38 s; 1.179x; 15.18% lower. | Visible motion/geometry and audio changes. RTX/Spark PSNR 20.98/22.72 dB, SSIM 0.7618/0.8259, audio SNR 9.21/6.67 dB | RTX and Spark / CUDA, 29 Oct | A faster broad upstream patch is not automatically an acceptable QVAC engine upgrade. | Reject the complete patch for the visually identical tier. |
| EasyCache 0.05 / 0.20 | Approximate denoising reuse | V - dated | 0.20: RTX: 113.649 to 104.789 s; 1.085x; 7.80% lower latency; Spark: 604.611 to 535.998 s; 1.128x; 11.35% lower latency | 0.05: byte exact, zero skipped steps. 0.20: video PSNR 35.16/34.90 dB; audio SNR 2.85/3.07 dB | RTX and Spark / CUDA, 29 Oct | 0.20 skips one of eight denoising steps and changes motion/detail and audio. | Reject 0.20 for the quality target; 0.05 offers no useful acceleration. |
| DBCache / TaylorSeer flags | Approximate denoising reuse | V - dated | RTX: 113.649 to 92.487 / 91.396 s (18.62% / 19.58% lower). Spark: 604.611 to 471.004 / 472.186 s (22.10% / 21.90% lower). | Visible artifacts; RTX/Spark PSNR 16.83/17.20 dB, SSIM 0.6620/0.6758; audio SNR 1.32/1.22 dB | RTX and Spark / CUDA, 29 Oct | Both flags skip two of eight steps and produce the same output within each host. They use the pinned engine's whole-condition reuse path. | Reject these tested settings: substantial output changes exceed the accepted quality tier. |
| CUDA graphs / graph optimization | Build and scheduling parameters | V - dated | RTX: 113.649 to 114.078 s; 0.996x; 0.38% higher latency; Spark: 604.611 to 611.753 s; 0.988x; 1.18% higher latency | Byte exact in tested outputs | RTX and Spark / CUDA, 29 Oct | Actual cudaGraphLaunch observed. GGML_CUDA_GRAPH_OPT=1 was also slower: RTX +1.30%, Spark +0.64% latency. | Reject as a default change: no reliable speed gain. |
| CPU threads 2 / 16 | Runtime parameters | V - dated | RTX: 114.314 / 114.322 s vs 113.649 s. Spark: 606.780 / 606.052 s vs 604.611 s. | Output byte exact | RTX and Spark / CUDA, 29 Oct | Changes are smaller than 0.6% and do not support a new default. | Keep the tested 8-thread control; extra tuning showed no benefit. |
| CUDA launch queue 4x | Process-scoped CUDA scheduling | V - dated | RTX: 115.007 to 114.331 s; 1.006x; 0.59% lower. Spark: 601.678 to 599.833 s; 1.003x; 0.31% lower. | Four matched clip pairs per host byte exact | RTX and Spark / CUDA, 29 Oct | Three measured warm requests per side. No system-level setting is changed. | Reject as a speed recommendation: differences are too small and within run variability. |
| GPU parameter residency | Memory placement | V - dated | Spark: 1.003x; 0.33% lower latency | Output bit exact; 0% changed values | Spark only; RTX selective profile failed / CUDA, 29 Oct | Spark: 661.899 to 659.693 s, within run-to-run noise. Not a gain over an already resident default. RTX warmed up, then ran out of memory on a later request. | Keep the memory-fitting configuration. Spark gain is noise; RTX selective residency failed a subsequent request. |
| VAE weights on GPU | Module parameter placement | V - dated | RTX: 113.649 to 113.903 s; 0.998x; 0.22% higher latency | Byte exact | RTX only / CUDA, 29 Oct | Host RSS 39.836 to 33.734 GB; retain capacity checks. Not a denoising acceleration. | No speed recommendation. Consider separately for lower host RSS. |
| Forced cuBLAS build | Matrix backend selection | V - dated | Spark: about 1.02x | Rejected: black video and corrupted audio | Spark; FLUX build also tried on RTX / CUDA, 29 Oct | H3: PSNR 9.65 dB, SSIM 0.3005, audio SNR -51.4 dB. This specific forced-backend experiment failed quality. | Reject: corrupt output outweighs the small timing gain. |
| BF16 DiT matrices | Precision selection | V - dated | Spark: 1.022x; 2.18% lower latency, single measured run | Rejected: substantial video/audio differences | Spark only / CUDA, 29 Oct | Existing Q4 matrices dequantized to BF16, not the original BF16 checkpoint. Video PSNR 23.53 dB, SSIM 0.8504; audio RMSE 0.001478 and SNR 5.21 dB. | Reject as a quality-preserving optimization; changed values, small single-run gain. |
| NVFP4 text encoder | Quantization / loader support |  - dated | X - unmeasured | Unvalidated | Future: Blackwell CUDA / CUDA, 29 Oct | Pinned engine lacks the ComfyUI NVFP4 AWQ loader. Draft engine PR #49 provides a candidate and reports separate T2V/I2V checks, but our campaign has not benchmarked it or validated quality against the default encoder. In the measured warm H3 workload, conditioning is about 0.4 s of 605 s on Spark: eliminating it entirely would save only about 0.07%. Cold-load and long-prompt benefits remain unmeasured. | Defer to a cold-start/long-prompt study: requires an unmerged loader and different encoder checkpoint; negligible ceiling for this measured warm workload. |
| Shared-runtime-only H3 ablation | Engine change-scope isolation | V - dated | RTX parent to shared-only: 97.23 to 97.06 s (0.17% lower); adding H3 operations: 89.39 s (7.90% lower). Spark: 340.04 to 337.52 s (0.74% lower), then 298.41 s (11.59% lower). | RTX paired outputs byte exact. Spark shared-to-isolated PSNR 52.66-53.85 dB, SSIM 0.99836-0.99875; audio exact | RTX and Spark / CUDA, 29 Oct | Three fresh processes per variant. Parent to isolated: RTX 1.088x, 8.06% lower; Spark 1.140x, 12.24% lower. Neutral shared-only performance does not prove the required ggml operations are unnecessary. | Reject shared-runtime-only as a speed change. Focus the backport on H3 operations and the ggml APIs they require. |

### Optimal suggested implementation and fallback

Pending final quality, memory and cumulative review.

**Startup and memory tradeoffs**

Resource observations for the paired profiles above. GB = 10^9 bytes; MiB = 2^20 bytes. Startup is load plus the first request in a fresh model context, with uncontrolled OS file cache. Process RSS and device-wide samples are separate counters; do not add them on unified-memory machines. Different rows may use different prompts or clip lengths.

| Profile / API | Load + first request | Peak process RSS | Sampled device memory | Primary stage change |
| --- | --- | --- | --- | --- |
| Global flash attention / RTX 5090 / CUDA | 141.357 -> 135.055 s; -4.46% | 40.240 -> 40.257 GB; +0.04% | 23728.000 -> 23728.000 MiB; +0.00% | VAE: 25.923 -> 19.244 s; -25.76% |
| Global flash attention / RTX 5090 / Vulkan | 112.890 -> 102.636 s; -9.08% | 39.616 -> 39.624 GB; +0.02% | 24304.000 -> 24304.000 MiB; +0.00% | VAE: 27.172 -> 18.132 s; -33.27% |
| Global flash attention / M3 Ultra / Metal | 235.005 -> 131.769 s; -43.93% | 62.980 -> 63.069 GB; +0.14% | Unified memory; RSS is not total device usage | VAE: 53.174 -> 19.613 s; -63.12% |
| Global flash attention / Radeon 8060S / Vulkan | 114.706 -> 112.281 s; -2.11% | 1.782 -> 1.783 GB; +0.05% | 56.084 -> 61.105 GB VRAM + GTT; +8.95% | VAE: 29.602 -> 24.919 s; -15.82% |
| Global flash attention / Radeon 8060S / HIP | 75.783 -> 76.261 s; +0.63% | 38.979 -> 38.982 GB; +0.01% | 24.266 -> 17.806 GB VRAM + GTT; -26.62% | VAE: 22.294 -> 14.618 s; -34.43% |

### Approach descriptions, decision reasons and change scope

- Existing global flash_attn changes text-encoder and VAE attention as well as the already-enabled diffusion attention. The pinned-engine native result must not be conflated with the newer upstream experiment, where enabling text-encoder flash attention changed motion/audio.
- The minimal patch replaces separate SwiGLU graph operations with the existing fused operator and accesses Q/K/V through tensor views. It changes one model header and adds no dependency. It needs an engine PR and temporary addon overlay validation before a registry repin; no SDK change is indicated.
- The older isolated upstream patch includes partial RoPE and newer GGML operations. Its broader scope and Metal audio differences make it a separate candidate. Retained Spark results do not validate the new minimal backport.
- A VAE-only flash-attention selector is needed to reproduce the older combined profile safely. The additive speed effect must be measured with the selected patch and checkpoint, not inferred from independent tests.
- Parameter residency can reduce copies and process RSS on unified-memory systems, but allocation limits and repeated-request stability still matter. Preserve the offloaded baseline when capacity is not established.

#### Global flash attention `[params tuning]`

- **RTX 5090 / CUDA:** Recommend a model/API-scoped profile after the final implementation checks; retain the current baseline elsewhere. Quality: PSNR 52.36-55.99 dB; SSIM 0.999008-0.999269. Worst frame 50.52 dB. Audio exact. Reviewed frame samples show no visible change. Scope/tradeoff: 960 x 544, 124 frames; diffusion FA already enabled. native warm latency, matched prompt/seed/geometry.
- **RTX 5090 / Vulkan:** Recommend a model/API-scoped profile after the final implementation checks; retain the current baseline elsewhere. Quality: PSNR 51.18-54.41 dB; SSIM 0.998624-0.998854. Worst frame 49.49 dB. Audio exact. Reviewed frame samples show no visible change. Scope/tradeoff: 960 x 544, 124 frames; diffusion FA already enabled. native warm latency, matched prompt/seed/geometry.
- **M3 Ultra / Metal:** Provisional until full-size, quality and repeated-request checks complete. Quality: PSNR 57.73 dB; SSIM 0.999649. Worst frame 56.55 dB. Audio exact. Scope/tradeoff: Prefer full 960 x 544 / 124-frame confirmation; otherwise short 512 x 288 / 39-frame screen only. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Provisional until full-size, quality and repeated-request checks complete. Quality: PSNR 51.12 dB; SSIM 0.998222. Worst frame 50.64 dB. Audio exact. Scope/tradeoff: Prefer full 960 x 544 / 124-frame confirmation; otherwise short 512 x 288 / 39-frame screen only. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / HIP:** Provisional until full-size, quality and repeated-request checks complete. Quality: PSNR 48.14 dB; SSIM 0.996470. Worst frame 47.09 dB. Audio exact. Scope/tradeoff: Prefer full 960 x 544 / 124-frame confirmation; otherwise short 512 x 288 / 39-frame screen only. native warm latency, matched prompt/seed/geometry.
- **DGX Spark GB10 / CUDA, 29 Oct:** Retain the dated recommendation; revalidate on the implementation revision. Quality: Approximately 53.6 dB; audio exact; reviewed samples visually unchanged. Scope/tradeoff: Older package/engine revisions; 960 x 544, 124 frames.

#### Minimal SwiGLU + QKV views `[graph optimization]`

- **RTX 5090 / CUDA:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged. Quality: Video/audio files byte exact. 1 comparison. Scope/tradeoff: Warm engine context, 960 x 544 / 124 frames. Mean of 1 per-prompt medians. Per-prompt latency reductions 1.94-1.94%. Fresh-process I/O-confounded results remain in the records.
- **RTX 5090 / Vulkan:** Provisional: accept only a reproducible gain with the required quality tier; no automatic enablement from a single screen. Quality: Video/audio files byte exact. 1 comparison. Scope/tradeoff: One model header using existing GGML operations. RTX full clips; Mac/Strix short screens. Multi-prompt RTX confirmations are reported separately. Fresh CLI context each repetition; generation and process wall time separately..
- **M3 Ultra / Metal:** Reject as the preferred Metal profile: output/audio change and the initial non-FA screen is slower. Keep the original graph. Quality: PSNR 37.19 dB; SSIM 0.986075. Worst frame 31.83 dB. Audio SNR 25.18 dB. Perceptual audio parity not established. Scope/tradeoff: One model header using existing GGML operations. RTX full clips; Mac/Strix short screens. Multi-prompt RTX confirmations are reported separately. Fresh CLI context each repetition; generation and process wall time separately..
- **Radeon 8060S / Vulkan:** Provisional: accept only a reproducible gain with the required quality tier; no automatic enablement from a single screen. Quality: Pending Scope/tradeoff: One model header using existing GGML operations. RTX full clips; Mac/Strix short screens. Multi-prompt RTX confirmations are reported separately.
- **Radeon 8060S / HIP:** Provisional: accept only a reproducible gain with the required quality tier; no automatic enablement from a single screen. Quality: Pending Scope/tradeoff: One model header using existing GGML operations. RTX full clips; Mac/Strix short screens. Multi-prompt RTX confirmations are reported separately.

#### Minimal operations + global FA `[combined profile]`

- **RTX 5090 / CUDA:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged. Quality: PSNR 55.96 dB; SSIM 0.999271. Worst frame 55.33 dB. Audio exact. Scope/tradeoff: Warm engine context, 960 x 544 / 124 frames. Mean of 1 per-prompt medians. Per-prompt latency reductions 7.62-7.62%. Fresh-process I/O-confounded results remain in the records.
- **RTX 5090 / Vulkan:** Provisional pending incremental benefit and output validation. Quality: PSNR 52.51 dB; SSIM 0.997947. Worst frame 51.98 dB. Audio exact. Scope/tradeoff: Combined profile measured directly against its own baseline; do not multiply separate speedups. Fresh CLI context each repetition; generation and process wall time separately..
- **M3 Ultra / Metal:** Use global FA alone on Metal. Adding the patch measured only 3.8% extra speed with PSNR 37.20 dB and audio SNR 25.18 dB; perceptual audio parity is not established. Quality: PSNR 37.20 dB; SSIM 0.986081. Worst frame 31.83 dB. Audio SNR 25.18 dB. Perceptual audio parity not established. Scope/tradeoff: Combined profile measured directly against its own baseline; do not multiply separate speedups. Fresh CLI context each repetition; generation and process wall time separately..
- **Radeon 8060S / Vulkan:** Provisional pending incremental benefit and output validation. Quality: Pending Scope/tradeoff: Combined profile measured directly against its own baseline; do not multiply separate speedups.
- **Radeon 8060S / HIP:** Provisional pending incremental benefit and output validation. Quality: Pending Scope/tradeoff: Combined profile measured directly against its own baseline; do not multiply separate speedups.

#### Operations added after global FA `[incremental engine benefit]`

Warm engine context, 960 x 544 / 124 frames. Mean of 1 per-prompt medians. Per-prompt latency reductions 2.24-2.24%. Fresh-process I/O-confounded results remain in the records.

- **RTX 5090 / CUDA:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged. Quality: Video/audio files byte exact. 1 comparison.

#### Older isolated H3 operations `[kernel optimization]`

Different engine base from the pinned minimal patch; do not compare its absolute latency with another cohort. Fresh CLI context each repetition; generation and process wall time separately..

- **M3 Ultra / Metal:** Reject any strict-parity claim when audio changes; otherwise assess the broader backport separately. Quality: PSNR 42.88 dB; SSIM 0.993938. Worst frame 40.85 dB. Audio SNR 21.14 dB. Perceptual audio parity not established.
- **Radeon 8060S / Vulkan:** Reject any strict-parity claim when audio changes; otherwise assess the broader backport separately. Quality: Video/audio files byte exact. 1 comparison.
- **Radeon 8060S / HIP:** Reject on HIP: visible video changes and audio SNR only 1.09 dB; speed does not meet the requested quality tier. Quality: PSNR 29.11 dB; SSIM 0.946455. Worst frame 26.71 dB. Audio SNR 1.09 dB. Perceptual audio parity not established.

#### Parameter residency `[memory placement]`

Short screen; unified-memory RSS is not total system/device consumption. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation. Quality: Video/audio files byte exact. 1 comparison.
- **Radeon 8060S / Vulkan:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation. Quality: Video/audio files byte exact. 1 comparison.
- **Radeon 8060S / HIP:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation. Quality: Video/audio files byte exact. 1 comparison.

#### SGLang / vLLM comparison `[runtime choice]`

No matched vLLM H3 GGUF adapter; new-platform recipes do not validate gfx1151 or Metal diffusion.

- **GB10 / CUDA, 29 Oct:** Separate runtime option, not a drop-in quality-preserving optimization. Quality: Different generated content; PSNR 16.26, SSIM 0.5705; parity not established.

#### 2D VAE GEMM control `[params tuning]`

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending Scope/tradeoff: One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.
- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Video/audio files byte exact. 1 comparison. Scope/tradeoff: One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / HIP:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Video/audio files byte exact. 1 comparison. Scope/tradeoff: One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

#### Metal commands per buffer: 2 `[scheduling tuning]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending

#### Metal commands per buffer: 4 `[scheduling tuning]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending

#### Metal serial encoding `[scheduling tuning]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending

#### Vulkan host-memory selection `[memory placement]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Video/audio files byte exact. 1 comparison.

#### Vulkan synchronized submits `[scheduling tuning]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Video/audio files byte exact. 1 comparison.

#### HIP rocWMMA attention after global FA `[kernel optimization]`

Matching pinned GGML and ABI128; rocWMMA headers extracted inside the test workspace. Installed ROCm unchanged.

- **Radeon 8060S / HIP:** Decide from diffusion results; published LLM results are not a diffusion validation. Quality: Pending

#### HIP force-blas `[kernel optimization]`

Existing forced-selection controls; same corrected tensor-name ABI and checkpoint.

- **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. Quality: Pending

#### HIP force-mmq `[kernel optimization]`

Existing forced-selection controls; same corrected tensor-name ABI and checkpoint.

- **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. Quality: Pending

#### Memory-mapped checkpoint reads `[model I/O]`

Process-local mmap of task checkpoint files; evaluate startup/RSS separately from warm speed. No filesystem mount or system setting.

- **RTX 5090 / CUDA:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled. Quality: Pending
- **RTX 5090 / Vulkan:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled. Quality: Pending

#### Global FA + residency (full) `[combined profile]`

Full: 960 x 544 / 124 frames; short: additional prompts at 512 x 288 / 39 frames.

- **M3 Ultra / Metal:** Confirm combined speed and memory; preserve the offloaded baseline on unvalidated capacities. Quality: Pending

#### Residency added after global FA (full) `[memory placement]`

Separates the residency contribution from the flash-attention gain.

- **M3 Ultra / Metal:** Use only if the memory/speed tradeoff remains reliable over repeated requests. Quality: Pending

#### Global FA + residency (short) `[combined profile]`

Full: 960 x 544 / 124 frames; short: additional prompts at 512 x 288 / 39 frames.

- **M3 Ultra / Metal:** Confirm combined speed and memory; preserve the offloaded baseline on unvalidated capacities. Quality: Pending

#### Residency added after global FA (short) `[memory placement]`

Separates the residency contribution from the flash-attention gain.

- **M3 Ultra / Metal:** Use only if the memory/speed tradeoff remains reliable over repeated requests. Quality: Pending

## 2. FLUX.2 Klein 4B Q8

A compact text-to-image model. Main tests use 1024 x 1024 images and 10 sampling steps; RTX also covers portrait 768 x 1024 and larger 1280 x 1280 requests. FLUX 3 Image Klein is a distinct compatibility target, not validated by these measurements.

### Approach × platform/API results

| Approach and type | RTX 5090 / CUDA | RTX 5090 / Vulkan | DGX Spark GB10 / CUDA (29 Oct) | M3 Ultra / Metal | Strix 8060S / Vulkan | Strix 8060S / HIP | Implement or reject — why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **GEMM VAE**<br>`[params tuning]` | **V**<br>8.786 -> 2.858 s;  -67.47% latency;  3.074x<br>Visually identical in reviewed outputs | **V**<br>2.605 -> 2.771 s;  +6.37% latency;  0.940x<br>Numerically compared; see quality details | **V - dated**<br>40.956 -> 15.433 s;  -62.32% latency;  2.654x<br>Visually identical in reviewed outputs | **V**<br>27.889 -> 30.800 s;  +10.44% latency;  0.905x<br>Numerically compared; see quality details | **V**<br>29.601 -> 47.245 s;  +59.61% latency;  0.627x<br>Numerically compared; see quality details | **V**<br>67.780 -> 33.569 s;  -50.47% latency;  2.019x<br>Visually identical in reviewed outputs | **RTX 5090 / CUDA:** Recommend an explicit capacity-checked GEMM profile. Reviewed images/crops are visually indistinguishable.<br>**RTX 5090 / Vulkan:** Reject GEMM for this API: slower and more device memory; retain direct convolution.<br>**M3 Ultra / Metal:** Reject GEMM if confirmation retains the measured regression; direct convolution is the fallback.<br>**Radeon 8060S / Vulkan:** Reject GEMM: substantially slower and more memory; retain direct convolution.<br>**Radeon 8060S / HIP:** Recommend a capacity-checked HIP profile after packaged-backend validation. Reviewed images/crops show no visible change.<br>**DGX Spark GB10 / CUDA, 29 Oct:** Recommend within the tested CUDA profile; revalidate on the implementation revision. |
| **GEMM + CPU parameters**<br>`[combined profile]` | **V**<br>8.786 -> 3.365 s;  -61.70% latency;  2.611x<br>Numerically compared; see quality details | Not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Offer as a distinct lower-VRAM profile; do not infer fit on every nominal 8 GB card. |
| **DiT matrix expansion to F16**<br>`[params tuning]` | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | **V**<br>27.889 -> 26.884 s;  -3.60% latency;  1.037x<br>Pixels exact | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **M3 Ultra / Metal:** Pending speed/quality confirmation; not the original unquantized checkpoint.<br>**Radeon 8060S / Vulkan:** Pending speed/quality confirmation; not the original unquantized checkpoint.<br>**Radeon 8060S / HIP:** Pending speed/quality confirmation; not the original unquantized checkpoint.<br>**RTX 5090 / CUDA:** Pending final speed/quality and memory review; retain original quantized weights elsewhere.<br>**RTX 5090 / Vulkan:** Pending final speed/quality and memory review; retain original quantized weights elsewhere. |
| **HIP force-blas**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>33.589 -> 34.978 s;  +4.14% latency;  0.960x<br>Numerically compared; see quality details | **Radeon 8060S / HIP:** Retain default selection unless the incremental gain is repeatable and material. |
| **HIP force-mmq**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>33.589 -> 33.402 s;  -0.56% latency;  1.006x<br>Numerically compared; see quality details | **Radeon 8060S / HIP:** Retain default selection unless the incremental gain is repeatable and material. |
| **SGLang / vLLM-Omni**<br>`[runtime choice]` | Not checked | Not checked | **V - dated**<br>Spark SGLang: 15.433 -> 5.993 s (-61.17%, 2.575x); vLLM-Omni: 15.324 -> 6.512 s (-57.50%, 2.353x).<br>Different content; not equivalent | Not checked | Not checked | Not checked | **GB10 / CUDA, 29 Oct:** Separate runtime option; not quality-equivalent or cold-start equivalent to QVAC. |
| **CPU parameter placement**<br>`[memory placement]` | Not checked | Not checked | Not checked | **V**<br>27.889 -> 28.374 s;  +1.74% latency;  0.983x<br>Pixels exact | **V**<br>29.601 -> 30.947 s;  +4.55% latency;  0.957x<br>Pixels exact | Not checked | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Diffusion flash attention disabled**<br>`[params tuning]` | Not checked | Not checked | Not checked | **V**<br>27.889 -> 122.796 s;  +340.30% latency;  0.227x<br>Numerically compared; see quality details | Not checked | Not checked | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Metal commands per buffer: 2**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>27.889 -> 27.943 s;  +0.19% latency;  0.998x<br>Pixels exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Metal commands per buffer: 4**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>27.889 -> 27.913 s;  +0.09% latency;  0.999x<br>Pixels exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Metal serial encoding**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>27.889 -> 27.930 s;  +0.15% latency;  0.999x<br>Pixels exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Vulkan host-memory selection**<br>`[memory placement]` | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | **V**<br>29.601 -> 29.927 s;  +1.10% latency;  0.989x<br>Pixels exact | Not applicable to this API | **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Vulkan synchronized submits**<br>`[scheduling tuning]` | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | **V**<br>29.601 -> 31.033 s;  +4.84% latency;  0.954x<br>Pixels exact | Not applicable to this API | **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **GEMM VAE + F16 matrices**<br>`[combined profile]` | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Use only if the F16 increment justifies additional memory and all quality/latency checks pass. |
| **HIP rocWMMA attention after GEMM**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Decide from diffusion results; published LLM results are not a diffusion validation. |
| **Memory-mapped checkpoint reads**<br>`[model I/O]` | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled.<br>**RTX 5090 / Vulkan:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled. |

### Additional and partially checked approaches

| Improvement | Type | Checked | Speed effect: seconds, percent, ratio | Quality | Platform / API | Memory, tradeoffs and scope | Implement or reject: why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FA off / threads / queues / Vulkan host-memory tuning | Scheduling / control experiments | V | No reliable improvement over the chosen baseline; FA off is substantially slower. | Check individual records; API switching can visibly alter seeded output. | RTX CUDA/Vulkan, M3 Ultra Metal, Strix Vulkan/HIP as recorded | Diffusion flash attention is already enabled. Metal queue and thread changes are mostly within variation. | Keep the existing fast paths and explicit backend choice. |
| FLUX 3 / upstream auto probes / Strix fork | Compatibility / broader engine work | Source review | No validated speed result for these checkpoints. | Not established. | Unvalidated model/backend combinations | FLUX 3 has distinct model components; an upstream microprobe or Krea-specific gain does not establish full-generation performance here. | Defer broad upgrades; only carry isolated kernels with matched quality and end-to-end evidence. |

### Retained CUDA screens and remaining ideas

Retained CUDA-only screens from 29 October, at the older revisions. These include rejected alternatives and unmeasured ideas; V means tried, not recommended. They do not establish Metal, Vulkan or HIP performance. Round-two controls already include H3 flash attention, FLUX GEMM and LTX residency as stated in the original records.

| Improvement | Type | Checked | Speed effect: seconds, percent, ratio | Quality | Platform / API | Memory, tradeoffs and scope | Implement or reject: why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GPU parameter residency | Memory placement | V - dated | RTX: 1.043-1.055x; 4.10-5.17% lower latency | Output bit exact; 0% changed values | RTX; not a new resident-default gain / CUDA, 29 Oct | 9.176-9.305 to 8.800-8.830 s across three prompts. Sampled GPU peak 5994 to 11356 MiB (+89.46%). | Keep when capacity permits; already the default, not an additional cumulative gain. |
| Small FLUX.2 decoder | Distilled VAE checkpoint | V - dated | RTX: 2.860/2.859/2.851 to 2.784/2.776/2.784 s; 1.024-1.030x; 2.35-2.90% lower after GEMM. Spark: 15.433/15.433/15.405 to 15.024/15.032/15.044 s; 1.024-1.027x; 2.34-2.65% lower. | Visually close, not identical: PSNR 35.99-42.85 dB, SSIM 0.9764-0.9850 across both hosts; subtle texture and background tint changes | Klein 4B on RTX and Spark; three prompts per host / CUDA, 29 Oct | RTX GPU peak 15636 to 13802 MiB (-1834 MiB, -11.73%). Authors claim compatibility across open FLUX.2; other checkpoints and FLUX 3 unvalidated. | Optional memory trade-off only; reject automatic replacement for this quality tier. |
| EasyCache 0.05 / 0.20 | Approximate denoising reuse | V - dated | RTX 2.836 to 2.837/2.839 s; Spark 15.388 to 15.281/15.330 s; no reliable gain | Byte exact; zero skipped steps | RTX and Spark / CUDA, 29 Oct | Tested at 10 steps with the GEMM VAE. | Reject as a performance change: no work saved. |
| DBCache / TaylorSeer flags | Approximate denoising reuse | V - dated | RTX 2.836 to 1.899/1.900 s (1.493x, about 33% lower). Spark 15.388 to 10.056/10.305 s (1.530/1.493x, 34.65/33.03% lower). | Visible texture/geometry differences: RTX/Spark PSNR 19.98/19.62 dB; SSIM 0.8066/0.8020 | RTX and Spark / CUDA, 29 Oct | Both modes skip four of ten steps and produce the same output within each host. | Reject for the visually identical tier. |
| Four-step distilled preset | Sampling parameters | V - dated | 2.072x; 51.74% lower latency | Different output; quality parity not established | Spark only / CUDA, 29 Oct | 10 to 4 steps with GEMM VAE. Four steps are recommended for distilled Klein 4B by its authors. This is a sampling trade-off, not a bit-exact kernel optimization. | Offer only as a clearly labeled sampling choice. Faster, but not the same fixed-seed output or a proven quality-preserving change. |
| CUDA graphs / graph optimization | Build and scheduling parameters | V - dated | RTX screen: 2.836 to 2.836 s (1.000x). Spark repeated R1: 1.49-2.12% higher latency; R2 screen approximately neutral. | Byte exact in tested outputs | RTX and Spark / CUDA, 29 Oct | Nsight confirms graph launches. Additional graph optimization flag: RTX 0.00%, Spark 0.34% lower latency, within noise. | Keep graphs off for this profile; no reliable improvement. |
| CPU threads / global flash / launch queues | Runtime parameters | V - dated | Thread/flash screens within about 1%. RTX queues: 2.858 to 2.852 s; 1.002x; 0.21% lower. Spark queues: 15.341 to 15.378 s; 0.998x; 0.24% higher. | Exact output where paired equality was checked | RTX and Spark / CUDA, 29 Oct | Do not add these nominal gains to GEMM speedup. | No default change: effects are too small to justify added complexity. |
| GEMM plus actual VAE tiles | Kernel / memory trade-off | V - dated | Spark: 2.446-2.466x; 59.12-59.45% lower latency versus direct VAE | Rejected for visually identical tier: visible tone/contrast changes | Spark only / CUDA, 29 Oct | 32-latent-pixel tiles, 25% overlap. PSNR 25.60-27.97 dB; SSIM 0.8910-0.9825. Lower memory does not offset this output deviation. | Reject for the accepted quality tier: visible contrast/tone changes. |

### Optimal suggested implementation and fallback

Pending final quality, memory and cumulative review.

**Startup and memory tradeoffs**

Resource observations for the paired profiles above. GB = 10^9 bytes; MiB = 2^20 bytes. Startup is load plus the first request in a fresh model context, with uncontrolled OS file cache. Process RSS and device-wide samples are separate counters; do not add them on unified-memory machines. Different rows may use different prompts or clip lengths.

| Profile / API | Load + first request | Peak process RSS | Sampled device memory | Primary stage change |
| --- | --- | --- | --- | --- |
| GEMM VAE / RTX 5090 / CUDA | 11.218 -> 5.218 s; -53.49% | 2.675 -> 2.712 GB; +1.36% | 11356.000 -> 15636.000 MiB; +37.69% | VAE: 6.240 -> 0.290 s; -95.35% |
| GEMM VAE / RTX 5090 / Vulkan | 4.675 -> 4.890 s; +4.60% | 2.404 -> 2.403 GB; -0.03% | 11084.000 -> 16685.000 MiB; +50.53% | VAE: 0.293 -> 0.457 s; +56.11% |
| GEMM VAE / M3 Ultra / Metal | 34.936 -> 33.112 s; -5.22% | 11.851 -> 11.900 GB; +0.41% | Unified memory; RSS is not total device usage | VAE: 3.808 -> 6.714 s; +76.30% |
| GEMM VAE / Radeon 8060S / Vulkan | 31.458 -> 51.960 s; +65.17% | 2.325 -> 5.371 GB; +131.08% | 11.140 -> 15.673 GB VRAM + GTT; +40.69% | VAE: 1.842 -> 19.660 s; +967.54% |
| GEMM VAE / Radeon 8060S / HIP | 75.554 -> 37.722 s; -50.07% | 2.605 -> 2.581 GB; -0.92% | 11.691 -> 16.626 GB VRAM + GTT; +42.21% | VAE: 39.415 -> 4.796 s; -87.83% |
| GEMM + CPU parameters / RTX 5090 / CUDA | 11.218 -> 9.230 s; -17.72% | 2.675 -> 9.331 GB; +248.80% | 11356.000 -> 7926.000 MiB; -30.20% | VAE: 6.240 -> 0.292 s; -95.31% |
| DiT matrix expansion to F16 / M3 Ultra / Metal | 34.936 -> 34.090 s; -2.42% | 11.851 -> 17.694 GB; +49.29% | Unified memory; RSS is not total device usage | Denoising: 23.433 -> 22.433 s; -4.26% |

### Approach descriptions, decision reasons and change scope

- vae_conv_direct=false routes decoder convolutions through tensor packing and matrix multiplication. The accelerated matrix kernels help tested CUDA and HIP configurations, while additional packing and memory costs make the tested Vulkan and Metal paths slower. This is an existing engine parameter; the intended implementation is a narrowly scoped addon profile with explicit overrides preserved.
- The same decoder-family implementation can exist in other FLUX checkpoints, but the measured evidence covers Klein 4B Q8 and its tested VAE only. Do not enable it for the whole FLUX family or FLUX 3 based on these results.
- The higher-memory GEMM profile needs a tested capacity check. Explicit module placement currently returns unknown from the fit estimator, so unknown cannot authorize an automatic memory increase. Keep direct convolution as fallback outside the validated envelope.
- CPU parameter placement reduces RTX device-memory consumption while retaining most of the GEMM speed gain, at the cost of host memory and additional latency. It is not proof that the profile fits every nominal 8 GB GPU.
- The final Markdown report contains no comparison images. Visually identical labels refer to inspected outputs supported by full-output numerical comparisons; exact output and small visible texture changes are distinguished.

#### GEMM VAE `[params tuning]`

- **RTX 5090 / CUDA:** Recommend an explicit capacity-checked GEMM profile. Reviewed images/crops are visually indistinguishable. Quality: PSNR 58.72-60.28 dB; SSIM 0.999343-0.999585. Max channel error 2/255. Scope/tradeoff: Same model and sampling; vae_conv_direct=false. Main envelope 1024 x 1024 / 10 steps. native warm latency, matched prompt/seed/geometry.
- **RTX 5090 / Vulkan:** Reject GEMM for this API: slower and more device memory; retain direct convolution. Quality: PSNR 60.49-61.18 dB; SSIM 0.999444-0.999631. Max channel error 1/255. Scope/tradeoff: Same model and sampling; vae_conv_direct=false. Main envelope 1024 x 1024 / 10 steps. native warm latency, matched prompt/seed/geometry.
- **M3 Ultra / Metal:** Reject GEMM if confirmation retains the measured regression; direct convolution is the fallback. Quality: PSNR 71.18 dB; SSIM 0.999976. Max channel error 1/255. Scope/tradeoff: Same model and sampling; vae_conv_direct=false. Main envelope 1024 x 1024 / 10 steps. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Reject GEMM: substantially slower and more memory; retain direct convolution. Quality: PSNR 56.17 dB; SSIM 0.998930. Max channel error 2/255. Scope/tradeoff: Same model and sampling; vae_conv_direct=false. Main envelope 1024 x 1024 / 10 steps. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / HIP:** Recommend a capacity-checked HIP profile after packaged-backend validation. Reviewed images/crops show no visible change. Quality: PSNR 54.01-55.70 dB; SSIM 0.998164-0.998717. Max channel error 10/255. Scope/tradeoff: Same model and sampling; vae_conv_direct=false. Main envelope 1024 x 1024 / 10 steps. native warm latency, matched prompt/seed/geometry.
- **DGX Spark GB10 / CUDA, 29 Oct:** Recommend within the tested CUDA profile; revalidate on the implementation revision. Quality: PSNR approximately 59 dB; max 3/255 channel difference; reviewed images visually unchanged. Scope/tradeoff: Retained old revisions. CUDA acceleration does not imply Vulkan/Metal acceleration.

#### GEMM + CPU parameters `[combined profile]`

Sampled device peak 7926 MiB versus 15636 MiB for resident GEMM; more host memory and slower than resident GEMM. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Offer as a distinct lower-VRAM profile; do not infer fit on every nominal 8 GB card. Quality: PSNR 58.72-60.28 dB; SSIM 0.999343-0.999585. Max channel error 2/255.

#### DiT matrix expansion to F16 `[params tuning]`

- **M3 Ultra / Metal:** Pending speed/quality confirmation; not the original unquantized checkpoint. Quality: Decoded pixels exact. 1 comparison. Scope/tradeoff: Expand only Q8 transformer block weight matrices at load time. Verify rule matching, startup and memory. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Pending speed/quality confirmation; not the original unquantized checkpoint. Quality: Pending Scope/tradeoff: Expand only Q8 transformer block weight matrices at load time. Verify rule matching, startup and memory.
- **Radeon 8060S / HIP:** Pending speed/quality confirmation; not the original unquantized checkpoint. Quality: Pending Scope/tradeoff: Expand only Q8 transformer block weight matrices at load time. Verify rule matching, startup and memory.
- **RTX 5090 / CUDA:** Pending final speed/quality and memory review; retain original quantized weights elsewhere. Quality: Pending Scope/tradeoff: Three prompts, 1024 x 1024, warm repetitions. CUDA reference already uses GEMM; Vulkan retains direct VAE.
- **RTX 5090 / Vulkan:** Pending final speed/quality and memory review; retain original quantized weights elsewhere. Quality: Pending Scope/tradeoff: Three prompts, 1024 x 1024, warm repetitions. CUDA reference already uses GEMM; Vulkan retains direct VAE.

#### HIP force-blas `[kernel optimization]`

Corrected ABI128 backend, one prompt with warm repetitions. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / HIP:** Retain default selection unless the incremental gain is repeatable and material. Quality: PSNR 22.93 dB; SSIM 0.907176. Max channel error 240/255.

#### HIP force-mmq `[kernel optimization]`

Corrected ABI128 backend, one prompt with warm repetitions. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / HIP:** Retain default selection unless the incremental gain is repeatable and material. Quality: PSNR 18.61 dB; SSIM 0.810486. Max channel error 237/255.

#### SGLang / vLLM-Omni `[runtime choice]`

Startup regresses: SGLang load+first 17.602 -> 58.792 s; vLLM 17.732 -> 68.093 s.

- **GB10 / CUDA, 29 Oct:** Separate runtime option; not quality-equivalent or cold-start equivalent to QVAC. Quality: Different images/RNG/math and tensor handling; SGLang PSNR 11.67.

#### CPU parameter placement `[memory placement]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Decoded pixels exact. 1 comparison.
- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Decoded pixels exact. 1 comparison.

#### Diffusion flash attention disabled `[params tuning]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: PSNR 58.08 dB; SSIM 0.999753. Max channel error 22/255.

#### Metal commands per buffer: 2 `[scheduling tuning]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Decoded pixels exact. 1 comparison.

#### Metal commands per buffer: 4 `[scheduling tuning]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Decoded pixels exact. 1 comparison.

#### Metal serial encoding `[scheduling tuning]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Decoded pixels exact. 1 comparison.

#### Vulkan host-memory selection `[memory placement]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Decoded pixels exact. 1 comparison.

#### Vulkan synchronized submits `[scheduling tuning]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Decoded pixels exact. 1 comparison.

#### GEMM VAE + F16 matrices `[combined profile]`

Directly measured combination against the same-cohort direct/Q8 baseline.

- **RTX 5090 / CUDA:** Use only if the F16 increment justifies additional memory and all quality/latency checks pass. Quality: Pending

#### HIP rocWMMA attention after GEMM `[kernel optimization]`

Matching pinned GGML and ABI128; rocWMMA headers extracted inside the test workspace. Installed ROCm unchanged.

- **Radeon 8060S / HIP:** Decide from diffusion results; published LLM results are not a diffusion validation. Quality: Pending

#### Memory-mapped checkpoint reads `[model I/O]`

Process-local mmap of task checkpoint files; evaluate startup/RSS separately from warm speed. No filesystem mount or system setting.

- **RTX 5090 / CUDA:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled. Quality: Pending
- **RTX 5090 / Vulkan:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled. Quality: Pending

## 3. LTX-2.3 22B distilled Q5

An audio-video generation model using a distilled 22B diffusion transformer. Tests use 512 x 320, 8 sampling steps and 97 or 193 frames, including repeated requests and several prompts where completed.

### Approach × platform/API results

| Approach and type | RTX 5090 / CUDA | RTX 5090 / Vulkan | DGX Spark GB10 / CUDA (29 Oct) | M3 Ultra / Metal | Strix 8060S / Vulkan | Strix 8060S / HIP | Implement or reject — why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **VAE residency, 97 frames**<br>`[memory placement]` | Not checked | **V**<br>15.195 -> 14.167 s;  -6.77% latency;  1.073x<br>Output byte-exact | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / Vulkan:** Recommend only a capacity-checked profile; preserve CPU-weight fallback. |
| **Full-temporal decode, 97 frames**<br>`[params tuning]` | **V**<br>13.294 -> 12.645 s;  -4.88% latency;  1.051x<br>Small visual differences; audio exact where stated | Not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Optional minor-change quality tier; keep temporal tiling for strict baseline behavior. |
| **VAE residency, 193 frames**<br>`[memory placement]` | Not checked | **V**<br>24.440 -> 22.167 s;  -9.30% latency;  1.103x<br>Output byte-exact | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / Vulkan:** Recommend only a capacity-checked profile; preserve CPU-weight fallback. |
| **Full-temporal decode, 193 frames**<br>`[params tuning]` | **V**<br>22.700 -> 21.060 s;  -7.22% latency;  1.078x<br>Small visual differences; audio exact where stated | Not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Optional minor-change quality tier; keep temporal tiling for strict baseline behavior. |
| **Full-temporal decode**<br>`[params tuning]` | Not checked | Not checked | **V - dated**<br>97 frames: 37.802 -> 36.678 s (-2.97%, 1.031x); 193 frames: 74.142 -> 70.780 s (-4.53%, 1.047x).<br>Small visual differences; audio exact where stated | **V**<br>92.877 -> 91.742 s;  -1.22% latency;  1.012x<br>Numerically compared; see quality details | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **M3 Ultra / Metal:** Decide from this API result; do not transfer the CUDA recommendation automatically.<br>**Radeon 8060S / Vulkan:** Decide from this API result; do not transfer the CUDA recommendation automatically.<br>**Radeon 8060S / HIP:** Decide from this API result; do not transfer the CUDA recommendation automatically.<br>**DGX Spark GB10 / CUDA, 29 Oct:** Optional quality-tier choice; do not promise faster cold/first-request latency. |
| **DiT matrix expansion to F16**<br>`[params tuning]` | Not checked | Not checked | Not checked | **V**<br>92.877 -> 88.428 s;  -4.79% latency;  1.050x<br>Output byte-exact | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **M3 Ultra / Metal:** Pending quality, warm-speed, startup and memory checks. Extra memory must be capacity-gated; no RTX resident profile is claimed.<br>**Radeon 8060S / Vulkan:** Pending quality, warm-speed, startup and memory checks. Extra memory must be capacity-gated; no RTX resident profile is claimed.<br>**Radeon 8060S / HIP:** Pending quality, warm-speed, startup and memory checks. Extra memory must be capacity-gated; no RTX resident profile is claimed. |
| **VAE residency + full-temporal**<br>`[combined profile]` | Not checked | **V**<br>15.195 -> 14.144 s;  -6.92% latency;  1.074x<br>Output byte-exact | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / Vulkan:** Prefer the simpler residency-only profile when the incremental gain is within variation. |
| **Residency + full-temporal**<br>`[combined profile]` | Not checked | Not checked | **V - dated**<br>39.777 -> 36.678 s;  -7.79% latency;  1.084x<br>Residency exact; temporal change has small visual differences and exact audio. | Not checked | Not checked | Not checked | **DGX Spark GB10 / CUDA, 29 Oct:** Do not count already-selected residency as a new improvement over the resident baseline. |
| **Metal dispatch grouping, 97 frames**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>122.930 -> 119.540 s;  -2.76% latency;  1.028x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Provisional; reject if complete-request gain is not reliable or is explained by unrelated I/O. |
| **Metal dispatch grouping, 193 frames**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>198.650 -> 198.590 s;  -0.03% latency;  1.000x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Provisional; reject if complete-request gain is not reliable or is explained by unrelated I/O. |
| **Metal per-value packing**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>112.030 -> 106.260 s;  -5.15% latency;  1.054x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject: slower decoder and no credible end-to-end compute gain to justify four changed backend files. |
| **SGLang / vLLM-Omni and LTX-2.5**<br>`[runtime choice]` | Not checked | Not checked | **V / partial - dated**<br>Spark SGLang: 37.802 -> 12.578 s (-66.73%, 3.005x).<br>Different content; not equivalent | Not checked | Not checked | Not checked | **GB10 / CUDA, 29 Oct:** Separate runtime/model work, not an equivalent implementation candidate. |
| **CPU parameter placement**<br>`[memory placement]` | Not checked | Not checked | Not checked | **V**<br>92.877 -> 95.573 s;  +2.90% latency;  0.972x<br>Output byte-exact | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / HIP:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **2D VAE GEMM control**<br>`[params tuning]` | Not checked | Not checked | Not checked | **V**<br>92.877 -> 92.889 s;  +0.01% latency;  1.000x<br>Output byte-exact | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / HIP:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Metal commands per buffer: 2**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>92.877 -> 93.221 s;  +0.37% latency;  0.996x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **HIP rocWMMA attention**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Decide from diffusion results; published LLM results are not a diffusion validation. |
| **HIP force-blas**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. |
| **HIP force-mmq**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. |
| **Memory-mapped checkpoint reads**<br>`[model I/O]` | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled.<br>**RTX 5090 / Vulkan:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled. |
| **F16 matrices + full-temporal decode**<br>`[combined profile]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Prefer F16 alone for exact output unless the incremental temporal benefit justifies its quality tradeoff. |

### Retained CUDA screens and remaining ideas

Retained CUDA-only screens from 29 October, at the older revisions. These include rejected alternatives and unmeasured ideas; V means tried, not recommended. They do not establish Metal, Vulkan or HIP performance. Round-two controls already include H3 flash attention, FLUX GEMM and LTX residency as stated in the original records.

| Improvement | Type | Checked | Speed effect: seconds, percent, ratio | Quality | Platform / API | Memory, tradeoffs and scope | Implement or reject: why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Official distilled sigma schedule | Sampling configuration / addon capability | V - dated | RTX upstream CLI generation median: 29.97 to 30.65 s; 0.978x; 2.27% higher latency. Spark: 41.60 to 41.51 s; 1.002x; 0.22% lower, within noise. | Different scene/audio, not a quality ranking: RTX PSNR 11.27 dB, SSIM 0.3722; Spark PSNR 11.07-11.16 dB, SSIM 0.3818-0.3863 | RTX and Spark / CUDA, 29 Oct | Three fresh invocations per side with numerical scaling. Earlier native custom_sigmas probes changed nothing: the pinned video addon ignores the parameter. SGLang uses the explicit distilled schedule, so its native-addon comparison is not schedule matched. | Reject as a transparent speed change. Consider separately as sampling-correctness / model integration work. |
| Direct vs GEMM 3D convolution | Newer engine VAE kernels | V - dated | RTX generation median: 30.78 to 31.85 s; 0.966x; 3.48% higher latency. Spark: 41.33 to 48.58 s; 0.851x; 17.54% higher. | RTX PSNR 49.78 dB, SSIM 0.9978; audio SNR 19.81 dB. Spark output varies even without a setting change | RTX and Spark / CUDA, 29 Oct | Three fresh invocations per side with scaling 1/128. Spark paired PSNR 23.23-27.41 dB is confounded by unchanged-parent variation (23.63 dB). Unscaled runs are invalid white video. Distinct from the pinned addon's 2D flag. | Reject the tested GEMM path: consistently slower on both hosts. |
| Broad upstream engine upgrade | Engine / ggml update | V - dated | X - failed output validation | Unscaled tests produced 97 all-white frames and saturated audio on both parent and candidate builds | RTX and Spark / CUDA, 29 Oct | Not attributed specifically to H3 PR #2240. Scaling by 1/128 restored valid RTX output, but it differs from QVAC (PSNR 21.40 dB, SSIM 0.7477, audio SNR -1.80 dB). This is a diagnostic recovery, not a validated QVAC upgrade. | Reject a broad engine upgrade. Isolate any useful kernels and preserve QVAC behavior. |
| Global flash attention | Existing kernel selection | V - dated | RTX: 1.001x; 0.05% lower latency; Spark: 0.981x; 1.91% higher latency | Video and audio bit exact; 0% changed values | RTX 5090 and Spark / CUDA, 29 Oct | No useful gain: effectively neutral on RTX, slightly slower on Spark. Not promoted for LTX. | Reject: neutral on RTX and slower on Spark. |
| EasyCache / DBCache / TaylorSeer | Approximate denoising reuse | V - dated | RTX DBCache/TaylorSeer: 13.316 to 13.196/13.371 s (-0.90%/+0.41% latency); EasyCache: 14.021/14.302 s (+5.29%/+7.40%). Spark: 38.570 to 38.167-38.388 s (0.47-1.04% lower). | All tested video/audio byte exact; zero skipped steps | RTX and Spark / CUDA, 29 Oct | Pinned addon schedule only. Native runs named distilled are ignored-parameter checks, not a second schedule. | Reject: no denoising work saved, and EasyCache adds overhead on RTX. |
| CUDA graphs / optimization | Build / graph scheduling | V - dated | RTX: 13.316 to 13.314 s (1.000x); graph optimization 13.438 s (+0.92%). Spark: 38.570 to 38.228 s (-0.89%); graph optimization 38.126 s (-1.15%). | Byte exact in tested outputs | RTX and Spark / CUDA, 29 Oct | Actual cudaGraphLaunch verified; profiler timing excluded. | No reliable speed recommendation from these single measured requests. |
| CPU threads / launch queues | Runtime parameters | V - dated | RTX threads 2/16: 13.320/13.352 s versus 13.316 s; queues 13.318 s. Spark threads: 38.309/38.212 s versus 38.570 s. Spark queues: 38.270 to 38.199 s; 0.19% lower. | Byte exact for tested variants | RTX and Spark / CUDA, 29 Oct | No cumulative gain is claimed for timing noise. | Keep current settings; no reliable speed gain. |
| Selective RTX GPU residency | Module parameter placement | V - dated | VAE-only: 13.316 to 13.100 s; 1.016x; 1.62% lower latency. DiT profiles: X - allocation failures. | VAE-only output bit exact; DiT residency fails repeated use | RTX / CUDA, 29 Oct | VAE-only sampled GPU peak +1384 MiB (+6.81%), host RSS -1.626 GB (-4.53%). DiT-only succeeds once then fails its next request; DiT+VAE and fully resident configurations fail allocation. | Reject as a speed default. DiT residency is unreliable; VAE-only benefit is small for its VRAM cost. |
| 2D convolution GEMM flag | Kernel selection | V - dated | Spark: approximately 1.00x; less than 1% difference | All 12 exported AVI pairs byte identical | Spark only / CUDA, 29 Oct | vae_conv_direct:false does not deliver FLUX-like gains for the LTX decoder. It is not an accepted LTX optimization. | Reject: no useful effect on this decoder. |
| Forced cuBLAS build | Matrix backend selection | V - dated | Spark: 0.926x; 7.96% higher latency | Rejected: video/audio differences | Spark only / CUDA, 29 Oct | 37.879 to 40.895 s in the original single-prompt comparison. Video PSNR 24.85 dB, SSIM 0.8708; audio SNR -1.28 dB. | Reject: slower and changes video/audio. |
| DiT and 3D VAE kernels | Engine / backend kernels |  - dated | X - unmeasured | Target: same output tolerance | Future: M3 Metal, Strix Vulkan/ROCm, CUDA / CUDA, 29 Oct | DiT denoising is about 70% of Spark generation time: prioritize Q5 matrix/attention kernels, then 3D convolution and temporal allocation. Vulkan stateful decoding already exists; it is not a new gain. | 3D CUDA experiment is listed separately. Metal/Strix-specific kernels remain untested, not rejected. |
| Stateful decoder on CUDA | Engine decoder execution policy | V - dated | RTX CLI generation: tiled 31.87 to stateful 35.50 s; 11.39% slower. Spark: 42.29 to 46.89 s; 10.88% slower. Versus complete decode: 15.45% / 14.53% slower. | Small numerical video differences: RTX/Spark PSNR 48.44/48.45 dB vs tiled; audio bit exact | RTX and Spark / CUDA, 29 Oct | Research-only hook in the pinned engine, three fresh invocations each; all existing build tests pass. RTX sampled GPU peak unchanged at 19702 MiB; RSS +0.299 GB (+0.86%) vs tiled. Spark RSS +0.002 GB (+0.03%). No production policy change. | Reject as a CUDA speed optimization on this workload. The existing Vulkan policy remains separate. |

### Optimal suggested implementation and fallback

Pending final quality, memory and cumulative review.

**Startup and memory tradeoffs**

Resource observations for the paired profiles above. GB = 10^9 bytes; MiB = 2^20 bytes. Startup is load plus the first request in a fresh model context, with uncontrolled OS file cache. Process RSS and device-wide samples are separate counters; do not add them on unified-memory machines. Different rows may use different prompts or clip lengths.

| Profile / API | Load + first request | Peak process RSS | Sampled device memory | Primary stage change |
| --- | --- | --- | --- | --- |
| VAE residency, 97 frames / RTX 5090 / Vulkan | 24.538 -> 22.176 s; -9.63% | 36.831 -> 35.001 GB; -4.97% | 19907.000 -> 21355.000 MiB; +7.27% | VAE: 3.830 -> 2.760 s; -27.93% |
| Full-temporal decode, 97 frames / RTX 5090 / CUDA | 37.796 -> 33.059 s; -12.53% | 36.145 -> 36.568 GB; +1.17% | 20332.000 -> 20494.000 MiB; +0.80% | VAE: 3.584 -> 2.949 s; -17.71% |
| VAE residency, 193 frames / RTX 5090 / Vulkan | 33.427 -> 30.018 s; -10.20% | 36.918 -> 35.164 GB; -4.75% | 20577.000 -> 22025.000 MiB; +7.04% | VAE: 7.174 -> 5.044 s; -29.69% |
| Full-temporal decode, 193 frames / RTX 5090 / CUDA | 44.271 -> 41.937 s; -5.27% | 36.688 -> 36.693 GB; +0.01% | 20948.000 -> 21348.000 MiB; +1.91% | VAE: 7.386 -> 5.714 s; -22.65% |
| Full-temporal decode / M3 Ultra / Metal | 120.576 -> 119.250 s; -1.10% | 43.941 -> 43.960 GB; +0.04% | Unified memory; RSS is not total device usage | VAE: 8.182 -> 7.021 s; -14.19% |
| DiT matrix expansion to F16 / M3 Ultra / Metal | 120.576 -> 118.018 s; -2.12% | 43.941 -> 64.074 GB; +45.82% | Unified memory; RSS is not total device usage | Denoising: 81.915 -> 77.051 s; -5.94% |

### Approach descriptions, decision reasons and change scope

- Keeping only the video decoder weights on the RTX Vulkan device avoids repeated transfers. The measured profile is relative to the tested CPU-weight baseline, uses extra VRAM and needs a capacity gate; it is not a blanket recommendation for full model residency.
- Disabling temporal tiling decodes the full latent sequence together. It reduces repeated work on CUDA but changes temporal context at tile boundaries, producing small texture/contrast differences. Audio is checked separately. This belongs in an explicit minor-change quality tier unless new platform evidence supports the stricter tier.
- The pinned Vulkan LTX decoder already uses its stateful path, so toggling temporal_tiling does not reproduce the CUDA change. A redundant flag should not be counted as an additional optimization.
- The four-file Metal IM2COL_3D candidate parallelizes packed values, with bounded dispatch and independent operator tests. It initially appeared faster only because checkpoint I/O differed; decoder timing regressed. The simpler one-file candidate groups existing per-position threads without changing arithmetic. Evaluate both on decoder timing and complete requests, and reject added code without a reliable end-to-end gain.
- Do not combine the broad upstream engine update with these claims: earlier output corruption and unsupported new-model architecture require separate compatibility work.

#### VAE residency, 97 frames `[memory placement]`

97 frames: three prompts; 193 frames: one prompt. Adds device memory. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / Vulkan:** Recommend only a capacity-checked profile; preserve CPU-weight fallback. Quality: Video/audio files byte exact. 3 comparisons.

#### Full-temporal decode, 97 frames `[params tuning]`

Decode the complete latent sequence together; slightly higher memory. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Optional minor-change quality tier; keep temporal tiling for strict baseline behavior. Quality: PSNR 43.82-50.71 dB; SSIM 0.996474-0.997734. Worst frame 40.84 dB. Audio exact. Subtle texture/contrast differences are possible; audio is compared separately.

#### VAE residency, 193 frames `[memory placement]`

97 frames: three prompts; 193 frames: one prompt. Adds device memory. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / Vulkan:** Recommend only a capacity-checked profile; preserve CPU-weight fallback. Quality: Video/audio files byte exact. 1 comparison.

#### Full-temporal decode, 193 frames `[params tuning]`

Decode the complete latent sequence together; slightly higher memory. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Optional minor-change quality tier; keep temporal tiling for strict baseline behavior. Quality: PSNR 46.39 dB; SSIM 0.996980. Worst frame 43.76 dB. Audio exact. Subtle texture/contrast differences are possible; audio is compared separately.

#### Full-temporal decode `[params tuning]`

- **M3 Ultra / Metal:** Decide from this API result; do not transfer the CUDA recommendation automatically. Quality: PSNR 50.04 dB; SSIM 0.998227. Worst frame 47.60 dB. Audio exact. Scope/tradeoff: 512 x 320, 97 frames. Vulkan already uses its stateful path. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Decide from this API result; do not transfer the CUDA recommendation automatically. Quality: Pending Scope/tradeoff: 512 x 320, 97 frames. Vulkan already uses its stateful path.
- **Radeon 8060S / HIP:** Decide from this API result; do not transfer the CUDA recommendation automatically. Quality: Pending Scope/tradeoff: 512 x 320, 97 frames. Vulkan already uses its stateful path.
- **DGX Spark GB10 / CUDA, 29 Oct:** Optional quality-tier choice; do not promise faster cold/first-request latency. Quality: Small texture/contrast differences; 193-frame PSNR 46.59 dB; audio exact. Scope/tradeoff: 193-frame first request regressed 74.439 -> 77.710 s (+4.39%).

#### DiT matrix expansion to F16 `[params tuning]`

- **M3 Ultra / Metal:** Pending quality, warm-speed, startup and memory checks. Extra memory must be capacity-gated; no RTX resident profile is claimed. Quality: Video/audio files byte exact. 1 comparison. Scope/tradeoff: Verified rule selects 1632 quantized matrix weights (37.10 GB after expansion), excluding normalization and embedding weights. Same checkpoint and sampling. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Pending quality, warm-speed, startup and memory checks. Extra memory must be capacity-gated; no RTX resident profile is claimed. Quality: Pending Scope/tradeoff: Verified rule selects 1632 quantized matrix weights (37.10 GB after expansion), excluding normalization and embedding weights. Same checkpoint and sampling.
- **Radeon 8060S / HIP:** Pending quality, warm-speed, startup and memory checks. Extra memory must be capacity-gated; no RTX resident profile is claimed. Quality: Pending Scope/tradeoff: Verified rule selects 1632 quantized matrix weights (37.10 GB after expansion), excluding normalization and embedding weights. Same checkpoint and sampling.

#### VAE residency + full-temporal `[combined profile]`

The temporal flag adds no useful work reduction to the Vulkan stateful decoder. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / Vulkan:** Prefer the simpler residency-only profile when the incremental gain is within variation. Quality: Video/audio files byte exact. 3 comparisons.

#### Residency + full-temporal `[combined profile]`

Relative to CPU-offloaded control. GPU residency is already the selected Spark baseline.

- **DGX Spark GB10 / CUDA, 29 Oct:** Do not count already-selected residency as a new improvement over the resident baseline. Quality: Residency exact; temporal change has small visual differences and exact audio.

#### Metal dispatch grouping, 97 frames `[kernel optimization]`

Unchanged per-position kernel grouped into up to 128 threads. Inspect decoder stage and checkpoint I/O. Fresh CLI context each repetition; generation and process wall time separately..

- **M3 Ultra / Metal:** Provisional; reject if complete-request gain is not reliable or is explained by unrelated I/O. Quality: Video/audio files byte exact. 1 comparison.

#### Metal dispatch grouping, 193 frames `[kernel optimization]`

Unchanged per-position kernel grouped into up to 128 threads. Inspect decoder stage and checkpoint I/O. Fresh CLI context each repetition; generation and process wall time separately..

- **M3 Ultra / Metal:** Provisional; reject if complete-request gain is not reliable or is explained by unrelated I/O. Quality: Video/audio files byte exact. 1 comparison.

#### Metal per-value packing `[kernel optimization]`

Apparent total gain is I/O-confounded. Decoder median regressed 6.130 -> 8.605 s (+40.38%). Optional extra performance cases were not run; correctness suites passed. Fresh CLI context each repetition; generation and process wall time separately..

- **M3 Ultra / Metal:** Reject: slower decoder and no credible end-to-end compute gain to justify four changed backend files. Quality: Video/audio files byte exact. 1 comparison.

#### SGLang / vLLM-Omni and LTX-2.5 `[runtime choice]`

Load+first 44.075 -> 326.362 s; 66.73 GiB reserved, outside RTX capacity. No matched vLLM adapter. LTX-2.5 components unsupported.

- **GB10 / CUDA, 29 Oct:** Separate runtime/model work, not an equivalent implementation candidate. Quality: Different valid scene/audio; PSNR 10.74; parity not established.

#### CPU parameter placement `[memory placement]`

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Video/audio files byte exact. 1 comparison. Scope/tradeoff: One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending Scope/tradeoff: One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.
- **Radeon 8060S / HIP:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending Scope/tradeoff: One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.

#### 2D VAE GEMM control `[params tuning]`

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Video/audio files byte exact. 1 comparison. Scope/tradeoff: One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending Scope/tradeoff: One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.
- **Radeon 8060S / HIP:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending Scope/tradeoff: One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.

#### Metal commands per buffer: 2 `[scheduling tuning]`

One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Video/audio files byte exact. 1 comparison.

#### HIP rocWMMA attention `[kernel optimization]`

Matching pinned GGML and ABI128; rocWMMA headers extracted inside the test workspace. Installed ROCm unchanged.

- **Radeon 8060S / HIP:** Decide from diffusion results; published LLM results are not a diffusion validation. Quality: Pending

#### HIP force-blas `[kernel optimization]`

Existing forced-selection controls; same corrected tensor-name ABI and checkpoint.

- **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. Quality: Pending

#### HIP force-mmq `[kernel optimization]`

Existing forced-selection controls; same corrected tensor-name ABI and checkpoint.

- **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. Quality: Pending

#### Memory-mapped checkpoint reads `[model I/O]`

Process-local mmap of task checkpoint files; evaluate startup/RSS separately from warm speed. No filesystem mount or system setting.

- **RTX 5090 / CUDA:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled. Quality: Pending
- **RTX 5090 / Vulkan:** Pending paired startup, latency, memory and output checks; OS file cache is uncontrolled. Quality: Pending

#### F16 matrices + full-temporal decode `[combined profile]`

Directly measured cumulative effect; the temporal change has a distinct output-quality tier.

- **M3 Ultra / Metal:** Prefer F16 alone for exact output unless the incremental temporal benefit justifies its quality tradeoff. Quality: Pending

## Selective enablement and regression protection

- Key a profile by the exact supported model/decoder family, resolved module backend, tested accelerator class and request envelope. A generic device=gpu or NVIDIA device name does not distinguish CUDA from Vulkan.
- Do not change global registry defaults for a setting that regresses another API. The tested FLUX GEMM choice must not leak from CUDA/HIP into Metal/Vulkan.
- Treat an API switch as an explicit user choice. Same-seed outputs can differ visibly between CUDA, Vulkan, HIP and Metal; a faster API is not automatically a quality-preserving optimization.
- Preserve explicit overrides. Current SdCtxConfig stores plain bool values for flashAttn and vaeConvDirect; omitted values and explicit values equal to the default are not distinguished. An automatic policy must preserve option presence before applying any inferred default.
- For per-module assignments, inspect the backend of the affected module. A VAE convolution policy follows the VAE execution backend, not merely the diffusion transformer's backend.
- Higher-memory profiles start as explicit capacity-qualified choices. SdModel::assessFit currently returns unknown for explicit backend or non-default parameter placement; unknown must not authorize additional residency or precision expansion.
- The fallback is the existing configuration on every untested device, API, model, request shape or unsupported capacity. Preserve its existing backend failure and fallback semantics rather than silently retrying on a different API.

## Branch status and remaining validation

- Research branch only; no PR, no production default or package-pin change, and no addon version/changelog bump in this step.
- Final recommendations must list exact hardware/API, model and request envelope; other configurations retain the current baseline. Preserve explicit user settings. An API switch must be an explicit choice because seeded output can differ.
- Implement the smallest accepted engine change first, validate it through a temporary addon overlay, then follow the engine merge, separate vcpkg registry PR and addon repin sequence. Addon release notes/version bump remain a later separate PR.
- Run the full affected unit/integration suites and desktop CI matrix on the actual implementation. Research operator tests and manual benchmarks do not certify an unimplemented default-selection policy.
- Remaining coverage includes other Apple devices/capacities, other AMD GPUs/drivers, fresh Spark confirmation of newly proposed patches, larger request envelopes, image/video-conditioned modes and failure/recovery behavior. Mobile tests belong to late validation only if the affected implementation applies there.
