# Diffusion performance profiles: implementation validation

Selected performance profiles for FLUX.2 Klein, MiniMax-H3 and LTX are implemented with device/API selection, explicit overrides and conservative fallbacks.

This report covers the implementation pass on 4 November 2026. Radeon 8060S HIP/Vulkan results are retained from 3 November; Strix was not booked for this pass. Paired speed comparisons keep the checkpoint, prompt, seed, dimensions, sampler and steps fixed. Generation latency excludes model loading and warmup. Small timing differences on unchanged paths are measurement variation, not claimed improvements.

The 5 November Strix follow-up found an inconsistent repeated FLUX HIP GEMM output. Automatic HIP GEMM has therefore been removed from the allowlist: direct convolution remains the default. The measured 68.8 → 34.0 s candidate (−50.6%, 2.0×) is not an accepted production improvement. Two comparisons measured 54.6 dB PSNR; the other measured 32.8 dB with a maximum channel difference of 212/255. Fresh repeated and explicit-GEMM controls are in progress. This check uses ROCm 7.2.2; the earlier research used 7.2.4.

| Platform | Accelerator / API checked | Evidence |
| --- | --- | --- |
| Linux x64 | NVIDIA GeForce RTX 5090 / CUDA and Vulkan | Fresh implementation checks |
| Linux arm64 | NVIDIA GB10 / CUDA | Fresh implementation checks on DGX Spark; Vulkan not checked |
| macOS arm64 | Apple M3 Ultra, 60 GPU cores, 96 GiB / Metal | Fresh implementation checks; M3 Pro not checked |
| Linux x64 | Ryzen AI MAX+ 395, Radeon 8060S / HIP and Vulkan | Dated research plus selection tests; no fresh HIP binary check |

## Implemented selection

| Model | Automatic profile | Where it applies | Baseline elsewhere |
| --- | --- | --- | --- |
| FLUX.2 Klein 4B Q8_0, image generation | GEMM VAE convolution | RTX 5090/GB10 CUDA: single 512² or 1024² text-to-image request. At least 16 GiB free after load | Direct convolution on HIP/Metal/Vulkan; reference images, LoRA, tiling, batches and unvalidated sizes retain baseline |
| MiniMax-H3 FL2VA Q4_K, video with audio | Global flash attention | RTX 5090 CUDA/Vulkan, GB10 CUDA, M3 Ultra Metal, Radeon 8060S HIP | Existing flash-attention setting |
| MiniMax-H3 FL2VA Q4_K | Fused SwiGLU and QKV views, combined with automatic flash attention | RTX 5090 CUDA/Vulkan only, at least 28 GiB free at load, and a 960×544×124 text-to-video request | Flash attention alone below that memory threshold or outside that shape; original graph on other GPUs |
| LTX-2.3 22B distilled Q5_K, video with audio | F16 transformer matrices | M3 Ultra Metal, declared bounds up to 512×320×97, GPU-resident parameters and sufficient memory | Original quantized matrices |

`performance_profile: 'off'` opts out. Explicit convolution, flash-attention and precision settings take precedence. Profiles are restricted to researched checkpoint layouts and component sizes; recognition is not a cryptographic weight identity check. Unknown GPUs/APIs/models and explicit streaming or memory-budget policies keep existing settings. Hardware and policy selection live in one addon file, `PerformanceProfiles.cpp`.

The LTX load guard requires at least 96 GiB physical memory, 76 GiB available host memory and 64 GiB available Metal budget. All three output limits must be declared together. Requests above them fail before inference. Memory checks do not reserve memory against concurrent processes.

## MiniMax-H3 FL2VA Q4_K

Generates video with synchronized audio. Two selected methods are implemented: global flash attention and the focused H3 graph. Tests use 960×544×124 frames and eight steps unless stated otherwise.

| Platform / API | Applied method | Baseline → profile | Latency change | Decision / quality |
| --- | --- | --- | --- | --- |
| RTX 5090 / CUDA | Attention + H3 graph | 120.9 → 112.1 s | **−7.3%**, 1.1× | Enable with graph memory guard; visually identical, exact audio |
| RTX 5090 / Vulkan | Attention + H3 graph | 103.6 → 92.1 s | **−11.1%**, 1.1× | Enable with graph memory guard; visually identical, exact audio |
| GB10 / CUDA | Attention | 657.5 → 596.9 s | **−9.2%**, 1.1× | Enable; visually identical, exact audio; original graph retained |
| M3 Ultra / Metal | Attention | 1531.2 → 1238.1 s | **−19.1%**, 1.2× | Enable; visually identical, exact audio |
| Radeon 8060S / HIP | Attention | 68.8 → 61.1 s | **−11.1%**, short clips | Dated research; full-size quality passed, repeated full-size timing remains open |
| Radeon 8060S / Vulkan | None | Research attention gain 3.2% | Below threshold | Keep baseline; no automatic graph change |

RTX CUDA numbers use the final CI binary; the earlier source build measured 122.4 → 111.7 s (−8.8%) with identical outputs. RTX medians use two measured requests after one warmup; Mac uses one measured request after one warmup. Spark's first exploratory baseline had an unusually slow first denoising step and is not used as the final speed estimate. The new repeat excludes two warmups before two measured requests per mode.

**Recommendation:** enable global flash attention only for the listed GPU/API pairs; add the graph changes on RTX when the memory and request guards pass. CUDA and Vulkan combined profiles save 8.8 s (7.3%) and 11.5 s (11.1%) respectively. Spark saves 60.6 s (9.2%); Mac saves 293.2 s (19.1%). Keep the original graph elsewhere. Explicit attention settings take precedence. A later request with different dimensions/frame count restores the original graph in the same context.

RTX CUDA quality measured 53.6 dB PSNR, Vulkan 52.5 dB, Spark CUDA 53.5 dB, and Mac Metal 59.1 dB; reviewed frames are visually identical and audio is exact. CUDA sampled GPU memory increases from 21.9 to 23.2 GiB (+1.2 GiB, +5.7%). Mac process RSS rises from 55.5 to 56.1 GiB (+0.6 GiB, +1.2%). The global-attention improvement is mainly faster VAE decoding. The graph changes add only a few percent by themselves, so they are enabled as part of the validated combined profile, not independently when attention is explicitly configured.

## FLUX.2 Klein 4B Q8_0

Generates images from text. One selected method is implemented: GEMM VAE convolution. Tests use 1024×1024 and ten steps unless stated otherwise.

| Platform / API | Applied method | Baseline → profile | Latency change | Decision / quality |
| --- | --- | --- | --- | --- |
| RTX 5090 / CUDA | VAE GEMM | 8.7 → 2.8 s | **−67.6%**, 3.1× | Enable within request/memory limits; visually identical |
| GB10 / CUDA | VAE GEMM | 40.8 → 15.4 s | **−62.3%**, 2.7× | Enable within request/memory limits; visually identical |
| RTX 5090 / Vulkan | None | 2.6 → 2.6 s | −0.2%, timing variation | Keep direct convolution; byte-identical fallback |
| M3 Ultra / Metal | None | 27.9 → 27.9 s | +0.1%, timing variation | Keep direct convolution; byte-identical fallback |
| Radeon 8060S / HIP | Experimental VAE GEMM | 68.8 → 34.0 s | **−50.6%**, 2.0× | Keep baseline: one repeated output failed quality agreement; not accepted for automatic selection |
| Radeon 8060S / Vulkan | None | Research GEMM was 59.6% slower | Regression rejected | Keep direct convolution |

RTX CUDA numbers use the final CI binary; its outputs exactly match the source build. CUDA and Metal values use three measured requests after one warmup; Vulkan uses two. Direct/GEMM research regressions were also measured on RTX Vulkan (+6.4%) and Mac Metal (+10.4%), so neither receives the GEMM profile.

**Recommendation:** select GEMM on the validated CUDA requests and retain direct convolution on HIP/Metal/Vulkan. RTX saves 5.9 s (67.6%), Spark 25.4 s (62.3%). The existing CUDA example already supplies `vae_conv_direct:false`; these are not additional gains for callers already using it.

Across three CUDA prompts, PSNR is 58.2–60.5 dB and maximum channel difference is 4/255. Reviewed images are visually identical. Around 59.0 dB means about 0.3 intensity levels of RMS difference on a 0–255 scale, not a percentage of quality retained. Sampled RTX memory rises from 11.1 to 15.3 GiB (+4.2 GiB, +37.7%). Dated Strix HIP results use 11.7→16.6 GB (+42.2%).

Mixed-size requests, explicit direct/GEMM overrides and tiled requests test that the context returns to its baseline path when needed. No API is switched automatically: Strix Vulkan direct convolution was already faster than HIP GEMM in research.

## LTX-2.3 22B distilled Q5_K

Generates video with audio. One selected method is implemented: bounded F16 transformer matrices on M3 Ultra Metal. Two other research candidates already match addon defaults or require explicit placement and therefore add no automatic production behavior.

| Platform / API | Applied method | Baseline → profile | Latency change | Decision / quality |
| --- | --- | --- | --- | --- |
| M3 Ultra / Metal, default decoding | Bounded F16 matrices | 91.8 → 86.8 s | **−5.4%**, 1.1× | Enable within declared limits; exact video/audio |
| M3 Ultra / Metal, explicit temporal tiling | Bounded F16 matrices | 92.8 → 88.0 s | **−5.2%**, 1.1× | Exact video/audio, substantial memory increase |
| RTX 5090 / CUDA, 193 frames | None | 20.8 → 20.9 s | +0.2%, timing variation | Existing settings preserved; byte-identical output |
| GB10 / CUDA, 193 frames | None | 72.9 → 73.0 s | +0.2%, timing variation | Existing settings preserved; byte-identical output |
| RTX 5090 / Vulkan | None | Research VAE residency saved 6.8–9.3% against CPU-resident controls | No new default gain | GPU VAE residency already defaults on; explicit CPU choices remain untouched |
| Radeon 8060S / HIP and Vulkan | None | No accepted automatic profile | Not freshly measured | Keep baseline; research stability/precision checks remain incomplete |

Mac uses 512×320×97 frames and three measured requests after one warmup. RTX uses three measured requests; Spark uses one, both after one warmup. Temporal tiling is identical within each pair.

**Recommendation:** enable F16 only for the bounded M3 Ultra Metal profile. With default decoding it saves 4.9 s (5.4%); explicit temporal tiling saves 4.9 s (5.2%). Keep original precision on other GPUs and unbounded contexts. This is a memory-for-speed tradeoff with no pixel or audio difference in the tested outputs.

Default decoding produces byte-identical video/audio across the warmup and three measured requests. Explicit-temporal-tiling checks also produce byte-identical video/audio across three prompts. Default-decoding sampled process RSS rises from 36.7 to 62.3 GiB (+25.7 GiB, +70.0%). The explicit-tiling pair measured 36.6 to 58.5 GiB (+21.9 GiB, +59.8%); these are process measurements, not total unified-memory high-water marks. Loading in the final default-decoding pair takes 8.7 → 15.8 s (+7.1 s, +82.1%). Load plus the first clip takes 100.7 → 103.2 s (+2.4%); all four clips including warmup and loading take 376.1 → 363.7 s (−3.3%). These are observed context-lifetime totals, with filesystem cache state uncontrolled. The 5.4% claim applies to warm generation, not startup or every context lifetime. Validate cold starts and expected context reuse before release; a one-clip service should retain baseline settings until that check passes. Unbounded contexts and explicit precision rules retain the original quantized matrices.

## Approaches retained, rejected or still open

| Model | Approach / type | Decision and reason |
| --- | --- | --- |
| H3 | Global attention / parameter tuning | Implement on measured pairs with ≥5% gain; keep Strix Vulkan unchanged (3.2%) |
| H3 | Focused SwiGLU/QKV / graph optimization | Implement with automatic attention on RTX CUDA/Vulkan; other GPUs not validated for this exact graph |
| FLUX | VAE GEMM / parameter tuning | Implement for CUDA; reject automatic HIP use pending output repeatability, and Metal/Vulkan because it is slower |
| FLUX | F16 matrices / precision selection | Exclude: only 3.2–3.6% on Mac and 2.9% on RTX Vulkan, with more memory |
| LTX | F16 matrices / precision selection | Implement only the bounded Mac profile: 5.4% with default decoding, exact output, more memory |
| LTX | Full-temporal decode / parameter tuning | Already the addon default; no extra speed claim or new mode |
| LTX | GPU VAE residency / placement | Already default unless overridden; preserve explicit CPU placement |
| All | Cache reuse, lower-quality decoders, broad engine upgrades / algorithm or model changes | Exclude: visible output changes, unreliable gains or failed quality checks |
| All | rocWMMA, other family checkpoints, further decoder/attention kernels | Not implemented; missing matched performance/quality evidence |

The complete earlier matrix, including partial and untested ideas and SGLang/vLLM comparisons, remains in the [research report](https://github.com/tetherto/qvac/blob/codex/diffusion-performance/packages/diffusion-cpp/benchmarks/research/evaluation-2026-11-03/REPORT.md). Those alternative runtimes did not establish output parity and are outside this implementation.

## Approach details

- **VAE GEMM — parameter selection plus runtime control.** `vae_conv_direct:false` selects the existing matrix convolution implementation. It changes no sampling steps or model weights. The addon chooses it per request and can restore direct convolution before an unsupported request. The existing CUDA FLUX example already specifies this option; these profiles extend selection to eligible callers that leave the option unset.
- **Global flash attention — parameter tuning.** H3 enables existing flash-attention kernels. Reviewed frames remain visually identical, with small numerical differences and exact audio.
- **Fused SwiGLU/QKV views — graph optimization.** H3 reuses existing ggml operations and avoids materializing QKV slices. This needs an engine control, but no new kernel or ggml dependency. It is combined with flash attention on RTX; its isolated gain is below the 5% threshold, so explicit flash-attention configurations do not gain a separate automatic graph change.
- **F16 transformer matrices — precision/layout selection.** LTX converts selected transformer weights at load, using the existing tensor-type rules. It preserves exact tested pixels/audio but increases memory and load time. Encoder/VAE precision is unchanged.

## Corrections to the research interpretation

The addon already defaults to `temporal_tiling:false`. Research's LTX CUDA full-temporal gain was against explicitly tiled decoding, not the existing addon default. There is no new temporal-decoding profile or new quality-tradeoff enum. Existing explicit tiling controls remain available. Likewise, VAE GPU residency is already the default unless overridden; these profiles do not rewrite a caller's CPU-residency choice.

## Validation evidence

Measured native implementation revision: `4e027082eadc94819adfdcde8187d946e875cc56`; engine revision: `bc3890d`. The 5 November follow-up removes automatic FLUX HIP GEMM after its repeatability failure; other device/API selections are unchanged. Earlier measurements used the same selected computations before the final request and memory guards. Final source hashes and policy checks establish which revision each host tested.

- Windows: TypeScript/lint, 137 Bare unit tests and 91 Node unit tests passed. The two new inference schema tests passed all 17 assertions; its broader Windows suite has unrelated failures described below.
- RTX: all 331 native tests passed with every model fixture and no skips. Twelve profile tests passed. The final GitHub Actions prebuild was downloaded and its archive SHA-256 verified, then used for FLUX/H3 measurements. CI/source outputs are byte-identical. Actual tiled FLUX and unsupported-size fallbacks are byte-identical to baseline; a full → small → full H3 sequence verifies graph disable/re-enable with exact output.
- Mac and Spark: all 331 native tests passed on each host, with all fixtures and no skips. Twelve profile tests passed on both. Mac uses Metal for native generation; Spark uses the native suite's CPU device, with CUDA separately covered by paired model runs. All three hosts match the final profile, model-interface and policy-test source hashes.
- Engine: all 17 CTest tests and the new GPU operation-equivalence test passed on RTX, Spark and Mac. The [engine CI matrix](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/actions/runs/41886687513) passed all nine native build targets, including CUDA, Vulkan, ROCm, macOS and CPU.
- [Addon CI at the native revision](https://github.com/tetherto/qvac/actions/runs/41907990288): all nine prebuild targets, all three C++ targets, all seven desktop integration lanes, linking, lint, TypeScript and sanity checks passed. Windows integration initially failed before checkout because of a locked runner workspace; the unchanged retry passed. No tests, labels or workflows were disabled or weakened.
- The later documentation run failed in the existing Linux ABot integration test with a GPU allocation failure. An unchanged retry is in progress; this is separate from the Strix quality finding. The HIP fallback correction receives the full existing CI matrix.

Full-precision timings, workload configuration, quality metrics and output hashes are in [the measurement data](performance-profiles-metrics.json). Reported percentages use unrounded medians. CUDA device indices in that data are process-local; the RTX run was restricted to the booked physical GPU.

All three booked test directories were removed after preserving results. The final cleanup freed 220.1 GiB; no files outside those directories were removed.

## Validation and remaining limits

- Native policy tests cover the GPU/API matrix, memory and output boundaries, explicit overrides and fallbacks. Metadata-only registry descriptions cannot produce a baseline-memory fit verdict when full downloaded weights may select a larger profile. Dynamic profiles conservatively return `unknown` from fit probes.
- Engine operation tests exercise fused SwiGLU, exact QKV views, strided normalization, changing inputs, multiple shapes and batches. Engine defaults and context-parameter ABI layout are unchanged.
- Linux native tests use their existing CPU device setting; GPU model execution is validated separately. Direct runs with GPU driver modules initialized reported process-exit driver allocations under LeakSanitizer. No new leak suppression or test exclusion was added. Preserve these diagnostics alongside the final CPU-lane result.
- The local Windows SDK/inference suite has unrelated Unix-path, permission, RPC timing and shared-state failures. New schema tests pass. Its draft PR remains low priority and is not presented as fully validated.
- This is a narrow checkpoint/workload validation, not a family-wide quality benchmark. More prompts, longer/larger outputs, adapters, concurrent contexts, other GPU variants and new checkpoint layouts need paired measurements before expanding the allowlist. GPU memory peaks are sampled, not exact allocator high-water marks. PSNR/SSIM measure numerical agreement, not human preference.
- No mobile performance profile was added. Keep the existing mobile prebuild matrix; Device Farm was not required for the desktop-only allowlist.

## Integration status

The engine PR adds two per-context setters; all automatic decisions stay in the addon. No Fabric change or SDK runtime change is needed. `@qvac/inference` has a separate schema/documentation PR for forwarding optional configuration.

Review order: [diffusion engine #61](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/61), separate vcpkg registry update after engine merge, removal of the temporary addon overlay and validation of the final pin, [addon #5578](https://github.com/tetherto/qvac/pull/5578), then the [low-priority draft inference #5577](https://github.com/tetherto/qvac/pull/5577). Version and changelog changes belong to separate release PRs. The temporary overlay is for end-to-end review and must not ship.
