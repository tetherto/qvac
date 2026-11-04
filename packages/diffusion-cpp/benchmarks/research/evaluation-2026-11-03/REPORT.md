# Diffusion speed research: team report

Speed-improvement research for three diffusion models is complete; the selected approaches still need production implementation and release checks.

| Platform / API | System and accelerator | Measurements |
| --- | --- | --- |
| RTX 5090 / CUDA; RTX 5090 / Vulkan | Linux x64, NVIDIA GeForce RTX 5090 | 3 November 2026 |
| DGX Spark GB10 / CUDA | Linux arm64, NVIDIA GB10 | 29 October 2026; retained results |
| M3 Ultra / Metal | Mac Studio, macOS arm64, 60 GPU cores, 96 GiB unified memory | 3 November 2026 |
| Strix 8060S / Vulkan; Strix 8060S / HIP | Linux x64, Ryzen AI MAX+ 395, Radeon 8060S | 3 November 2026; Vulkan/RADV and HIP/ROCm |

**Reading the tables:** values are latency changes; negative is faster. **V** = tested, **P** = partly tested, **N** = no completed test. A dash means no result for that platform, not a pass. Counts refer to the approach groups listed below; repeated tests and combinations are not counted again. Related scheduling or cache settings share one row. Selected candidates are a subset of tested approaches.

Times are warm, single-request measurements. Percentages use original values before rounding. “Exact” means matching decoded pixels or video/audio, as recorded. “Visually identical” means no visible difference in reviewed samples, with small numerical differences. Full measurements and settings remain in [report-content.json](report-content.json) and [reproduction-records.json](reproduction-records.json).

## 1. MiniMax-H3 FL2VA Q4

**20 approach groups: 15 tested, including partial checks; 5 untested; 2 selected for speed.**

Generates video with synchronized audio. Full-size checks used 960 × 544 and 124 frames; short checks used 512 × 288 and 39 frames.

### Approach × platform/API results

| Approach / tag | Checked | RTX CUDA | RTX Vulkan | Spark CUDA | Mac Metal | Strix Vulkan | Strix HIP | Decision and quality |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Global flash attention / **FA** | P | 120.4 → 113.8 s; **−5.5%** | 103.6 → 94.7 s; **−8.6%** | 659.7 → 604.9 s; **−8.3%** | 1543.9 → 1238.2 s; **−19.8%** | 1415.2 → 1369.2 s; **−3.2%** | 68.8 → 61.1 s; **−11.1%**, short clips | **Select within tested scope.** Visually identical; audio exact. HIP full-size quality passed; repeated full-size timing is missing. |
| Focused SwiGLU/QKV graph / **H3 graph** | P | −2.1% after FA | −2.7% after FA | — | Output changed | — | — | **Select for RTX only.** Exact incremental output there; keep the original graph elsewhere. |
| Older isolated H3 operations / **Older H3 graph** | V | −8.1% | — | −12.2% | −12.0% | −6.0%, one pair | −11.6% | Do not deploy broadly: Metal/HIP audio or video changed. Different engine base; not results for the focused patch. |
| Full upstream H3 patch / **Engine upgrade** | V | −11.8% | — | −15.2% | — | — | — | Reject: visible motion, geometry and audio changes. |
| Shared-runtime changes alone / **Shared runtime** | V | −0.2% | — | −0.7% | — | — | — | Reject as a speed change: negligible benefit. |
| GPU parameter residency / **Placement** | V | Later request ran out of memory | — | −0.3% | −0.1% after FA, full size | −3.4%, short screen | +0.2% | Optional Mac memory profile. Exact output; capacity checks required. |
| VAE-only residency / **VAE residency** | V | +0.2% | — | — | — | — | — | No speed recommendation; lower host memory use may help separately. |
| 2D VAE GEMM / **GEMM-2D** | V | — | — | — | Negligible | −0.5% | +0.8% | Keep defaults: no useful gain; tested outputs exact. |
| EasyCache, DBCache, TaylorSeer / **Cache** | V | Up to −19.6% | — | Up to −22.1% | — | — | — | Reject: useful speed settings change motion/detail and audio. The exact-output setting saved no work. |
| Graphs, threads, queues and submit settings / **Scheduling** | V | No reliable gain | — | No reliable gain | No reliable gain | No reliable gain | — | Keep defaults. |
| Vulkan host-memory selection / **Host memory** | V | — | — | — | — | +1.5% | — | Reject for speed; output exact. |
| Memory-mapped reads / **mmap** | V | +0.2% | Negligible | — | — | — | — | No warm-speed recommendation; cold-start benefit untested. |
| Forced BLAS/MMQ paths / **Matrix backend** | P | — | — | About −2.0%; corrupt output | — | — | Not completed | Reject tested cuBLAS build; HIP remains untested. |
| BF16 DiT matrices / **BF16** | V | — | — | −2.2%, one run | — | — | — | Reject: substantial video/audio changes for a small gain. |
| rocWMMA attention / **rocWMMA** | N | — | — | — | — | — | Not built | Defer: no measured result. |
| Large-token MLP chunking / **Chunking** | N | — | Source review | — | — | Source review | — | Larger-buffer compatibility idea; tested shapes did not reach its trigger. |
| Metal vector-attention tuning / **Metal attention** | N | — | — | — | Source review | — | — | Lower priority: targets shapes outside the dominant tested workload. |
| NVFP4 text encoder / **NVFP4** | N | Source review | — | Source review | — | — | — | Needs loader/checkpoint work; conditioning is a small part of warm generation. |
| New or lower-precision decoder / **Decoder replacement** | N | — | — | — | — | — | — | Separate model/quality study. |
| SGLang / vLLM / **Runtime** | P | — | — | SGLang: 604.9 → 172.8 s; −71.4% | — | — | — | Different generated content; not a parity-preserving replacement. No matched vLLM result. |

### Optimal suggested implementation and fallback

Use **FA** on the tested model/API combinations; keep diffusion attention enabled. Outputs were visually identical, with exact audio. On Mac, faster VAE attention explains **97.9%** of the saved time: VAE decode fell from **468.4 to 169.2 s**. This uses an existing parameter, not a new kernel.

Add the **H3 graph** patch only for validated RTX CUDA/Vulkan execution. It uses an existing fused SwiGLU operator and Q/K/V tensor views to reduce intermediate work. The one-header experimental patch is in the branch but is not active in the packaged engine. Metal keeps the original graph; Spark and Strix need this exact patch tested.

**Measured combinations:** FA + focused graph reduced research-CLI latency from **119.8 to 110.7 s (−7.6%)** on RTX CUDA and **103.2 to 91.5 s (−11.4%)** on RTX Vulkan. These use separate paired controls from the native-addon timings. On Mac, FA + residency reached **1236.7 s (−19.9%)** overall; residency added only **0.1%** speed but reduced process RSS from **67.5 to 44.0 GB (−34.8%)**. RSS does not establish total unified-memory fit.

## 2. FLUX.2 Klein 4B Q8

**17 approach groups: 13 tested, including partial checks; 4 untested; 2 selected for speed, with platform and memory limits.**

Generates images from text. Paired tests kept the same checkpoint, prompt, seed and ten sampling steps.

### Approach × platform/API results

| Approach / tag | Checked | RTX CUDA | RTX Vulkan | Spark CUDA | Mac Metal | Strix Vulkan | Strix HIP | Decision and quality |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GEMM VAE / **GEMM-2D** | V | 8.8 → 2.9 s; **−67.5%** | 2.6 → 2.8 s; +6.4% | 41.0 → 15.4 s; **−62.3%** | 27.9 → 30.8 s; +10.4% | 29.6 → 47.2 s; +59.6% | 67.8 → 33.6 s; **−50.5%** | **Select for CUDA and tested HIP only.** Visually identical; more memory. Keep direct VAE on Metal/Vulkan. |
| F16 DiT matrices / **F16** | V | +0.4% after GEMM; visible changes | −2.9%; exact | — | 27.9 → 26.9 s; **−3.6%**; exact | +77.2%; exact | +0.6% after GEMM; visible changes | **Optional Mac/RTX Vulkan profile.** Modest warm gain, more memory; reject on CUDA/HIP and Strix Vulkan. |
| CPU/GPU parameter placement / **Placement** | V | GEMM + CPU: 3.4 s | — | Already resident | CPU: +1.7% | CPU: +4.5% | No clear gain in screen | Capacity choice, not an extra speed gain over GPU residency. Exact in paired placement checks. |
| Forced BLAS/MMQ paths / **Matrix backend** | P | Build tried; no accepted gain | — | — | — | — | BLAS +4.1%; MMQ −0.6% | Reject tested HIP settings: changed images and no useful gain. Keep automatic selection. |
| Flash-attention settings / **FA** | V | No useful tuning gain | — | No useful tuning gain | Disabling diffusion FA: +340.3% | — | — | Keep diffusion FA enabled; no new global-FA recommendation. |
| Graphs, threads, queues and submit settings / **Scheduling** | V | No reliable gain | — | No reliable gain | No reliable gain | Sync submits: +4.8% | — | Keep defaults. |
| Vulkan host-memory selection / **Host memory** | V | — | — | — | — | +1.1% | — | Optional memory tradeoff only: exact output, device memory −13.6%. |
| Memory-mapped reads / **mmap** | V | −0.7% | −0.1% | — | — | — | — | Too small for a speed recommendation; cold-cache testing missing. |
| Small FLUX decoder / **Decoder replacement** | V | Additional −2.4% to −2.9% after GEMM | — | Additional −2.3% to −2.7% | — | — | — | Optional memory/quality tradeoff; tone and texture differ. Do not replace automatically. |
| EasyCache, DBCache, TaylorSeer / **Cache** | V | Up to −33.0% after GEMM | — | Up to −34.7% after GEMM | — | — | — | Reject: useful settings change images. EasyCache saved no useful work. |
| Four-step distilled preset / **Fewer steps** | V | — | — | −51.7% | — | — | — | Separate sampling choice; not an equal-quality speed claim. |
| VAE tiles with GEMM / **Spatial tiles** | V | — | — | −59.5% versus direct VAE | — | — | — | Reject: visible contrast/tone changes; slower than untiled GEMM. |
| SGLang / vLLM-Omni / **Runtime** | V | — | — | SGLang: 15.4 → 6.0 s, −61.2%; vLLM: 15.3 → 6.5 s, −57.5% | — | — | — | Different images and much slower first requests; separate runtime evaluation. |
| rocWMMA attention / **rocWMMA** | N | — | — | — | — | — | Not built | Defer until measured. |
| FLUX 3 Image Klein / **New model** | N | Source review | — | — | — | — | — | Different architecture; compatibility work, not a validated FLUX.2 optimization. |
| Automatic convolution selection / **Auto convolution** | N | Source review | Source review | — | Source review | Source review | Source review | Promising selection mechanism; no end-to-end validation. |
| Krea-oriented Vulkan fork / **Alternative fork** | N | — | — | — | — | Source review | — | Different model/fork; no matched-checkpoint evidence. |

### Optimal suggested implementation and fallback

Use **`vae_conv_direct:false`** for tested CUDA/HIP configurations when memory permits. It sends VAE convolutions through tensor packing and matrix-multiplication kernels on the same GPU/API. Speedups were **3.1× RTX CUDA**, **2.7× Spark CUDA** and **2.0× Strix HIP**. This is an existing parameter; no new kernel is needed.

The [existing upstream CUDA example](https://github.com/tetherto/qvac/blob/e437d29c68dad37034adbf1667497e8dc48963b0/packages/diffusion-cpp/examples/generate-image-flux2-cuda.js) already sets this flag. **These gains compare direct VAE with GEMM; they are not additional gains for users already following that example.** Its four-step preset is separate from this ten-step comparison.

Images were visually identical in reviewed samples. CUDA PSNR was about **59.0 dB**: roughly **0.3 intensity levels** of RMS difference on a 0–255 channel scale, not a percentage of quality retained. HIP measured **54.0–55.7 dB**, also visually identical in reviewed images. RTX device use rose from **11356.0 to 15636.0 MiB (+37.7%)**; Strix HIP rose from **11.7 to 16.6 GB (+42.2%)**.

Keep direct VAE on Metal/Vulkan. Optional **F16** expansion gives Mac **3.6%** at 1024-square and **3.2%** at 1280-square, with exact pixels in tested cases. At 1024-square, RSS rises from **11.8 to 17.5 GB (+47.9%)**. RTX Vulkan gains **2.9%**, but device memory rises **29.8%** and load-plus-first-request latency rises **6.0%**. These are explicit warm-speed profiles, not universal defaults.

**Measured combinations:** RTX GEMM + CPU parameters retains **61.7%** lower latency versus direct VAE (**8.8 → 3.4 s**) and uses **7926.0 MiB**, versus **15636.0 MiB** for GPU-resident GEMM. It is slower than GEMM alone. Adding F16 to GEMM gives no further speed on CUDA/HIP and changes images, so reject that combination. On Strix, measured Vulkan direct VAE was already faster than HIP GEMM; do not switch APIs automatically.

## 3. LTX-2.3 22B distilled Q5

**20 approach groups: 17 tested, including partial checks; 3 untested; 3 selected candidates, with memory or quality tradeoffs.**

Generates video and audio. Tests covered 97-frame clips, with selected 193-frame checks.

### Approach × platform/API results

| Approach / tag | Checked | RTX CUDA | RTX Vulkan | Spark CUDA | Mac Metal | Strix Vulkan | Strix HIP | Decision and quality |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| VAE-only residency / **VAE residency** | V | −1.6%, older screen | 15.2 → 14.2 s, **−6.8%**; 24.4 → 22.2 s, **−9.3%** at 193 frames | Already resident | Already resident | — | — | **Select for RTX Vulkan when memory fits.** Video/audio exact. |
| Full-temporal decode / **Temporal decode** | P | 22.7 → 21.1 s; **−7.2%**, 193 frames | Redundant with existing decoder path | 74.1 → 70.8 s; −4.5%, 193 frames | 93.2 → 92.0 s; −1.4% | Repeated output unstable | 164.0 → 157.3 s; −4.1%, limited | **Optional CUDA quality tradeoff.** Small visible changes; audio exact. Reject Strix Vulkan; defer HIP. |
| F16 DiT matrices / **F16** | P | — | — | — | 93.2 → 88.2 s; **−5.4%** | Not completed | Not completed | **Optional Mac profile.** Video/audio exact; large memory increase. |
| Full-model parameter placement / **Placement** | P | GPU-resident DiT allocation failed | — | Already resident | CPU: +2.9% | Not completed | Not completed | Keep fitting baseline; VAE-only residency is separate. |
| Metal dispatch grouping / **Metal dispatch** | V | — | — | — | No repeatable gain | — | — | Do not implement: 193-frame result neutral; output exact. |
| Metal per-value packing / **Metal packing** | V | — | — | — | Decoder stage +40.4% | — | — | Reject: apparent whole-request gain came from unequal I/O. |
| SGLang / vLLM-Omni / **Runtime** | P | — | — | SGLang: 37.8 → 12.6 s; −66.7% | — | — | — | Different scene/audio; first request +640.5%, large memory need. No matched vLLM result. |
| LTX-2.5 compatibility / **New model** | N | Source review | — | — | — | — | — | New text encoder/decoder; separate integration required. |
| 2D VAE GEMM / **GEMM-2D** | P | — | — | Neutral | Neutral | Not completed | Not completed | No useful decoder speed gain. |
| Graphs, threads, queues and submit settings / **Scheduling** | V | No reliable gain | — | No reliable gain | +0.4% in screen | — | — | Keep defaults. |
| rocWMMA attention / **rocWMMA** | N | — | — | — | — | — | Not built | Defer until measured. |
| Forced BLAS/MMQ paths / **Matrix backend** | P | — | — | +8.0%; output changed | — | — | Not completed | Reject tested cuBLAS build; HIP remains untested. |
| Memory-mapped reads / **mmap** | V | +1.5% | +0.7% | — | — | — | — | No warm-speed recommendation. |
| Official distilled sigma schedule / **Sigma schedule** | V | +2.3% | — | −0.2% | — | — | — | No reliable speed gain; different sampling/output. |
| 3D VAE GEMM / **GEMM-3D** | V | +3.5% | — | +17.5% | — | — | — | Reject: slower on both tested GPUs. |
| Broad upstream engine upgrade / **Engine upgrade** | V | Invalid output | — | Invalid output | — | — | — | Reject: white video or clipped audio. |
| Global flash attention / **FA** | V | Negligible | — | +1.9% | — | — | — | No new speed default; keep existing attention settings. |
| EasyCache, DBCache, TaylorSeer / **Cache** | V | Neutral or slower | — | No reliable gain | — | — | — | Reject: no denoising work saved. |
| Additional DiT/3D VAE kernels / **New kernels** | N | — | — | — | Not tested beyond rows above | Not tested | Not tested | Future kernel study; no additional measured gain. |
| Stateful CUDA decoder / **Stateful decode** | V | +11.4% | Existing separate path | +10.9% | — | — | — | Reject for CUDA speed; leave Vulkan policy unchanged. |

### Optimal suggested implementation and fallback

Use **VAE residency** on RTX Vulkan with a capacity check. Avoiding repeated decoder-weight transfers explains most of the gain. The 193-frame case saves **2.3 s (9.3%)**, with exact video/audio and **1448.0 MiB** extra device memory. This does not establish full-model GPU residency.

On the tested Mac, optional **F16** expansion saves **5.0 s (5.4%)** with exact output across three prompts. Faster denoising explains most of the gain. RSS increases from **44.0 to 68.5 GB (+56.0%)**; retain Q5 placement without proven capacity.

Offer **full-temporal decode** on CUDA as an explicit small-output-change profile. It decodes the whole latent sequence instead of temporal tiles, reducing repeated work but changing boundary context. RTX saves **1.6 s (7.2%)** at 193 frames; subtle texture/contrast differences remain. Spark's warm gain is **4.5%**, but its first request regressed **4.4%**. Do not make this a universal default. Keep the Strix baseline until stability and repeatability checks pass.

**Measured combinations:** RTX Vulkan residency + full-temporal decode added only **0.2%** beyond residency. Mac F16 + full-temporal decode reached **93.0 → 86.8 s (−6.7%)** on one prompt, with small visible changes; prefer F16 alone for exact output. Spark's older offloaded-control combination reached **39.8 → 36.7 s (−7.8%)**, but residency was already enabled in its main baseline.

## Method tags and implementation effort

Effort estimates include selection/fallback handling. Existing parameters still need release tests. [Experimental patches](experiments/) are not enabled production code.

| Tag | Type; what it does | Change scope / effort |
| --- | --- | --- |
| **FA** | Parameter tuning: `flash_attn:true` selects existing fused attention; retain model-specific diffusion attention settings. | Addon profile; low. H3 benefit is mainly VAE decode. |
| **GEMM-2D** | Parameter tuning: `vae_conv_direct:false` selects packing + matrix multiplication on the same API. | Addon profile/capacity gate; low. Already in CUDA FLUX example. |
| **H3 graph** | Graph optimization: existing fused SwiGLU and Q/K/V views reduce intermediate operations. | One-header experimental engine patch in branch; medium. Needs API gating and addon validation. |
| **Older H3 graph** | Broader graph/kernel changes, including different RoPE operations. | Separate older experiment; medium/high. |
| **Shared runtime** | Engine support changes isolated from H3 model operations. | Engine; medium. No useful independent gain. |
| **Placement** | Memory placement: `params_backend` chooses CPU or GPU weight storage. | Parameter/profile; low, with capacity checks. |
| **VAE residency** | Memory placement: keep decoder weights on GPU to avoid transfers. | Module placement/profile; low, with capacity checks. |
| **F16 / BF16** | Precision/storage tuning: `tensor_type_rules` expands selected quantized DiT matrices for different existing kernels. | Load-time parameter; low. More memory; does not restore pre-quantization quality. |
| **Temporal decode** | Parameter tuning: `temporal_tiling:false` decodes the whole sequence. | Profile; low. May change visual details. |
| **Cache** | Approximate algorithm: EasyCache, DBCache or TaylorSeer reuse denoising work. | Existing settings; low to expose, substantial quality checks. |
| **Scheduling** | Runtime/build tuning: CUDA graphs/queues, CPU threads, Metal batching/serial encoding, Vulkan synchronized submits. | Existing options; low/medium. No system changes needed. |
| **Host memory** | Memory placement: select the Vulkan host-memory path. | Backend setting; low. |
| **mmap** | Model I/O: memory-map checkpoint reads. | Existing option; low. Cold-start gain unproven. |
| **Matrix backend** | Kernel selection: force cuBLAS, HIP BLAS or quantized MMQ kernels. | Build/runtime setting; medium. |
| **rocWMMA** | Kernel optimization: AMD wave-matrix attention kernels. | Engine build/integration; medium. Unmeasured. |
| **Chunking** | Memory algorithm: split large MLP token buffers to respect backend limits. | Engine; medium. Larger shapes need checks. |
| **Metal attention** | Kernel tuning: change vector-attention tuning tables. | Engine; medium. Relevant shape coverage missing. |
| **NVFP4** | Model precision: lower-precision text encoder. | Loader plus checkpoint; high. |
| **Decoder replacement** | Model change: smaller/new/lower-precision decoder. | Checkpoint/profile, sometimes loader; medium/high. |
| **Runtime** | Runtime replacement: SGLang or vLLM-Omni. | Separate integration; high. Outputs/startup/memory differ. |
| **Fewer steps** | Sampling parameters: four-step distilled preset. | Parameter; low. Different output/quality choice. |
| **Spatial tiles** | Memory algorithm: decode the VAE image in tiles. | Existing option; low. Tested tone/contrast changes. |
| **New model** | Model compatibility: FLUX 3 or LTX-2.5 architectures. | Engine/model integration; high. |
| **Auto convolution** | Selection algorithm: probe/select convolution paths automatically. | Engine/profile; medium. Unvalidated. |
| **Alternative fork** | Engine/runtime replacement: Krea-oriented Vulkan fork. | Separate integration; high. Matched-model evidence missing. |
| **Metal dispatch** | Kernel scheduling: group existing 3D-packing threads. | One-file experimental patch in branch; medium. No accepted gain. |
| **Metal packing** | Kernel optimization: parallelize packed values before 3D convolution. | Four-file experimental patch in branch; medium. Rejected regression. |
| **Sigma schedule** | Sampling algorithm: official distilled noise schedule. | Model/sampler integration; medium. Different output. |
| **GEMM-3D** | Kernel selection: video decoder 3D convolutions through GEMM. | Engine option; medium. Tested CUDA path slower. |
| **Engine upgrade** | Broad engine/algorithm update. | Engine plus registry/addon; high. Tested variants failed quality. |
| **New kernels** | Kernel optimization: further DiT or 3D VAE fast paths. | Engine; high. No additional kernel or measured gain yet. |
| **Stateful decode** | Decoder algorithm: process temporal state incrementally. | Engine path; medium. Existing Vulkan path; CUDA experiment slower. |

## Research limits and release checks

- **Limited inputs:** selected checkpoints, a few prompts/seeds and fixed sizes. Test other FLUX/H3/LTX family members, more images/videos, longer clips and difficult prompts before wider defaults. FLUX 3 and LTX-2.5 are not validated.
- **Quality:** exactness applies only to checked outputs. Visual review sampled frames; PSNR measures difference, not semantic quality. Add broader image, motion and audio regression checks. Small numerical differences do not mean exact output.
- **Hardware:** one accelerator per platform; Mac results cover M3 Ultra with 96 GiB, not M3 Pro or smaller machines. HIP used a custom module, not a shipped prebuild. H3 full-size HIP timing, Strix LTX stability/F16 and rocWMMA remain open. Spark has dated CUDA results only, no Vulkan performance result.
- **Timing and memory:** warm single-request latency, not concurrent throughput or controlled cold start. Some screens have few repetitions. Test startup, peak total memory, repeated requests and allocation failures. Only the combinations above were measured together.
- **Safe selection:** gate by model, actual module API, tested hardware, request size and proven capacity. Preserve explicit user settings and current behavior elsewhere. Unknown fit must not enable a higher-memory profile. API switching can change generated content.
- **Release path:** implement scoped profiles/engine changes, test the addon end to end, then run the affected desktop matrix and relevant mobile checks. Recheck the latest package: November measurements used addon `0.33.0`, Spark used `0.31.0`; upstream is now `0.34.0`. Exact revisions are preserved in the evidence.

## Branch status

[codex/diffusion-performance](https://github.com/tetherto/qvac/tree/codex/diffusion-performance) contains research, reproducible measurements and experimental patches. **No PR is open; no research optimization is enabled as a production default.** The evidence supports scoped implementation, not release approval. Recorded operator/addon checks passed; the final implementation needs its own integration and full-platform validation. Engine changes follow engine → temporary addon overlay → separate registry update → addon repin. Version/changelog work stays in a later separate PR.

All booked hosts were released; this campaign's remote test directories were removed after evidence preservation. Raw outputs remain in verified local storage. No model files or private host details are committed.
