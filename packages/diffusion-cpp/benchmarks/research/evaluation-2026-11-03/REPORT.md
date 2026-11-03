# QVAC diffusion performance: four platforms, six API configurations

**DRAFT - final confirmation jobs and evidence review in progress**

RTX, Mac and Strix: 3 November 2026. DGX Spark: retained 29 October 2026 measurements at their original revisions. The original RTX and Spark report measured CUDA only. This extension adds RTX Vulkan, Strix Vulkan and HIP/ROCm, and Mac Metal. Vulkan correctness checks in the older CI record were not performance measurements.

Research branch: [codex/diffusion-performance](https://github.com/tetherto/qvac/tree/codex/diffusion-performance). No PR has been opened.

| Platform | System | Accelerator | Measured API | Date |
| --- | --- | --- | --- | --- |
| RTX 5090 | Linux x64 | NVIDIA GeForce RTX 5090 | CUDA, Vulkan | 2026-11-03 |
| DGX Spark | Linux arm64 | NVIDIA GB10 | CUDA | 2026-10-29 |
| Mac Studio | macOS arm64 | Apple M3 Ultra, 60 GPU cores | Metal | 2026-11-03 |
| AMD Strix Halo | Linux x64 | Radeon 8060S, gfx1151 | Vulkan/RADV, HIP/ROCm | 2026-11-03 |

## Revisions and measurement scope

- November native measurements use addon **0.33.0**, engine `67fd0f590e8de432e6bb95fb05b0c3fdfdb2a1dd`, GGML `a4adfcb1304fb05b64473f1fe8d678bbce7a9ce0`, and the recorded checkpoint hashes. The package pins are stable-diffusion 2026-08-11#9 and GGML 2026-08-11#3.
- October CUDA measurements use addon **0.31.0**, engine `4ec33ca21eec64b9778b6fd16d58e88cd501936d` and GGML `9f94f330ac196e0a2e3176e798b36226b22091a5`. Spark was not rebooked for November; its results retain those revisions.
- Pinned-engine experiments, older isolated upstream experiments, native addon requests and research CLI requests are separate cohorts. Compare the paired before/after within each cohort; do not combine absolute times or multiply independent ratios.
- Strix HIP uses task-built modules with `GGML_MAX_NAME=128`, matching the published addon. Earlier incompatible ABI160 native probes are excluded. This is not validation of a shipped HIP prebuild.
- The current diffusion addon/registry feature lists expose CUDA, Metal, Vulkan and OpenCL, but no HIP release feature. Shared CI has ROCm setup support for other consumers. Promoting Strix HIP requires explicit backend packaging/ABI/linking validation and the corresponding registry/addon build integration; changing only a runtime preset does not ship HIP support.
- Driver/toolchain coverage: RTX driver 595.71.05, CUDA 13.3.73 and Vulkan 1.4.329; Mac macOS 26.7.1 / Metal 4; Strix Mesa 25.2.8, Vulkan 1.4.318 and ROCm 7.2.4. Full hardware identities are in the reproduction records.
- Current defaults refers to the selected QVAC checkpoint sets. Benchmarks explicitly set backend and weight placement; the table below defines their baselines. These are not a claim that every shipping configuration resolves to the same placement.

| Model | Platform / API | Tested native baseline | Interpretation |
| --- | --- | --- | --- |
| MiniMax-H3 | RTX CUDA/Vulkan; Mac Metal; Strix Vulkan/HIP | params_backend=cpu; flash_attn=false; diffusion FA remains enabled | Full-size native baseline. Residency and global FA are separate changes. |
| FLUX.2 Klein | RTX CUDA/Vulkan; Mac Metal; Strix Vulkan/HIP | Parameters on the selected GPU; vae_conv_direct=true | GEMM and CPU parameter placement are compared separately and in explicit combinations. |
| LTX-2.3 | RTX CUDA/Vulkan | params_backend=cpu; vae_conv_direct=true | VAE-only residency is relative to this offloaded baseline. Full model residency is not established. |
| LTX-2.3 | Mac Metal; Strix Vulkan/HIP | Parameters on the selected GPU; vae_conv_direct=true | Already-resident weights must not be counted again as an optimization. |
| All models | DGX Spark / CUDA | Retained October configurations in the reproduction records | Dated pairs only; no fresh November Spark run. |

## Main recommendations

- FLUX.2: the largest reliable gain is the existing GEMM VAE setting on CUDA and tested HIP. Keep direct VAE on Metal/Vulkan. Do not enable by GPU vendor alone.
- MiniMax-H3: pinned-engine global flash attention is the broadest useful change, especially Metal VAE decode. The minimal engine graph patch is a smaller, separate API-scoped candidate; retain the original Metal graph.
- LTX-2.3: exact-output VAE residency helps RTX Vulkan. CUDA full-temporal decode is a separate small-output-change tier. Metal F16 expansion trades substantial memory for a modest warm-speed gain.
- No production selection policy, engine pin or release version changes are made. The branch preserves reproducible evidence and unapplied experimental patches. Implement accepted profiles with explicit override, capacity and fallback tests before PR/desktop CI validation.

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
- Quality error percentages are RMS channel error divided by the 255-level full scale, computed from PSNR. They describe numerical disagreement, not a percentage loss of perceived or semantic quality. Exact outputs have zero error.

Full per-output numerical comparisons, individual repetitions, source/checkpoint hashes and input configurations are retained in [reproduction-records.json](reproduction-records.json). The structured report is [report-content.json](report-content.json). No comparison pictures are required to use this report.

## 1. MiniMax-H3 FL2VA Q4

A text-to-video model that generates synchronized video and audio. This campaign uses the current QVAC H3 checkpoint set, with short 512 x 288 / 39-frame screens and 960 x 544 / 124-frame confirmations.

### Approach × platform/API results

| Approach and type | RTX 5090 / CUDA | RTX 5090 / Vulkan | DGX Spark GB10 / CUDA (29 Oct) | M3 Ultra / Metal | Strix 8060S / Vulkan | Strix 8060S / HIP | Implement or reject — why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Global flash attention**<br>`[params tuning]` | **V**<br>120.407 -> 113.771 s;  -5.51% latency;  1.058x<br>Visually identical in reviewed outputs; audio exact | **V**<br>103.638 -> 94.686 s;  -8.64% latency;  1.095x<br>Visually identical in reviewed outputs; audio exact | **V - dated**<br>659.693 -> 604.903 s;  -8.31% latency;  1.091x<br>Visually identical in reviewed outputs; audio exact | **V**<br>1543.865 -> 1238.215 s;  -19.80% latency;  1.247x<br>Visually identical in reviewed outputs; audio exact | **V**<br>1415.182 -> 1369.229 s;  -3.25% latency;  1.034x<br>Visually identical in reviewed outputs; audio exact | **V**<br>68.679 -> 61.573 s;  -10.35% latency;  1.115x<br>Visually identical in reviewed outputs; audio exact | Recommend in checked pinned-engine envelopes: broad repeated gains and accepted image/audio comparisons. Keep explicit overrides and original settings on unvalidated devices/shapes. HIP full-size timing and newly changed engine revisions need their own confirmation. |
| **HIP full-size quality control**<br>`[validation control]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>No accepted full-size warm speed result.<br>Output comparison pending. | **Radeon 8060S / HIP:** Use clean repeated short-clip timing for the speed claim. A full-size quality comparison cannot replace a clean repeated full-size latency pair. |
| **Minimal SwiGLU + QKV views**<br>`[graph optimization]` | **V**<br>119.849 -> 117.358 s;  -2.08% latency;  1.021x<br>Output byte-exact | **V**<br>103.228 -> 100.641 s;  -2.51% latency;  1.026x<br>Output byte-exact | Not checked | **V**<br>142.645 -> 145.870 s;  +2.26% latency;  0.978x<br>Video/audio differ; parity not established | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Small focused engine candidate on validated RTX APIs; preserve original graph elsewhere. Reject the Metal variant for output/audio changes. Spark and any unfinished Strix minimal-patch runs remain unvalidated. |
| **Minimal operations + global FA**<br>`[combined profile]` | **V**<br>119.849 -> 110.717 s;  -7.62% latency;  1.082x<br>Visually identical in reviewed outputs; audio exact | **V**<br>103.228 -> 91.501 s;  -11.36% latency;  1.128x<br>Visually identical in reviewed outputs; audio exact | Not checked | **V**<br>142.645 -> 108.140 s;  -24.19% latency;  1.319x<br>Video/audio differ; parity not established | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Use directly measured cumulative results. Prefer FA alone first; the small extra graph gain must survive reverse-order/graphs-enabled controls and native overlay validation. Reject the Metal combination as the preferred profile. |
| **Operations added after global FA**<br>`[incremental engine benefit]` | **V**<br>113.067 -> 110.717 s;  -2.08% latency;  1.021x<br>Output byte-exact | **V**<br>94.039 -> 91.501 s;  -2.70% latency;  1.028x<br>Output byte-exact | Not checked | **V**<br>108.790 -> 104.640 s;  -3.81% latency;  1.040x<br>Video/audio differ; parity not established | Not checked | Not checked | **RTX 5090 / CUDA:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged.<br>**RTX 5090 / Vulkan:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged.<br>**M3 Ultra / Metal:** Reject the patch on Metal: the small extra speed gain changes video and audio; keep the original graph with global FA. |
| **Older isolated H3 operations**<br>`[kernel optimization]` | Not checked | Not checked | Not checked | **V**<br>80.180 -> 70.595 s;  -11.95% latency;  1.136x<br>Video/audio differ; parity not established | **V**<br>90.065 -> 84.655 s;  -6.01% latency;  1.064x<br>Output byte-exact | **V**<br>72.410 -> 63.990 s;  -11.63% latency;  1.132x<br>Video/audio differ; parity not established | **M3 Ultra / Metal:** Reject any strict-parity claim when audio changes; otherwise assess the broader backport separately.<br>**Radeon 8060S / Vulkan:** Reject any strict-parity claim when audio changes; otherwise assess the broader backport separately.<br>**Radeon 8060S / HIP:** Reject on HIP: visible video changes and audio SNR only 1.09 dB; speed does not meet the requested quality tier. |
| **Parameter residency**<br>`[memory placement]` | Not checked | Not checked | Not checked | **V**<br>135.831 -> 131.249 s;  -3.37% latency;  1.035x<br>Output byte-exact | **V**<br>101.173 -> 97.740 s;  -3.39% latency;  1.035x<br>Output byte-exact | **V**<br>68.679 -> 68.846 s;  +0.24% latency;  0.998x<br>Output byte-exact | **M3 Ultra / Metal:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation.<br>**Radeon 8060S / Vulkan:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation.<br>**Radeon 8060S / HIP:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation. |
| **Metal vector-attention tuning tables**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Source review**<br>No measured diffusion gain.<br>Not established. | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Defer: an hours-long LLM tuning sweep has no established benefit for the dominant measured diffusion stages. |
| **SGLang / vLLM comparison**<br>`[runtime choice]` | Not checked | Not checked | **V / partial - dated**<br>Spark SGLang: 604.903 -> 172.799 s;  -71.43% latency;  3.501x<br>Different content; not equivalent | Not checked | Not checked | Not checked | **GB10 / CUDA, 29 Oct:** Separate runtime option, not a drop-in quality-preserving optimization. |
| **2D VAE GEMM control**<br>`[params tuning]` | Not checked | Not checked | Not checked | **V**<br>133.844 -> 133.895 s;  +0.04% latency;  1.000x<br>Output byte-exact | **V**<br>101.173 -> 100.647 s;  -0.52% latency;  1.005x<br>Output byte-exact | **V**<br>68.679 -> 69.237 s;  +0.81% latency;  0.992x<br>Output byte-exact | **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior.<br>**Radeon 8060S / Vulkan:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior.<br>**Radeon 8060S / HIP:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. |
| **Metal commands per buffer: 2**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>133.844 -> 133.633 s;  -0.16% latency;  1.002x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. |
| **Metal commands per buffer: 4**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>133.844 -> 133.522 s;  -0.24% latency;  1.002x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. |
| **Metal serial encoding**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>133.844 -> 133.633 s;  -0.16% latency;  1.002x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. |
| **Vulkan host-memory selection**<br>`[memory placement]` | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | **V**<br>101.173 -> 102.655 s;  +1.46% latency;  0.986x<br>Output byte-exact | Not applicable to this API | **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Vulkan synchronized submits**<br>`[scheduling tuning]` | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | **V**<br>101.173 -> 100.957 s;  -0.21% latency;  1.002x<br>Output byte-exact | Not applicable to this API | **Radeon 8060S / Vulkan:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. |
| **HIP rocWMMA attention after global FA**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Decide from diffusion results; the [published LLM result](https://github.com/ggml-org/llama.cpp/issues/24437) is not a diffusion validation. |
| **HIP force-blas**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. |
| **HIP force-mmq**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. |
| **Memory-mapped checkpoint reads**<br>`[model I/O]` | **V**<br>114.105 -> 114.381 s;  +0.24% latency;  0.998x<br>Output byte-exact | **V**<br>94.649 -> 94.633 s;  -0.02% latency;  1.000x<br>Output byte-exact | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim.<br>**RTX 5090 / Vulkan:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim. |
| **Global FA + residency (full)**<br>`[combined profile]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Confirm combined speed and memory; preserve the offloaded baseline on unvalidated capacities. |
| **Residency added after global FA (full)**<br>`[memory placement]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Use only if the memory/speed tradeoff remains reliable over repeated requests. |
| **Global FA + residency (short)**<br>`[combined profile]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Confirm combined speed and memory; preserve the offloaded baseline on unvalidated capacities. |
| **Residency added after global FA (short)**<br>`[memory placement]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Use only if the memory/speed tradeoff remains reliable over repeated requests. |
| **Graph patch after FA: reverse-order confirmation**<br>`[graph optimization]` | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Require agreement with the initial three-prompt block before accepting the small incremental engine change.<br>**RTX 5090 / Vulkan:** Require agreement with the initial three-prompt block before accepting the small incremental engine change. |
| **CUDA graphs: global FA control**<br>`[graph optimization]` | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | Not applicable to this API | **RTX 5090 / CUDA:** Use this control to check the graph-patch recommendation under the enabled build option. Native addon overlay and full CI remain required. |
| **CUDA graphs: patch added after FA**<br>`[graph optimization]` | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | Not applicable to this API | **RTX 5090 / CUDA:** Use this control to check the graph-patch recommendation under the enabled build option. Native addon overlay and full CI remain required. |
| **CUDA graphs: minimal patch + FA**<br>`[graph optimization]` | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | Not applicable to this API | **RTX 5090 / CUDA:** Use this control to check the graph-patch recommendation under the enabled build option. Native addon overlay and full CI remain required. |
| **CUDA graphs: build toggle control**<br>`[scheduling tuning]` | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | Not applicable to this API | **RTX 5090 / CUDA:** Validation control, not a claim that an already-enabled shipping feature is a new optimization. |

### Additional and partially checked approaches

| Improvement | Type | Checked | Speed effect: seconds, percent, ratio | Quality | Platform / API | Memory, tradeoffs and scope | Implement or reject: why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Older isolated operations + VAE-only FA | Measured combination | V - dated | RTX: 104.180 -> 89.550 s; -14.04% latency; 1.163x; 14.630 s saved; Spark: 401.450 -> 307.420 s; -23.42% latency; 1.306x; 94.030 s saved | PSNR approximately 52-56 dB; audio exact; reviewed frames visually unchanged. | RTX and GB10 / CUDA, 29 Oct | Fresh-context CLI; TE FA disabled. Additional prompts confirm the direction. A VAE-only selector is needed. | A candidate for the focused engine/selector work; new minimal patch does not inherit this validation. |
| Graphs, launch queues, thread count and VAE convolution | Scheduling / parameters | V | No reliable general speed gain; see individual reproduction records. | Exact or numerically compared where valid. | API-specific screens; CUDA history and new Metal/Vulkan/HIP trials | Defaults differ by backend. Do not treat an already-enabled fast path as a new gain. | Keep existing defaults unless a specific confirmed profile is listed above. |
| Vulkan large-token MLP chunking | Conditional graph / memory optimization | Source review | Not measured; tested cases are below the reported buffer threshold. | Not established. | Potential Vulkan targets | [Upstream PR #2257](https://github.com/leejet/stable-diffusion.cpp/pull/2257) chunks the feed-forward token axis when an individual buffer exceeds the backend limit. This addresses a >4 GiB buffer, not total VRAM exhaustion. | Defer to a larger-request compatibility check; no demonstrated speed benefit for the booked shapes. |
| NVFP4 text encoder | Quantization / checkpoint change | Not checked | No measured gain. | Not established; different weight precision. | Potential supported CUDA targets | Requires a supported checkpoint and loader/kernel path. Conditioning is a small fraction of tested warm generation, although a smaller encoder could save memory. | Defer: broader model/loader work and quality validation are needed; do not infer a DiT speedup from text-encoder quantization. |
| New or lower-precision video decoder | Model / precision change | Not checked | No measured gain. | Not established. | Unvalidated decoder/backend combinations | Replacing or requantizing the decoder changes model arithmetic/checkpoint content and requires independent audio-video validation. | Defer; existing attention parameters provide a smaller change with measured evidence. |

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

Start with the existing `flash_attn=true` parameter on the pinned H3 engine, keeping `diffusion_fa=true`. This is the broadest useful improvement found: full-size native checks cover RTX CUDA/Vulkan, M3 Ultra Metal and Strix Vulkan; Spark CUDA retains its dated confirmation, while HIP has its stated shorter-clip/full-quality limits. The benefit is mainly in VAE decode rather than a faster diffusion transformer. Use the minimal graph patch as a separate, smaller engine candidate only on the APIs whose full-model results pass. Metal retains the original graph because the patch changes audio/video. No universal hardware-independent patch is release-qualified by this research.

| Platform / API | Suggested profile | Fallback and implementation gate |
| --- | --- | --- |
| RTX 5090 / CUDA | `flash_attn=true`, existing diffusion FA. Native: 120.407 -> 113.771 s; -5.51% latency; 1.058x; 6.636 s saved | Existing offloaded parameter baseline. The optional minimal graph patch needs the graphs-enabled control, real addon overlay and explicit original-graph fallback. |
| RTX 5090 / Vulkan | `flash_attn=true`. Native: 103.638 -> 94.686 s; -8.64% latency; 1.095x; 8.952 s saved | The minimal patch is a second-priority candidate for its small additional gain; preserve original operations on unvalidated accelerators and APIs. |
| DGX Spark GB10 / CUDA, 29 Oct | `flash_attn=true`; 659.693 -> 604.903 s, -8.31% (54.790 s saved). | Dated pinned revision only. The new minimal patch has not been measured on Spark; do not inherit the older broader patch result. |
| M3 Ultra / Metal | `flash_attn=true`. Full-size native: 1543.865 -> 1238.215 s; -19.80% latency; 1.247x; 305.650 s saved | Original engine graph. Full residency is a separate capacity-qualified option only if its completed combined profile passes; shorter screens do not prove total memory savings. |
| Radeon 8060S / Vulkan | `flash_attn=true`. Full-size native: 1415.182 -> 1369.229 s; -3.25% latency; 1.034x; 45.953 s saved | Preserve original parameter placement unless a separately measured residency profile is selected. New minimal Vulkan patch does not inherit RTX validation. |
| Radeon 8060S / HIP | `flash_attn=true` within the measured HIP envelope: 68.679 -> 61.573 s; -10.35% latency; 1.115x; 7.106 s saved | HIP release packaging is not yet present. Full-size latency affected by external work is excluded; keep the baseline outside clean checked inputs. |

**Measured cumulative effect**

- RTX warm-context research CLI, three prompts: minimal graph patch plus global FA is 119.849 -> 110.717 s; -7.62% latency; 1.082x; 9.132 s saved on CUDA and 103.228 -> 91.501 s; -11.36% latency; 1.128x; 11.727 s saved on Vulkan. These use their own paired CLI controls, not the native-addon baseline.
- The graph-only increment after FA is 113.067 -> 110.717 s; -2.08% latency; 1.021x; 2.351 s saved on CUDA and 94.039 -> 91.501 s; -2.70% latency; 1.028x; 2.538 s saved on Vulkan. Reverse-order and graphs-enabled controls are separately tabulated; native overlay integration remains required.
- Mac full-size global FA plus residency: No accepted completed paired measurement. The incremental residency effect is No accepted completed paired measurement.
- The retained October Spark older isolated engine plus VAE-only FA result is 401.450 -> 307.420 s (-23.42%, 94.030 s saved). It has a different engine base and context lifetime; it is not the expected result of the new minimal patch.

**Startup and memory tradeoffs**

Resource observations for the paired profiles above. GB = 10^9 bytes; MiB = 2^20 bytes. Startup is load plus the first request in a fresh model context, with uncontrolled OS file cache. Process RSS and device-wide samples are separate counters; do not add them on unified-memory machines. Different rows may use different prompts or clip lengths.

| Profile / API | Load + first request | Peak process RSS | Sampled device memory | Primary stage change |
| --- | --- | --- | --- | --- |
| Global flash attention / RTX 5090 / CUDA | 141.357 -> 135.055 s; -4.46% | 40.240 -> 40.257 GB; +0.04% | 23728.000 -> 23728.000 MiB; +0.00% | VAE: 25.923 -> 19.244 s; -25.76% |
| Global flash attention / RTX 5090 / Vulkan | 112.890 -> 102.636 s; -9.08% | 39.616 -> 39.624 GB; +0.02% | 24304.000 -> 24304.000 MiB; +0.00% | VAE: 27.172 -> 18.132 s; -33.27% |
| Global flash attention / M3 Ultra / Metal | 1551.436 -> 1287.922 s; -16.99% | 67.242 -> 67.465 GB; +0.33% | Unified memory; RSS is not total device usage | VAE: 468.376 -> 169.173 s; -63.88% |
| Global flash attention / Radeon 8060S / Vulkan | 1419.960 -> 1373.028 s; -3.31% | 2.253 -> 2.265 GB; +0.54% | 61.911 -> 61.904 GB VRAM + GTT; -0.01% | VAE: 259.164 -> 212.070 s; -18.17% |
| Global flash attention / Radeon 8060S / HIP | 75.783 -> 76.261 s; +0.63% | 38.979 -> 38.982 GB; +0.01% | 24.266 -> 17.806 GB VRAM + GTT; -26.62% | VAE: 22.294 -> 14.618 s; -34.43% |

### Approach descriptions, decision reasons and change scope

- Existing global flash_attn changes text-encoder and VAE attention as well as the already-enabled diffusion attention. The pinned-engine native result must not be conflated with the newer upstream experiment, where enabling text-encoder flash attention changed motion/audio.
- The minimal patch replaces separate SwiGLU graph operations with the existing fused operator and accesses Q/K/V through tensor views. It changes one model header and adds no dependency. It needs an engine PR and temporary addon overlay validation before a registry repin; no SDK change is indicated.
- The older isolated upstream patch includes partial RoPE and newer GGML operations. Its broader scope and Metal audio differences make it a separate candidate. Retained Spark results do not validate the new minimal backport.
- A VAE-only flash-attention selector is needed to reproduce the older combined profile safely. The additive speed effect must be measured with the selected patch and checkpoint, not inferred from independent tests.
- Parameter residency can reduce copies and process RSS on unified-memory systems, but allocation limits and repeated-request stability still matter. Preserve the offloaded baseline when capacity is not established.

#### Global flash attention `[params tuning]`

- **RTX 5090 / CUDA:** Recommend the existing pinned-engine parameter in the tested model/API envelope: repeatable lower latency and accepted output comparisons. Keep diffusion FA enabled. Preserve explicit settings and the original global-FA setting outside this envelope; dated Spark and short-only HIP coverage remain explicitly limited. Quality: PSNR 52.36-55.99 dB; SSIM 0.999008-0.999269; RMS channel error 0.1586-0.2410% of full scale. Worst frame 50.52 dB. Audio exact. Reviewed frame samples show no visible change. Scope/tradeoff: 960 x 544, 124 frames; diffusion FA already enabled. native warm latency, matched prompt/seed/geometry.
- **RTX 5090 / Vulkan:** Recommend the existing pinned-engine parameter in the tested model/API envelope: repeatable lower latency and accepted output comparisons. Keep diffusion FA enabled. Preserve explicit settings and the original global-FA setting outside this envelope; dated Spark and short-only HIP coverage remain explicitly limited. Quality: PSNR 51.18-54.41 dB; SSIM 0.998624-0.998854; RMS channel error 0.1903-0.2760% of full scale. Worst frame 49.49 dB. Audio exact. Reviewed frame samples show no visible change. Scope/tradeoff: 960 x 544, 124 frames; diffusion FA already enabled. native warm latency, matched prompt/seed/geometry.
- **M3 Ultra / Metal:** Recommend the existing pinned-engine parameter in the tested model/API envelope: repeatable lower latency and accepted output comparisons. Keep diffusion FA enabled. Preserve explicit settings and the original global-FA setting outside this envelope; dated Spark and short-only HIP coverage remain explicitly limited. Quality: PSNR 59.14 dB; SSIM 0.999691; RMS channel error 0.1104% of full scale. Worst frame 58.16 dB. Audio exact. Scope/tradeoff: Prefer full 960 x 544 / 124-frame confirmation; otherwise short 512 x 288 / 39-frame screen only. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Recommend the existing pinned-engine parameter in the tested model/API envelope: repeatable lower latency and accepted output comparisons. Keep diffusion FA enabled. Preserve explicit settings and the original global-FA setting outside this envelope; dated Spark and short-only HIP coverage remain explicitly limited. Quality: PSNR 52.32 dB; SSIM 0.998272; RMS channel error 0.2422% of full scale. Worst frame 51.68 dB. Audio exact. Scope/tradeoff: Prefer full 960 x 544 / 124-frame confirmation; otherwise short 512 x 288 / 39-frame screen only. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / HIP:** Recommend the existing pinned-engine parameter in the tested model/API envelope: repeatable lower latency and accepted output comparisons. Keep diffusion FA enabled. Preserve explicit settings and the original global-FA setting outside this envelope; dated Spark and short-only HIP coverage remain explicitly limited. Quality: PSNR 48.14 dB; SSIM 0.996470; RMS channel error 0.3916% of full scale. Worst frame 47.09 dB. Audio exact. Scope/tradeoff: Prefer full 960 x 544 / 124-frame confirmation; otherwise short 512 x 288 / 39-frame screen only. native warm latency, matched prompt/seed/geometry.
- **DGX Spark GB10 / CUDA, 29 Oct:** Recommend the existing pinned-engine parameter in the tested model/API envelope: repeatable lower latency and accepted output comparisons. Keep diffusion FA enabled. Preserve explicit settings and the original global-FA setting outside this envelope; dated Spark and short-only HIP coverage remain explicitly limited. Quality: Approximately 53.6 dB; audio exact; reviewed samples visually unchanged. Scope/tradeoff: Older package/engine revisions; 960 x 544, 124 frames.

#### HIP full-size quality control `[validation control]`

The original full-size HIP timing control overlapped an external inference workload and was interrupted. A separately named single-output run checks quality at 960 x 544 / 124 frames only.

- **Radeon 8060S / HIP:** Use clean repeated short-clip timing for the speed claim. A full-size quality comparison cannot replace a clean repeated full-size latency pair. Quality: Output comparison pending.

#### Minimal SwiGLU + QKV views `[graph optimization]`

- **RTX 5090 / CUDA:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged. Quality: Video/audio files byte exact. 3 comparisons. Scope/tradeoff: Warm engine context, 960 x 544 / 124 frames. Mean of 3 per-prompt medians. Per-prompt latency reductions 1.94-2.17%. Fresh-process I/O-confounded results remain in the records.
- **RTX 5090 / Vulkan:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged. Quality: Video/audio files byte exact. 3 comparisons. Scope/tradeoff: Warm engine context, 960 x 544 / 124 frames. Mean of 3 per-prompt medians. Per-prompt latency reductions 2.38-2.70%. Fresh-process I/O-confounded results remain in the records.
- **M3 Ultra / Metal:** Reject as the preferred Metal profile: output/audio change and the initial non-FA screen is slower. Keep the original graph. Quality: PSNR 37.19 dB; SSIM 0.986075; RMS channel error 1.3812% of full scale. Worst frame 31.83 dB. Audio SNR 25.18 dB. Perceptual audio parity not established. Scope/tradeoff: One model header using existing GGML operations. RTX full clips; Mac/Strix short screens. Multi-prompt RTX confirmations are reported separately. Fresh CLI context each repetition; generation and process wall time separately..
- **Radeon 8060S / Vulkan:** Provisional: accept only a reproducible gain with the required quality tier; no automatic enablement from a single screen. Quality: Pending Scope/tradeoff: One model header using existing GGML operations. RTX full clips; Mac/Strix short screens. Multi-prompt RTX confirmations are reported separately.
- **Radeon 8060S / HIP:** Provisional: accept only a reproducible gain with the required quality tier; no automatic enablement from a single screen. Quality: Pending Scope/tradeoff: One model header using existing GGML operations. RTX full clips; Mac/Strix short screens. Multi-prompt RTX confirmations are reported separately.

#### Minimal operations + global FA `[combined profile]`

- **RTX 5090 / CUDA:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged. Quality: PSNR 52.42-55.96 dB; SSIM 0.998686-0.999271; RMS channel error 0.1592-0.2394% of full scale. Worst frame 50.92 dB. Audio exact. Scope/tradeoff: Warm engine context, 960 x 544 / 124 frames. Mean of 3 per-prompt medians. Per-prompt latency reductions 7.41-7.83%. Fresh-process I/O-confounded results remain in the records.
- **RTX 5090 / Vulkan:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged. Quality: PSNR 51.19-54.39 dB; SSIM 0.997947-0.998857; RMS channel error 0.1908-0.2759% of full scale. Worst frame 49.57 dB. Audio exact. Scope/tradeoff: Warm engine context, 960 x 544 / 124 frames. Mean of 3 per-prompt medians. Per-prompt latency reductions 11.27-11.44%. Fresh-process I/O-confounded results remain in the records.
- **M3 Ultra / Metal:** Use global FA alone on Metal. Adding the patch measured only 3.8% extra speed with PSNR 37.20 dB and audio SNR 25.18 dB; perceptual audio parity is not established. Quality: PSNR 37.20 dB; SSIM 0.986081; RMS channel error 1.3811% of full scale. Worst frame 31.83 dB. Audio SNR 25.18 dB. Perceptual audio parity not established. Scope/tradeoff: Combined profile measured directly against its own baseline; do not multiply separate speedups. Fresh CLI context each repetition; generation and process wall time separately..
- **Radeon 8060S / Vulkan:** Provisional pending incremental benefit and output validation. Quality: Pending Scope/tradeoff: Combined profile measured directly against its own baseline; do not multiply separate speedups.
- **Radeon 8060S / HIP:** Provisional pending incremental benefit and output validation. Quality: Pending Scope/tradeoff: Combined profile measured directly against its own baseline; do not multiply separate speedups.

#### Operations added after global FA `[incremental engine benefit]`

- **RTX 5090 / CUDA:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged. Quality: Video/audio files byte exact. 3 comparisons. Scope/tradeoff: Warm engine context, 960 x 544 / 124 frames. Mean of 3 per-prompt medians. Per-prompt latency reductions 1.74-2.27%. Fresh-process I/O-confounded results remain in the records.
- **RTX 5090 / Vulkan:** Provisional until three-prompt, quality and combined-profile review. The production graph and selection policy remain unchanged. Quality: Video/audio files byte exact. 3 comparisons. Scope/tradeoff: Warm engine context, 960 x 544 / 124 frames. Mean of 3 per-prompt medians. Per-prompt latency reductions 2.36-2.91%. Fresh-process I/O-confounded results remain in the records.
- **M3 Ultra / Metal:** Reject the patch on Metal: the small extra speed gain changes video and audio; keep the original graph with global FA. Quality: PSNR 37.20 dB; SSIM 0.986084; RMS channel error 1.3810% of full scale. Worst frame 31.83 dB. Audio SNR 25.18 dB. Perceptual audio parity not established. Scope/tradeoff: Separate repeated confirmation against the original graph with global FA already enabled; short 512 x 288 / 39-frame clips. Fresh CLI context each repetition; generation and process wall time separately..

#### Older isolated H3 operations `[kernel optimization]`

Different engine base from the pinned minimal patch; do not compare its absolute latency with another cohort. Fresh CLI context each repetition; generation and process wall time separately..

- **M3 Ultra / Metal:** Reject any strict-parity claim when audio changes; otherwise assess the broader backport separately. Quality: PSNR 42.88 dB; SSIM 0.993938; RMS channel error 0.7175% of full scale. Worst frame 40.85 dB. Audio SNR 21.14 dB. Perceptual audio parity not established.
- **Radeon 8060S / Vulkan:** Reject any strict-parity claim when audio changes; otherwise assess the broader backport separately. Quality: Video/audio files byte exact. 1 comparison.
- **Radeon 8060S / HIP:** Reject on HIP: visible video changes and audio SNR only 1.09 dB; speed does not meet the requested quality tier. Quality: PSNR 29.11 dB; SSIM 0.946455; RMS channel error 3.5044% of full scale. Worst frame 26.71 dB. Audio SNR 1.09 dB. Perceptual audio parity not established.

#### Parameter residency `[memory placement]`

Short screen; unified-memory RSS is not total system/device consumption. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation. Quality: Video/audio files byte exact. 1 comparison.
- **Radeon 8060S / Vulkan:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation. Quality: Video/audio files byte exact. 1 comparison.
- **Radeon 8060S / HIP:** Use only with proven capacity and repeated-request behavior; full combined confirmation determines speed recommendation. Quality: Video/audio files byte exact. 1 comparison.

#### Metal vector-attention tuning tables `[kernel optimization]`

[Published tuning](https://github.com/ggml-org/llama.cpp/discussions/27668) targets the small-query vector path; pinned selection requires query dimension below 20. Large diffusion attention is a different workload.

- **M3 Ultra / Metal:** Defer: an hours-long LLM tuning sweep has no established benefit for the dominant measured diffusion stages. Quality: Not established.

#### SGLang / vLLM comparison `[runtime choice]`

No matched vLLM H3 GGUF adapter; new-platform recipes do not validate gfx1151 or Metal diffusion.

- **GB10 / CUDA, 29 Oct:** Separate runtime option, not a drop-in quality-preserving optimization. Quality: Different generated content; PSNR 16.26, SSIM 0.5705; parity not established.

#### 2D VAE GEMM control `[params tuning]`

`vae_conv_direct=false`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Video/audio files byte exact. 1 comparison.
- **Radeon 8060S / Vulkan:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Video/audio files byte exact. 1 comparison.
- **Radeon 8060S / HIP:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Video/audio files byte exact. 1 comparison.

#### Metal commands per buffer: 2 `[scheduling tuning]`

`GGML_METAL_N_CB=2`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Video/audio files byte exact. 1 comparison.

#### Metal commands per buffer: 4 `[scheduling tuning]`

`GGML_METAL_N_CB=4`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Video/audio files byte exact. 1 comparison.

#### Metal serial encoding `[scheduling tuning]`

`GGML_METAL_CONCURRENCY_DISABLE=1`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Video/audio files byte exact. 1 comparison.

#### Vulkan host-memory selection `[memory placement]`

`GGML_VK_PREFER_HOST_MEMORY=1`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Video/audio files byte exact. 1 comparison.

#### Vulkan synchronized submits `[scheduling tuning]`

`GGML_VK_DISABLE_ASYNC=1`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / Vulkan:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Video/audio files byte exact. 1 comparison.

#### HIP rocWMMA attention after global FA `[kernel optimization]`

`GGML_HIP_ROCWMMA_FATTN=ON`, matching pinned GGML and ABI128; rocWMMA headers extracted inside the test workspace. Installed ROCm unchanged. This is a backend build option, not a per-request setting; selective production use needs a validated dispatch/build policy and the original kernel fallback.

- **Radeon 8060S / HIP:** Decide from diffusion results; the [published LLM result](https://github.com/ggml-org/llama.cpp/issues/24437) is not a diffusion validation. Quality: Pending

#### HIP force-blas `[kernel optimization]`

`GGML_CUDA_FORCE_CUBLAS=ON` (HIPBLAS on this backend). Existing compile-time forced-selection control; same corrected tensor-name ABI and checkpoint. It affects the backend module, so mixed model results cannot be solved by silently changing an addon-wide default.

- **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. Quality: Pending

#### HIP force-mmq `[kernel optimization]`

`GGML_CUDA_FORCE_MMQ=ON`. Existing compile-time forced-selection control; same corrected tensor-name ABI and checkpoint. It affects the backend module, so mixed model results cannot be solved by silently changing an addon-wide default.

- **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. Quality: Pending

#### Memory-mapped checkpoint reads `[model I/O]`

`mmap=true`: process-local memory-mapped reads of checkpoint files; evaluate startup/RSS separately from warm speed. No filesystem mount or system setting. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim. Quality: Video/audio files byte exact. 1 comparison.
- **RTX 5090 / Vulkan:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim. Quality: Video/audio files byte exact. 1 comparison.

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

#### Graph patch after FA: reverse-order confirmation `[graph optimization]`

Later repeated-context block, candidate run before baseline; one warmup and three measured requests per profile. Checks drift in the small graph-only increment.

- **RTX 5090 / CUDA:** Require agreement with the initial three-prompt block before accepting the small incremental engine change. Quality: Pending
- **RTX 5090 / Vulkan:** Require agreement with the initial three-prompt block before accepting the small incremental engine change. Quality: Pending

#### CUDA graphs: global FA control `[graph optimization]`

Separate GGML_CUDA_GRAPHS=ON builds, one full-size prompt, one warmup and three measured requests. Both builds run the unchanged correctness suite. Earlier focused CUDA builds had graphs disabled.

- **RTX 5090 / CUDA:** Use this control to check the graph-patch recommendation under the enabled build option. Native addon overlay and full CI remain required. Quality: Pending

#### CUDA graphs: patch added after FA `[graph optimization]`

Separate GGML_CUDA_GRAPHS=ON builds, one full-size prompt, one warmup and three measured requests. Both builds run the unchanged correctness suite. Earlier focused CUDA builds had graphs disabled.

- **RTX 5090 / CUDA:** Use this control to check the graph-patch recommendation under the enabled build option. Native addon overlay and full CI remain required. Quality: Pending

#### CUDA graphs: minimal patch + FA `[graph optimization]`

Separate GGML_CUDA_GRAPHS=ON builds, one full-size prompt, one warmup and three measured requests. Both builds run the unchanged correctness suite. Earlier focused CUDA builds had graphs disabled.

- **RTX 5090 / CUDA:** Use this control to check the graph-patch recommendation under the enabled build option. Native addon overlay and full CI remain required. Quality: Pending

#### CUDA graphs: build toggle control `[scheduling tuning]`

Same original H3 graph and global FA setting; only the CUDA-graphs build option differs. Compilation enables the path, while the backend still decides compatibility per graph.

- **RTX 5090 / CUDA:** Validation control, not a claim that an already-enabled shipping feature is a new optimization. Quality: Pending

### Production implementation tasks

1. Start with the accepted pinned-engine flash-attention profile. Match the H3 checkpoint family and resolved backend; preserve explicit flash_attn/fa settings and diffusion_fa. Keep the original setting for unsupported devices, models and request envelopes.
2. If the focused graph patch is selected, implement only its accepted backend branches in the engine model header. Resolve the actual execution backend when building the graph and retain the original operations elsewhere. Do not substitute the larger upstream patch or its Spark speed claim.
3. Validate the real engine change through a temporary addon vcpkg overlay. Run existing engine/operator tests and native addon audio-video comparisons for both optimized and fallback branches, including repeated requests, cancellation/error recovery and accepted full-size inputs.
4. For a VAE-only flash-attention selector or broader CUDA backport, treat API forwarding and math/layout changes as separate work. Repeat full-model quality checks; older CLI results do not prove the new addon integration.
5. After validation, use separate engine and registry PRs only if required, then repin the addon. Run the unchanged desktop CI matrix. Fresh Spark and additional Apple/AMD devices remain release-scope decisions; unvalidated configurations keep their baseline.

## 2. FLUX.2 Klein 4B Q8

A compact text-to-image model. Main tests use 1024 x 1024 images and 10 sampling steps; RTX also covers portrait 768 x 1024 and larger 1280 x 1280 requests. FLUX 3 Image Klein is a distinct compatibility target, not validated by these measurements.

### Approach × platform/API results

| Approach and type | RTX 5090 / CUDA | RTX 5090 / Vulkan | DGX Spark GB10 / CUDA (29 Oct) | M3 Ultra / Metal | Strix 8060S / Vulkan | Strix 8060S / HIP | Implement or reject — why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **GEMM VAE**<br>`[params tuning]` | **V**<br>8.786 -> 2.858 s;  -67.47% latency;  3.074x<br>Visually identical in reviewed outputs | **V**<br>2.605 -> 2.771 s;  +6.37% latency;  0.940x<br>Numerically compared; see quality details | **V - dated**<br>40.956 -> 15.433 s;  -62.32% latency;  2.654x<br>Visually identical in reviewed outputs | **V**<br>27.879 -> 30.780 s;  +10.41% latency;  0.906x<br>Numerically compared; see quality details | **V**<br>29.601 -> 47.245 s;  +59.61% latency;  0.627x<br>Numerically compared; see quality details | **V**<br>67.780 -> 33.569 s;  -50.47% latency;  2.019x<br>Visually identical in reviewed outputs | Recommend on measured CUDA and HIP, subject to memory/packaging gates. Reject on Metal/Vulkan because it regresses complete-request latency. Covers measured Klein 4B/decoder only, not the whole FLUX family. |
| **GEMM + CPU parameters**<br>`[combined profile]` | **V**<br>8.786 -> 3.365 s;  -61.70% latency;  2.611x<br>Numerically compared; see quality details | Not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Offer as a distinct lower-VRAM profile; do not infer fit on every nominal 8 GB card. |
| **GEMM VAE, 768x1024 confirmation**<br>`[params tuning]` | **V**<br>6.462 -> 2.106 s;  -67.41% latency;  3.068x<br>Numerically compared; see quality details | **V**<br>1.914 -> 2.073 s;  +8.31% latency;  0.923x<br>Numerically compared; see quality details | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Confirms the API-specific direction at this geometry: use a capacity-qualified CUDA profile, preserve direct convolution on Vulkan.<br>**RTX 5090 / Vulkan:** Confirms the API-specific direction at this geometry: use a capacity-qualified CUDA profile, preserve direct convolution on Vulkan. |
| **GEMM VAE, 1280x1280 confirmation**<br>`[params tuning]` | **V**<br>14.813 -> 4.999 s;  -66.25% latency;  2.963x<br>Numerically compared; see quality details | **V**<br>4.130 -> 4.401 s;  +6.56% latency;  0.938x<br>Numerically compared; see quality details | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Confirms the API-specific direction at this geometry: use a capacity-qualified CUDA profile, preserve direct convolution on Vulkan.<br>**RTX 5090 / Vulkan:** Confirms the API-specific direction at this geometry: use a capacity-qualified CUDA profile, preserve direct convolution on Vulkan. |
| **DiT matrix expansion to F16**<br>`[params tuning]` | **V**<br>2.865 -> 2.876 s;  +0.38% latency;  0.996x<br>Visible differences; not an equivalent-output profile | **V**<br>2.609 -> 2.533 s;  -2.91% latency;  1.030x<br>Pixels exact | Not checked | **V**<br>27.889 -> 26.884 s;  -3.60% latency;  1.037x<br>Pixels exact | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | API-specific, optional higher-memory warm profile only when exact output and repeated benefit are proven. Reject RTX CUDA: no incremental gain and visible changes. Retain quantized fallback everywhere; incomplete checks are not passes. |
| **F16 matrices, 1280-square confirmation**<br>`[params tuning]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Use to bound the optional Metal precision profile by tested geometry, exact output, startup and memory; original Q8 matrices remain the fallback. |
| **HIP force-blas**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>33.589 -> 34.978 s;  +4.14% latency;  0.960x<br>Numerically compared; see quality details | **Radeon 8060S / HIP:** Retain automatic kernel selection. A small one-prompt increment does not justify a backend-wide forced setting, especially with different model behavior. Require repeatable multi-prompt benefit and output parity before revisiting. |
| **HIP force-mmq**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>33.589 -> 33.402 s;  -0.56% latency;  1.006x<br>Numerically compared; see quality details | **Radeon 8060S / HIP:** Retain automatic kernel selection. A small one-prompt increment does not justify a backend-wide forced setting, especially with different model behavior. Require repeatable multi-prompt benefit and output parity before revisiting. |
| **SGLang / vLLM-Omni**<br>`[runtime choice]` | Not checked | Not checked | **V - dated**<br>Spark SGLang: 15.433 -> 5.993 s (-61.17%, 2.575x); vLLM-Omni: 15.324 -> 6.512 s (-57.50%, 2.353x).<br>Different content; not equivalent | Not checked | Not checked | Not checked | **GB10 / CUDA, 29 Oct:** Separate runtime option; not quality-equivalent or cold-start equivalent to QVAC. |
| **CPU parameter placement**<br>`[memory placement]` | Not checked | Not checked | Not checked | **V**<br>27.889 -> 28.374 s;  +1.74% latency;  0.983x<br>Pixels exact | **V**<br>29.601 -> 30.947 s;  +4.55% latency;  0.957x<br>Pixels exact | Not checked | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Diffusion flash attention disabled**<br>`[params tuning]` | Not checked | Not checked | Not checked | **V**<br>27.889 -> 122.796 s;  +340.30% latency;  0.227x<br>Numerically compared; see quality details | Not checked | Not checked | **M3 Ultra / Metal:** Reject: disabling an already-active fast path slows generation. Keep diffusion flash attention enabled. |
| **Metal commands per buffer: 2**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>27.889 -> 27.943 s;  +0.19% latency;  0.998x<br>Pixels exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. |
| **Metal commands per buffer: 4**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>27.889 -> 27.913 s;  +0.09% latency;  0.999x<br>Pixels exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. |
| **Metal serial encoding**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>27.889 -> 27.930 s;  +0.15% latency;  0.999x<br>Pixels exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. |
| **Vulkan host-memory selection**<br>`[memory placement]` | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | **V**<br>29.601 -> 29.927 s;  +1.10% latency;  0.989x<br>Pixels exact | Not applicable to this API | **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Vulkan synchronized submits**<br>`[scheduling tuning]` | Not applicable to this API | Not checked | Not applicable to this API | Not applicable to this API | **V**<br>29.601 -> 31.033 s;  +4.84% latency;  0.954x<br>Pixels exact | Not applicable to this API | **Radeon 8060S / Vulkan:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. |
| **GEMM VAE + F16 matrices**<br>`[combined profile]` | **V**<br>8.877 -> 2.876 s;  -67.60% latency;  3.087x<br>Numerically compared; see quality details | Not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Reject the F16 addition. GEMM alone provides the speed benefit; F16 is slightly slower, uses more memory and visibly changes one CUDA output. |
| **HIP rocWMMA attention after GEMM**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Decide from diffusion results; the [published LLM result](https://github.com/ggml-org/llama.cpp/issues/24437) is not a diffusion validation. |
| **Memory-mapped checkpoint reads**<br>`[model I/O]` | **V**<br>2.856 -> 2.837 s;  -0.67% latency;  1.007x<br>Pixels exact | **V**<br>2.595 -> 2.593 s;  -0.08% latency;  1.001x<br>Pixels exact | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim.<br>**RTX 5090 / Vulkan:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim. |

### Additional and partially checked approaches

| Improvement | Type | Checked | Speed effect: seconds, percent, ratio | Quality | Platform / API | Memory, tradeoffs and scope | Implement or reject: why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FA off / threads / queues / Vulkan host-memory tuning | Scheduling / control experiments | V | No reliable improvement over the chosen baseline; FA off is substantially slower. | Check individual records; API switching can visibly alter seeded output. | RTX CUDA/Vulkan, M3 Ultra Metal, Strix Vulkan/HIP as recorded | Diffusion flash attention is already enabled. Metal queue and thread changes are mostly within variation. | Keep the existing fast paths and explicit backend choice. |
| FLUX 3 Image Klein compatibility | Model compatibility work | Source review | No matched inference/performance result. | Not established. | Unvalidated model/backend combinations | FLUX 3 has distinct diffusion and Qwen3-VL components unsupported by the pinned loader. FLUX.2 Klein results do not establish compatibility or speed for it. | Separate model-support work before performance claims; preserve the measured FLUX.2 scope. |
| Upstream automatic convolution probes | Kernel selection policy | Source review | Not benchmarked as a policy. | Not established across its selections. | Potential Vulkan and other backends | [Upstream performance guidance](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/performance.md) documents small per-module kernel probes; a microprobe winner need not minimize full-generation latency. The policy is absent from this pinned-engine experiment. | Prefer the measured API-scoped setting first; validate any adaptive probe on startup, memory and complete requests before adoption. |
| Krea-oriented Strix Vulkan fork | Broader engine / kernel fork | Source review | No matched FLUX.2 result. | Reported images differ; parity for this checkpoint is unestablished. | Potential Strix Vulkan target | [Published gains](https://github.com/leejet/stable-diffusion.cpp/pull/1891) target Krea2 Turbo and a different engine/GGML combination. | Do not import the whole fork or transfer another model's speed claim. Any useful kernel needs a focused backport and matched tests. |

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

Implement a narrow FLUX.2 Klein 4B profile that sets `vae_conv_direct=false` for the measured CUDA VAE backends, and for tested Strix HIP after its packaging work. Preserve `vae_conv_direct=true` on Metal and Vulkan: GEMM regresses those measured APIs. The CUDA/HIP images are visually identical in reviewed comparisons, with small numerical differences; they are not byte-identical. The speed comes mainly from replacing direct VAE convolution with packing plus accelerated matrix multiplication. This uses an existing parameter and needs no engine algorithm or SDK change. The extra memory makes capacity-qualified selection essential. Matrix expansion is a separate optional warm-speed/memory tradeoff, never a blanket precision change.

| Platform / API | Suggested profile | Fallback and implementation gate |
| --- | --- | --- |
| RTX 5090 / CUDA | `vae_conv_direct=false`, original Q8 matrices: 8.786 -> 2.858 s; -67.47% latency; 3.074x; 5.928 s saved | Direct VAE if the higher-memory profile does not fit. GEMM plus CPU parameters is a separately measured lower-device-memory profile. Reject CUDA F16 addition. |
| RTX 5090 / Vulkan | Keep direct VAE and Q8 matrices. F16 is optional only for its separately checked exact-output warm gain. | GEMM is slower. F16 adds about 3.22 GiB device memory and worsens startup, so the original weights remain the default. |
| DGX Spark GB10 / CUDA, 29 Oct | `vae_conv_direct=false`: 40.956 -> 15.433 s, -62.32% (25.523 s saved). | Dated CUDA result. Retest on the final implementation revision; no Spark Vulkan result is claimed. |
| M3 Ultra / Metal | Keep direct VAE. F16 matrix-only expansion: 27.889 -> 26.884 s; -3.60% latency; 1.037x; 1.005 s saved | Original Q8 weights remain the lower-memory default. Expansion is optional only after exact-output/multi-shape confirmation; Metal GEMM is slower. |
| Radeon 8060S / Vulkan | Keep direct VAE; any F16 option depends on the completed clean precision pair. | Original Q8 weights and direct VAE. Interrupted precision runs are not accepted. GEMM is substantially slower. |
| Radeon 8060S / HIP | `vae_conv_direct=false`: 67.780 -> 33.569 s; -50.47% latency; 2.019x; 34.211 s saved | Direct VAE / original Q8 weights outside validated capacity. HIP requires release-module packaging, ABI and linking validation before production availability. |

**Measured cumulative effect**

- RTX CUDA GEMM plus CPU parameter placement: 8.786 -> 3.365 s; -61.70% latency; 2.611x; 5.421 s saved This trades additional transfer/host memory for much lower device usage; it is not as fast as resident GEMM.
- RTX CUDA GEMM plus F16 matrices: 8.877 -> 2.876 s; -67.60% latency; 3.087x; 6.001 s saved Reject the extra F16 setting: GEMM alone is slightly faster and avoids the visible poster change and extra memory.
- Do not combine CUDA GEMM with a Metal/Vulkan precision result or multiply their ratios. Metal/Vulkan keep direct convolution; Strix HIP precision combinations are accepted only if their own complete paired results pass.

**Startup and memory tradeoffs**

Resource observations for the paired profiles above. GB = 10^9 bytes; MiB = 2^20 bytes. Startup is load plus the first request in a fresh model context, with uncontrolled OS file cache. Process RSS and device-wide samples are separate counters; do not add them on unified-memory machines. Different rows may use different prompts or clip lengths.

| Profile / API | Load + first request | Peak process RSS | Sampled device memory | Primary stage change |
| --- | --- | --- | --- | --- |
| GEMM VAE / RTX 5090 / CUDA | 11.218 -> 5.218 s; -53.49% | 2.675 -> 2.712 GB; +1.36% | 11356.000 -> 15636.000 MiB; +37.69% | VAE: 6.240 -> 0.290 s; -95.35% |
| GEMM VAE / RTX 5090 / Vulkan | 4.675 -> 4.890 s; +4.60% | 2.404 -> 2.403 GB; -0.03% | 11084.000 -> 16685.000 MiB; +50.53% | VAE: 0.293 -> 0.457 s; +56.11% |
| GEMM VAE / M3 Ultra / Metal | 34.638 -> 33.084 s; -4.49% | 11.911 -> 11.804 GB; -0.90% | Unified memory; RSS is not total device usage | VAE: 3.805 -> 6.706 s; +76.25% |
| GEMM VAE / Radeon 8060S / Vulkan | 31.458 -> 51.960 s; +65.17% | 2.325 -> 5.371 GB; +131.08% | 11.140 -> 15.673 GB VRAM + GTT; +40.69% | VAE: 1.842 -> 19.660 s; +967.54% |
| GEMM VAE / Radeon 8060S / HIP | 75.554 -> 37.722 s; -50.07% | 2.605 -> 2.581 GB; -0.92% | 11.691 -> 16.626 GB VRAM + GTT; +42.21% | VAE: 39.415 -> 4.796 s; -87.83% |
| GEMM + CPU parameters / RTX 5090 / CUDA | 11.218 -> 9.230 s; -17.72% | 2.675 -> 9.331 GB; +248.80% | 11356.000 -> 7926.000 MiB; -30.20% | VAE: 6.240 -> 0.292 s; -95.31% |
| DiT matrix expansion to F16 / M3 Ultra / Metal | 34.936 -> 34.090 s; -2.42% | 11.851 -> 17.694 GB; +49.29% | Unified memory; RSS is not total device usage | Denoising: 23.433 -> 22.433 s; -4.26% |
| DiT matrix expansion to F16 / RTX 5090 / CUDA | 5.300 -> 5.767 s; +8.81% | 2.703 -> 2.973 GB; +10.00% | 15636.000 -> 18926.000 MiB; +21.04% | Denoising: 2.391 -> 2.405 s; +0.58% |
| DiT matrix expansion to F16 / RTX 5090 / Vulkan | 4.842 -> 5.132 s; +5.99% | 2.425 -> 2.599 GB; +7.17% | 11084.000 -> 14382.000 MiB; +29.75% | Denoising: 2.138 -> 2.068 s; -3.28% |

### Approach descriptions, decision reasons and change scope

- vae_conv_direct=false routes decoder convolutions through tensor packing and matrix multiplication. The accelerated matrix kernels help tested CUDA and HIP configurations, while additional packing and memory costs make the tested Vulkan and Metal paths slower. This is an existing engine parameter; the intended implementation is a narrowly scoped addon profile with explicit overrides preserved.
- The same decoder-family implementation can exist in other FLUX checkpoints, but the measured evidence covers Klein 4B Q8 and its tested VAE only. Do not enable it for the whole FLUX family or FLUX 3 based on these results.
- The higher-memory GEMM profile needs a tested capacity check. Explicit module placement currently returns unknown from the fit estimator, so unknown cannot authorize an automatic memory increase. Keep direct convolution as fallback outside the validated envelope.
- CPU parameter placement reduces RTX device-memory consumption while retaining most of the GEMM speed gain, at the cost of host memory and additional latency. It is not proof that the profile fits every nominal 8 GB GPU.
- The final Markdown report contains no comparison images. Visually identical labels refer to inspected outputs supported by full-output numerical comparisons; exact output and small visible texture changes are distinguished.
- The tested FLUX matrix-only tensor_type_rules value is `^model[.]diffusion_model[.](double_blocks|single_blocks)[.].*[.]weight$=f16`. Inspection selected 80 matrix tensors (7,361,003,520 bytes after expansion). This is an existing load-time conversion setting; no checkpoint download or new dependency is required.

#### GEMM VAE `[params tuning]`

- **RTX 5090 / CUDA:** Recommend as a capacity-qualified profile: a large repeated end-to-end gain with visually identical reviewed outputs. GEMM needs more device memory. HIP additionally requires release packaging/ABI validation; direct convolution remains the fallback. Quality: PSNR 58.72-60.28 dB; SSIM 0.999343-0.999585; RMS channel error 0.0969-0.1158% of full scale. Max channel error 2/255. Scope/tradeoff: Same model and sampling; vae_conv_direct=false. Main envelope 1024 x 1024 / 10 steps. native warm latency, matched prompt/seed/geometry.
- **RTX 5090 / Vulkan:** Reject on this API: complete requests are slower. Keep direct VAE convolution; CUDA/HIP gains must not change the Metal/Vulkan default. Quality: PSNR 60.49-61.18 dB; SSIM 0.999444-0.999631; RMS channel error 0.0873-0.0945% of full scale. Max channel error 1/255. Scope/tradeoff: Same model and sampling; vae_conv_direct=false. Main envelope 1024 x 1024 / 10 steps. native warm latency, matched prompt/seed/geometry.
- **M3 Ultra / Metal:** Reject on this API: complete requests are slower. Keep direct VAE convolution; CUDA/HIP gains must not change the Metal/Vulkan default. Quality: PSNR 70.76-72.47 dB; SSIM 0.999962-0.999976; RMS channel error 0.0238-0.0290% of full scale. Max channel error 1/255. Scope/tradeoff: Same model and sampling; vae_conv_direct=false. Main envelope 1024 x 1024 / 10 steps. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Reject on this API: complete requests are slower. Keep direct VAE convolution; CUDA/HIP gains must not change the Metal/Vulkan default. Quality: PSNR 56.17 dB; SSIM 0.998930; RMS channel error 0.1555% of full scale. Max channel error 2/255. Scope/tradeoff: Same model and sampling; vae_conv_direct=false. Main envelope 1024 x 1024 / 10 steps. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / HIP:** Recommend as a capacity-qualified profile: a large repeated end-to-end gain with visually identical reviewed outputs. GEMM needs more device memory. HIP additionally requires release packaging/ABI validation; direct convolution remains the fallback. Quality: PSNR 54.01-55.70 dB; SSIM 0.998164-0.998717; RMS channel error 0.1641-0.1994% of full scale. Max channel error 10/255. Scope/tradeoff: Same model and sampling; vae_conv_direct=false. Main envelope 1024 x 1024 / 10 steps. native warm latency, matched prompt/seed/geometry.
- **DGX Spark GB10 / CUDA, 29 Oct:** Recommend as a capacity-qualified profile: a large repeated end-to-end gain with visually identical reviewed outputs. GEMM needs more device memory. HIP additionally requires release packaging/ABI validation; direct convolution remains the fallback. Quality: PSNR approximately 59 dB; max 3/255 channel difference; reviewed images visually unchanged. Scope/tradeoff: Retained old revisions. CUDA acceleration does not imply Vulkan/Metal acceleration.

#### GEMM + CPU parameters `[combined profile]`

Sampled device peak 7926 MiB versus 15636 MiB for resident GEMM; more host memory and slower than resident GEMM. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Offer as a distinct lower-VRAM profile; do not infer fit on every nominal 8 GB card. Quality: PSNR 58.72-60.28 dB; SSIM 0.999343-0.999585; RMS channel error 0.0969-0.1158% of full scale. Max channel error 2/255.

#### GEMM VAE, 768x1024 confirmation `[params tuning]`

Additional geometry control, same checkpoint and ten sampling steps; one prompt with repeated warm requests. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Confirms the API-specific direction at this geometry: use a capacity-qualified CUDA profile, preserve direct convolution on Vulkan. Quality: PSNR 59.59 dB; SSIM 0.999539; RMS channel error 0.1048% of full scale. Max channel error 2/255.
- **RTX 5090 / Vulkan:** Confirms the API-specific direction at this geometry: use a capacity-qualified CUDA profile, preserve direct convolution on Vulkan. Quality: PSNR 60.86 dB; SSIM 0.999595; RMS channel error 0.0906% of full scale. Max channel error 1/255.

#### GEMM VAE, 1280x1280 confirmation `[params tuning]`

Additional geometry control, same checkpoint and ten sampling steps; one prompt with repeated warm requests. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Confirms the API-specific direction at this geometry: use a capacity-qualified CUDA profile, preserve direct convolution on Vulkan. Quality: PSNR 59.84 dB; SSIM 0.999597; RMS channel error 0.1018% of full scale. Max channel error 2/255.
- **RTX 5090 / Vulkan:** Confirms the API-specific direction at this geometry: use a capacity-qualified CUDA profile, preserve direct convolution on Vulkan. Quality: PSNR 61.32 dB; SSIM 0.999655; RMS channel error 0.0859% of full scale. Max channel error 1/255.

#### DiT matrix expansion to F16 `[params tuning]`

- **M3 Ultra / Metal:** Optional higher-memory warm-latency profile only: measured output is exact and repeated warm requests improve. Expansion increases memory and can increase startup cost. Keep original quantized matrices as the default/fallback until capacity and startup policy are validated; do not extend this rule to other checkpoints. Quality: Decoded pixels exact. 1 comparison. Scope/tradeoff: Expand only Q8 transformer block weight matrices at load time. Verify rule matching, startup and memory. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Pending speed/quality confirmation; not the original unquantized checkpoint. Quality: Pending Scope/tradeoff: Expand only Q8 transformer block weight matrices at load time. Verify rule matching, startup and memory.
- **Radeon 8060S / HIP:** Pending speed/quality confirmation; not the original unquantized checkpoint. Quality: Pending Scope/tradeoff: Expand only Q8 transformer block weight matrices at load time. Verify rule matching, startup and memory.
- **RTX 5090 / CUDA:** Reject: no incremental CUDA speed benefit, about 3.21 GiB more device memory, and a visibly changed poster test. Keep Q8 matrices with GEMM VAE. Quality: PSNR 22.70-45.75 dB; SSIM 0.937829-0.997152; RMS channel error 0.5158-7.3303% of full scale. Max channel error 254/255. Scope/tradeoff: Three prompts, 1024 x 1024, warm repetitions. CUDA reference already uses GEMM; Vulkan retains direct VAE. native warm latency, matched prompt/seed/geometry.
- **RTX 5090 / Vulkan:** Optional higher-memory warm-latency profile only: measured output is exact and repeated warm requests improve. Expansion increases memory and can increase startup cost. Keep original quantized matrices as the default/fallback until capacity and startup policy are validated; do not extend this rule to other checkpoints. Quality: Decoded pixels exact. 3 comparisons. Scope/tradeoff: Three prompts, 1024 x 1024, warm repetitions. CUDA reference already uses GEMM; Vulkan retains direct VAE. native warm latency, matched prompt/seed/geometry.

#### F16 matrices, 1280-square confirmation `[params tuning]`

One prompt at 1280 x 1280, one warmup and three measured requests. Same verified matrix-only rule as the 1024-square confirmation.

- **M3 Ultra / Metal:** Use to bound the optional Metal precision profile by tested geometry, exact output, startup and memory; original Q8 matrices remain the fallback. Quality: Pending

#### HIP force-blas `[kernel optimization]`

Corrected ABI128 backend, one prompt with warm repetitions. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / HIP:** Retain automatic kernel selection. A small one-prompt increment does not justify a backend-wide forced setting, especially with different model behavior. Require repeatable multi-prompt benefit and output parity before revisiting. Quality: PSNR 22.93 dB; SSIM 0.907176; RMS channel error 7.1334% of full scale. Max channel error 240/255.

#### HIP force-mmq `[kernel optimization]`

Corrected ABI128 backend, one prompt with warm repetitions. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / HIP:** Retain automatic kernel selection. A small one-prompt increment does not justify a backend-wide forced setting, especially with different model behavior. Require repeatable multi-prompt benefit and output parity before revisiting. Quality: PSNR 18.61 dB; SSIM 0.810486; RMS channel error 11.7336% of full scale. Max channel error 237/255.

#### SGLang / vLLM-Omni `[runtime choice]`

Startup regresses: SGLang load+first 17.602 -> 58.792 s; vLLM 17.732 -> 68.093 s.

- **GB10 / CUDA, 29 Oct:** Separate runtime option; not quality-equivalent or cold-start equivalent to QVAC. Quality: Different images/RNG/math and tensor handling; SGLang PSNR 11.67.

#### CPU parameter placement `[memory placement]`

`params_backend=cpu`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Decoded pixels exact. 1 comparison.
- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Decoded pixels exact. 1 comparison.

#### Diffusion flash attention disabled `[params tuning]`

`diffusion_fa=false`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Reject: disabling an already-active fast path slows generation. Keep diffusion flash attention enabled. Quality: PSNR 58.08 dB; SSIM 0.999753; RMS channel error 0.1247% of full scale. Max channel error 22/255.

#### Metal commands per buffer: 2 `[scheduling tuning]`

`GGML_METAL_N_CB=2`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Decoded pixels exact. 1 comparison.

#### Metal commands per buffer: 4 `[scheduling tuning]`

`GGML_METAL_N_CB=4`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Decoded pixels exact. 1 comparison.

#### Metal serial encoding `[scheduling tuning]`

`GGML_METAL_CONCURRENCY_DISABLE=1`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Decoded pixels exact. 1 comparison.

#### Vulkan host-memory selection `[memory placement]`

`GGML_VK_PREFER_HOST_MEMORY=1`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Decoded pixels exact. 1 comparison.

#### Vulkan synchronized submits `[scheduling tuning]`

`GGML_VK_DISABLE_ASYNC=1`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **Radeon 8060S / Vulkan:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Decoded pixels exact. 1 comparison.

#### GEMM VAE + F16 matrices `[combined profile]`

Directly measured combination against the same-cohort direct/Q8 baseline. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Reject the F16 addition. GEMM alone provides the speed benefit; F16 is slightly slower, uses more memory and visibly changes one CUDA output. Quality: PSNR 22.70-45.76 dB; SSIM 0.937919-0.997174; RMS channel error 0.5153-7.3306% of full scale. Max channel error 254/255.

#### HIP rocWMMA attention after GEMM `[kernel optimization]`

`GGML_HIP_ROCWMMA_FATTN=ON`, matching pinned GGML and ABI128; rocWMMA headers extracted inside the test workspace. Installed ROCm unchanged. This is a backend build option, not a per-request setting; selective production use needs a validated dispatch/build policy and the original kernel fallback.

- **Radeon 8060S / HIP:** Decide from diffusion results; the [published LLM result](https://github.com/ggml-org/llama.cpp/issues/24437) is not a diffusion validation. Quality: Pending

#### Memory-mapped checkpoint reads `[model I/O]`

`mmap=true`: process-local memory-mapped reads of checkpoint files; evaluate startup/RSS separately from warm speed. No filesystem mount or system setting. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim. Quality: Decoded pixels exact. 1 comparison.
- **RTX 5090 / Vulkan:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim. Quality: Decoded pixels exact. 1 comparison.

### Production implementation tasks

1. Implement a model/decoder-specific profile using the existing vae_conv_direct parameter only on accepted CUDA/HIP configurations. Preserve explicit true/false values; plain default-valued booleans currently do not distinguish an omitted option from an explicit override.
2. Choose using the resolved VAE backend, including per-module assignments. A generic GPU or NVIDIA identifier is insufficient because Vulkan results differ from CUDA. Preserve direct convolution on the tested Metal/Vulkan paths and all unvalidated combinations.
3. Keep higher-memory profiles explicitly selected until capacity handling is proven. Validate allocation/repeated-request behavior; assessFit returning unknown must preserve the baseline. Treat GEMM plus CPU parameters as a separate lower-device-memory profile.
4. If F16 matrix expansion is selected on a proven platform, use the verified checkpoint-specific matrix-only rule. Preserve custom tensor_type_rules. Test startup, sustained memory and every accepted request geometry; expansion does not restore the original unquantized checkpoint.
5. Add focused selection/override/fallback tests and run the existing addon integration and full desktop CI matrix. Check other FLUX checkpoints, reference-image/editing modes and larger shapes before broadening scope. No SDK or engine algorithm change is needed for the existing parameter itself.

## 3. LTX-2.3 22B distilled Q5

An audio-video generation model using a distilled 22B diffusion transformer. Tests use 512 x 320, 8 sampling steps and 97 or 193 frames, including repeated requests and several prompts where completed.

### Approach × platform/API results

| Approach and type | RTX 5090 / CUDA | RTX 5090 / Vulkan | DGX Spark GB10 / CUDA (29 Oct) | M3 Ultra / Metal | Strix 8060S / Vulkan | Strix 8060S / HIP | Implement or reject — why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **VAE residency, 97 frames**<br>`[memory placement]` | Not checked | **V**<br>15.195 -> 14.167 s;  -6.77% latency;  1.073x<br>Output byte-exact | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / Vulkan:** Recommend only a capacity-checked profile; preserve CPU-weight fallback. |
| **Full-temporal decode, 97 frames**<br>`[params tuning]` | **V**<br>13.294 -> 12.645 s;  -4.88% latency;  1.051x<br>Small visual differences; audio exact where stated | Not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Optional minor-change quality tier; keep temporal tiling for strict baseline behavior. |
| **VAE residency, 193 frames**<br>`[memory placement]` | Not checked | **V**<br>24.440 -> 22.167 s;  -9.30% latency;  1.103x<br>Output byte-exact | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / Vulkan:** Recommend only a capacity-checked profile; preserve CPU-weight fallback. |
| **Full-temporal decode, 193 frames**<br>`[params tuning]` | **V**<br>22.700 -> 21.060 s;  -7.22% latency;  1.078x<br>Small visual differences; audio exact where stated | Not checked | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Optional minor-change quality tier; keep temporal tiling for strict baseline behavior. |
| **Full-temporal decode**<br>`[params tuning]` | Not checked | Not checked | **V - dated**<br>97 frames: 37.802 -> 36.678 s (-2.97%, 1.031x); 193 frames: 74.142 -> 70.780 s (-4.53%, 1.047x).<br>Small visual differences; audio exact where stated | **V**<br>92.877 -> 91.742 s;  -1.22% latency;  1.012x<br>Numerically compared; see quality details | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **M3 Ultra / Metal:** Reject as the preferred Metal speed profile: the gain is only around one percent and introduces output differences. Prefer the exact-output baseline, or separately validated matrix expansion when memory permits.<br>**Radeon 8060S / Vulkan:** Decide from this API result; do not transfer the CUDA recommendation automatically.<br>**Radeon 8060S / HIP:** Decide from this API result; do not transfer the CUDA recommendation automatically.<br>**DGX Spark GB10 / CUDA, 29 Oct:** Optional quality-tier choice; do not promise faster cold/first-request latency. |
| **DiT matrix expansion to F16**<br>`[params tuning]` | Not checked | Not checked | Not checked | **V**<br>92.877 -> 88.428 s;  -4.79% latency;  1.050x<br>Output byte-exact | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Optional exact-output, high-memory warm profile only where confirmed. Preserve original Q5 storage for capacity/startup safety. A successful M3 Ultra run does not establish a fit on smaller Apple devices or RTX. |
| **VAE residency + full-temporal**<br>`[combined profile]` | Not checked | **V**<br>15.195 -> 14.144 s;  -6.92% latency;  1.074x<br>Output byte-exact | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / Vulkan:** Prefer the simpler residency-only profile when the incremental gain is within variation. |
| **Residency + full-temporal**<br>`[combined profile]` | Not checked | Not checked | **V - dated**<br>39.777 -> 36.678 s;  -7.79% latency;  1.084x<br>Residency exact; temporal change has small visual differences and exact audio. | Not checked | Not checked | Not checked | **DGX Spark GB10 / CUDA, 29 Oct:** Do not count already-selected residency as a new improvement over the resident baseline. |
| **Metal dispatch grouping, 97 frames**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>122.930 -> 119.540 s;  -2.76% latency;  1.028x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject: no reliable complete-request speed benefit to justify even the small backend change. Retain the current dispatch. Correctness-suite passes do not establish a performance improvement. |
| **Metal dispatch grouping, 193 frames**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>198.650 -> 198.590 s;  -0.03% latency;  1.000x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject: no reliable complete-request speed benefit to justify even the small backend change. Retain the current dispatch. Correctness-suite passes do not establish a performance improvement. |
| **Metal per-value packing**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>112.030 -> 106.260 s;  -5.15% latency;  1.054x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject: slower decoder and no credible end-to-end compute gain to justify four changed backend files. |
| **SGLang / vLLM-Omni**<br>`[runtime choice]` | Not checked | Not checked | **V / partial - dated**<br>Spark SGLang: 37.802 -> 12.578 s (-66.73%, 3.005x).<br>Different content; not equivalent | Not checked | Not checked | Not checked | **GB10 / CUDA, 29 Oct:** Separate runtime/model work, not an equivalent implementation candidate. |
| **CPU parameter placement**<br>`[memory placement]` | Not checked | Not checked | Not checked | **V**<br>92.877 -> 95.573 s;  +2.90% latency;  0.972x<br>Output byte-exact | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / HIP:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **2D VAE GEMM control**<br>`[params tuning]` | Not checked | Not checked | Not checked | **V**<br>92.877 -> 92.889 s;  +0.01% latency;  1.000x<br>Output byte-exact | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior.<br>**Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks.<br>**Radeon 8060S / HIP:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. |
| **Metal commands per buffer: 2**<br>`[scheduling tuning]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | **V**<br>92.877 -> 93.221 s;  +0.37% latency;  0.996x<br>Output byte-exact | Not applicable to this API | Not applicable to this API | **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. |
| **HIP rocWMMA attention**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Decide from diffusion results; the [published LLM result](https://github.com/ggml-org/llama.cpp/issues/24437) is not a diffusion validation. |
| **HIP force-blas**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. |
| **HIP force-mmq**<br>`[kernel optimization]` | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | Not applicable to this API | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. |
| **Memory-mapped checkpoint reads**<br>`[model I/O]` | **V**<br>13.221 -> 13.420 s;  +1.51% latency;  0.985x<br>Output byte-exact | **V**<br>14.056 -> 14.157 s;  +0.72% latency;  0.993x<br>Output byte-exact | Not checked | Not checked | Not checked | Not checked | **RTX 5090 / CUDA:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim.<br>**RTX 5090 / Vulkan:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim. |
| **F16 matrices + full-temporal decode**<br>`[combined profile]` | Not checked | Not checked | Not checked | **Not checked yet**<br>Not yet collected/validated<br>Quality not checked | Not checked | Not checked | **M3 Ultra / Metal:** Prefer F16 alone for exact output unless the incremental temporal benefit justifies its quality tradeoff. |

### Additional and partially checked approaches

| Improvement | Type | Checked | Speed effect: seconds, percent, ratio | Quality | Platform / API | Memory, tradeoffs and scope | Implement or reject: why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LTX-2.5 compatibility | Model compatibility work | Source review | No matched inference/performance result. | Not established. | Unvalidated model/backend combinations | The newer Gemma4/DVAE components are unsupported by the pinned loader; these are different components from the measured LTX-2.3 checkpoint set. | Separate compatibility work before performance comparisons; do not broaden the LTX-2.3 profile automatically. |

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

Use exact-output placement first: on RTX Vulkan, keep only VAE weights on GPU when capacity permits. This improves 97- and 193-frame requests without changing the output. CUDA full-temporal decoding is a separate minor-output-change option, with larger benefit on longer clips; keep temporal tiling for strict baseline behavior. On Metal, matrix-only F16 expansion is an optional high-memory profile if the completed confirmation remains exact; the much smaller temporal gain does not justify changing the preferred output tier. Retain existing settings where Strix checks are incomplete or neutral. The Metal kernel rewrites are rejected because they did not establish a reliable end-to-end benefit.

| Platform / API | Suggested profile | Fallback and implementation gate |
| --- | --- | --- |
| RTX 5090 / CUDA | Strict profile: existing settings. Optional full-temporal 193-frame decode: 22.700 -> 21.060 s; -7.22% latency; 1.078x; 1.640 s saved | Keep temporal tiling when exact baseline output is required. Full-temporal changes texture/contrast slightly, has exact audio in comparisons, and needs its memory/length gate. |
| RTX 5090 / Vulkan | VAE-only residency: 15.195 -> 14.167 s; -6.77% latency; 1.073x; 1.028 s saved at 97 frames; 24.440 -> 22.167 s; -9.30% latency; 1.103x; 2.273 s saved at 193 frames. | `params_backend="cpu,vae=vulkan0"` in the tested setup; preserve CPU-weight fallback when capacity is unknown. Never infer that the full model fits. |
| DGX Spark GB10 / CUDA, 29 Oct | Keep its resident baseline. Optional full-temporal decode: -2.97% at 97 frames, -4.53% at 193 frames. | Dated CUDA result; small visual differences and a first-request regression at 193 frames. Retain tiled decoding for strict output/startup requirements. |
| M3 Ultra / Metal | Original decoder; optional matrix-only F16: 92.877 -> 88.428 s; -4.79% latency; 1.050x; 4.450 s saved | Original Q5 matrix storage is the lower-memory fallback. Expansion adds about 20 GB process RSS in the initial screen; 96 GiB M3 Ultra evidence does not cover M3 Pro/smaller machines. |
| Radeon 8060S / Vulkan | Use only the completed clean Vulkan results in the table; keep current stateful decode and parameter placement otherwise. | Temporal flag is redundant on the existing Vulkan decoder. No improvement is assumed from another API or from an interrupted run. |
| Radeon 8060S / HIP | Use only the completed clean HIP results in the table; production HIP packaging is a separate requirement. | Current quantized matrices and tiled decoding unless a complete reliable pair supports a separate explicit profile. |

**Measured cumulative effect**

- RTX Vulkan residency plus full-temporal: 15.195 -> 14.144 s; -6.92% latency; 1.074x; 1.051 s saved Residency alone accounts for the useful gain; the redundant temporal toggle adds only measurement-scale variation.
- Mac F16 plus full-temporal: No accepted completed paired measurement. Compare this directly with F16 alone, and retain its distinct output-quality tier.
- Dated Spark CPU-weight control -> residency plus full-temporal: 39.777 -> 36.678 s (-7.79%, 3.099 s saved). Since residency is already the selected Spark baseline, the new temporal increment is only 37.802 -> 36.678 s (-2.97%).

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
- The tested LTX matrix-only tensor_type_rules value is `^model[.]diffusion_model[.]transformer_blocks[.].*(to_q|to_k|to_v|to_out[.]0|to_gate_logits|net[.]0[.]proj|net[.]2)[.]weight$=f16`. Inspection selected 1632 matrix tensors (37,100,716,032 bytes after expansion). Keep this separate from VAE/text-encoder precision and preserve caller-supplied rules.

#### VAE residency, 97 frames `[memory placement]`

97 frames: three prompts; 193 frames: one prompt. Adds device memory. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / Vulkan:** Recommend only a capacity-checked profile; preserve CPU-weight fallback. Quality: Video/audio files byte exact. 3 comparisons.

#### Full-temporal decode, 97 frames `[params tuning]`

Decode the complete latent sequence together; slightly higher memory. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Optional minor-change quality tier; keep temporal tiling for strict baseline behavior. Quality: PSNR 43.82-50.71 dB; SSIM 0.996474-0.997734; RMS channel error 0.2912-0.6442% of full scale. Worst frame 40.84 dB. Audio exact. Subtle texture/contrast differences are possible; audio is compared separately.

#### VAE residency, 193 frames `[memory placement]`

97 frames: three prompts; 193 frames: one prompt. Adds device memory. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / Vulkan:** Recommend only a capacity-checked profile; preserve CPU-weight fallback. Quality: Video/audio files byte exact. 1 comparison.

#### Full-temporal decode, 193 frames `[params tuning]`

Decode the complete latent sequence together; slightly higher memory. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Optional minor-change quality tier; keep temporal tiling for strict baseline behavior. Quality: PSNR 46.39 dB; SSIM 0.996980; RMS channel error 0.4794% of full scale. Worst frame 43.76 dB. Audio exact. Subtle texture/contrast differences are possible; audio is compared separately.

#### Full-temporal decode `[params tuning]`

- **M3 Ultra / Metal:** Reject as the preferred Metal speed profile: the gain is only around one percent and introduces output differences. Prefer the exact-output baseline, or separately validated matrix expansion when memory permits. Quality: PSNR 50.04 dB; SSIM 0.998227; RMS channel error 0.3149% of full scale. Worst frame 47.60 dB. Audio exact. Scope/tradeoff: 512 x 320, 97 frames. Vulkan already uses its stateful path. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Decide from this API result; do not transfer the CUDA recommendation automatically. Quality: Pending Scope/tradeoff: 512 x 320, 97 frames. Vulkan already uses its stateful path.
- **Radeon 8060S / HIP:** Decide from this API result; do not transfer the CUDA recommendation automatically. Quality: Pending Scope/tradeoff: 512 x 320, 97 frames. Vulkan already uses its stateful path.
- **DGX Spark GB10 / CUDA, 29 Oct:** Optional quality-tier choice; do not promise faster cold/first-request latency. Quality: Small texture/contrast differences; 193-frame PSNR 46.59 dB; audio exact. Scope/tradeoff: 193-frame first request regressed 74.439 -> 77.710 s (+4.39%).

#### DiT matrix expansion to F16 `[params tuning]`

- **M3 Ultra / Metal:** Optional higher-memory warm-latency profile only: measured output is exact and repeated warm requests improve. Expansion increases memory and can increase startup cost. Keep original quantized matrices as the default/fallback until capacity and startup policy are validated; do not extend this rule to other checkpoints. Quality: Video/audio files byte exact. 1 comparison. Scope/tradeoff: Verified rule selects 1632 quantized matrix weights (37.10 GB after expansion), excluding normalization and embedding weights. Same checkpoint and sampling. native warm latency, matched prompt/seed/geometry.
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

- **M3 Ultra / Metal:** Reject: no reliable complete-request speed benefit to justify even the small backend change. Retain the current dispatch. Correctness-suite passes do not establish a performance improvement. Quality: Video/audio files byte exact. 1 comparison.

#### Metal dispatch grouping, 193 frames `[kernel optimization]`

Unchanged per-position kernel grouped into up to 128 threads. Inspect decoder stage and checkpoint I/O. Fresh CLI context each repetition; generation and process wall time separately..

- **M3 Ultra / Metal:** Reject: no reliable complete-request speed benefit to justify even the small backend change. Retain the current dispatch. Correctness-suite passes do not establish a performance improvement. Quality: Video/audio files byte exact. 1 comparison.

#### Metal per-value packing `[kernel optimization]`

Apparent total gain is I/O-confounded. Decoder median regressed 6.130 -> 8.605 s (+40.38%). Optional extra performance cases were not run; correctness suites passed. Fresh CLI context each repetition; generation and process wall time separately..

- **M3 Ultra / Metal:** Reject: slower decoder and no credible end-to-end compute gain to justify four changed backend files. Quality: Video/audio files byte exact. 1 comparison.

#### SGLang / vLLM-Omni `[runtime choice]`

Load+first 44.075 -> 326.362 s; 66.73 GiB reserved, outside RTX capacity. No matched vLLM adapter.

- **GB10 / CUDA, 29 Oct:** Separate runtime/model work, not an equivalent implementation candidate. Quality: Different valid scene/audio; PSNR 10.74; parity not established.

#### CPU parameter placement `[memory placement]`

- **M3 Ultra / Metal:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Video/audio files byte exact. 1 comparison. Scope/tradeoff: `params_backend=cpu`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending Scope/tradeoff: `params_backend=cpu`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.
- **Radeon 8060S / HIP:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending Scope/tradeoff: `params_backend=cpu`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.

#### 2D VAE GEMM control `[params tuning]`

- **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Video/audio files byte exact. 1 comparison. Scope/tradeoff: `vae_conv_direct=false`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.
- **Radeon 8060S / Vulkan:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending Scope/tradeoff: `vae_conv_direct=false`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.
- **Radeon 8060S / HIP:** Retain the existing profile unless the measured benefit is repeatable, material and passes quality/memory checks. Quality: Pending Scope/tradeoff: `vae_conv_direct=false`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed.

#### Metal commands per buffer: 2 `[scheduling tuning]`

`GGML_METAL_N_CB=2`. One-prompt parameter screen; retain individual run/stage/resource records. No global default change is proposed. native warm latency, matched prompt/seed/geometry.

- **M3 Ultra / Metal:** Reject as a default speed change: neutral, slower or too small in this screen to justify changing scheduling/kernel policy. Keep the baseline and its existing cross-platform behavior. Quality: Video/audio files byte exact. 1 comparison.

#### HIP rocWMMA attention `[kernel optimization]`

`GGML_HIP_ROCWMMA_FATTN=ON`, matching pinned GGML and ABI128; rocWMMA headers extracted inside the test workspace. Installed ROCm unchanged. This is a backend build option, not a per-request setting; selective production use needs a validated dispatch/build policy and the original kernel fallback.

- **Radeon 8060S / HIP:** Decide from diffusion results; the [published LLM result](https://github.com/ggml-org/llama.cpp/issues/24437) is not a diffusion validation. Quality: Pending

#### HIP force-blas `[kernel optimization]`

`GGML_CUDA_FORCE_CUBLAS=ON` (HIPBLAS on this backend). Existing compile-time forced-selection control; same corrected tensor-name ABI and checkpoint. It affects the backend module, so mixed model results cannot be solved by silently changing an addon-wide default.

- **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. Quality: Pending

#### HIP force-mmq `[kernel optimization]`

`GGML_CUDA_FORCE_MMQ=ON`. Existing compile-time forced-selection control; same corrected tensor-name ABI and checkpoint. It affects the backend module, so mixed model results cannot be solved by silently changing an addon-wide default.

- **Radeon 8060S / HIP:** Require numerical output checks and repeatable incremental speed before any production selection change. Quality: Pending

#### Memory-mapped checkpoint reads `[model I/O]`

`mmap=true`: process-local memory-mapped reads of checkpoint files; evaluate startup/RSS separately from warm speed. No filesystem mount or system setting. native warm latency, matched prompt/seed/geometry.

- **RTX 5090 / CUDA:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim. Quality: Video/audio files byte exact. 1 comparison.
- **RTX 5090 / Vulkan:** Keep as an existing explicit I/O option, not an inferred inference-speed optimization. Outputs are exact, but warm changes are small and the OS file cache was uncontrolled. A cold-storage/RSS study is required before a startup claim. Quality: Video/audio files byte exact. 1 comparison.

#### F16 matrices + full-temporal decode `[combined profile]`

Directly measured cumulative effect; the temporal change has a distinct output-quality tier.

- **M3 Ultra / Metal:** Prefer F16 alone for exact output unless the incremental temporal benefit justifies its quality tradeoff. Quality: Pending

### Production implementation tasks

1. Implement exact-output memory placement first on the accepted API/capacity combination. For RTX Vulkan the measured setting is params_backend="cpu,vae=vulkan0". Preserve offloaded fallback and never infer that the whole model fits on a 32 GB GPU.
2. Offer temporal_tiling=false only in the accepted minor-output-change tier and tested lengths/APIs. Preserve tiled decoding for strict baseline output. Do not count a redundant temporal flag on the existing Vulkan stateful path as an additional optimization.
3. If F16 matrix expansion is selected, use the verified 1632-matrix rule, not a blanket precision override. Measure memory, load/first-request latency and repeated 97/193-frame generation. Keep quantized weights when capacity or incremental benefit is unproven.
4. Do not carry the rejected Metal packing/dispatch code, broad upstream upgrade or slower CUDA stateful/3D-GEMM alternatives into the release feature. Any new kernel should have independent operator coverage plus a repeatable end-to-end benefit.
5. Run existing audio-video integration tests and the full desktop CI matrix on the final selection policy. Validate combined profiles directly, fallback behavior, mixed backend assignments and longer/reference-conditioned requests before widening the release envelope.

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
- Completed local addon checks: 137/137 Bare unit tests, 89/89 Node unit tests, typecheck and lint. Lint retains 70 pre-existing warnings. These checks validate the existing addon and research harness; they do not validate the future selection policy.
- Focused H3 baseline/candidate builds passed 26 CTests on CUDA, 21 on RTX Vulkan and 23 on Metal, including independent fused-operation/QKV-view checks. Metal end-to-end output differences still disqualify that patch from the preferred Metal profile. Operator tests alone cannot establish full-model equivalence.
- Metal packing/dispatch experiments passed their existing suites and independent operator checks, but were rejected on performance evidence. The greater-than-2^32-element packing specialization was not exercised.
- Corrected baseline/forced-BLAS/forced-MMQ HIP backend builds passed their four existing CTests. The separately queued rocWMMA build has its own result and cannot inherit those passes.
- No new full desktop CI run certifies a November production feature: no such feature has been implemented. The retained October workflow passed 37 jobs with 14 conditional routes, including a 98/98 Windows retry; that historical run is not a replacement for implementation CI. RTX research builds used local Clang 20.1.8; release builds must use the repository CI toolchain.

## Primary sources

- [Metal IM2COL_3D parallel packing](https://github.com/0xShug0/audio.cpp/pull/1169)
- [Strix quantized matrix multiplication versus hipBLAS selection](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)
- [rocWMMA flash attention on Strix](https://github.com/ggml-org/llama.cpp/issues/24437)
- [rocWMMA flash attention on Strix](https://github.com/ROCm/rocWMMA/blob/develop_deprecated/README.md)
- [rocWMMA flash attention on Strix](https://github.com/ggml-org/llama.cpp/discussions/20856)
- [Alternative runtimes on new platforms](https://github.com/vllm-project/vllm-metal/blob/main/docs/supported_models.md)
- [Alternative runtimes on new platforms](https://github.com/sgl-project/sglang/blob/main/python/sglang/multimodal_gen/README.md)
- [Alternative runtimes on new platforms](https://github.com/vllm-project/vllm-omni/blob/main/recipes/MiniMaxAI/MiniMax-H3.md)
- [Token-axis H3 MLP chunking for Vulkan buffer limits](https://github.com/leejet/stable-diffusion.cpp/pull/2257)
- [Avoid blanket upstream memory-manager upgrade](https://github.com/leejet/stable-diffusion.cpp/issues/1976)
- [Backend-specific convolution selection versus upstream auto probes](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/backend.md)
- [Backend-specific convolution selection versus upstream auto probes](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/performance.md)
- [Backend-specific convolution selection versus upstream auto probes](https://github.com/leejet/stable-diffusion.cpp/issues/1215)
- [Metal flash-attention vector tuning tables](https://github.com/ggml-org/llama.cpp/discussions/27668)
- [Krea Vulkan fork optimizations on Strix](https://github.com/leejet/stable-diffusion.cpp/pull/1891)
- [LTX quantized matrix expansion to F16 at load time](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/common/common.cpp)
- [Model-loader process-local mmap](https://github.com/leejet/stable-diffusion.cpp/discussions/1855)
