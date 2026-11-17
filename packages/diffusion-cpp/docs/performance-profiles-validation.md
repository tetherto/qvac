# Diffusion performance profiles: implementation validation

FLUX.2 Klein, MiniMax-H3 and LTX profiles retain device/API selection, explicit overrides and conservative fallbacks. The addon now targets merged [engine #64](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/64), commit `bc53357484bc5d2ba08fbe5301dae192e5b9a176`, on the 2026-11-01 baseline.

H3 fused SwiGLU and QKV views are already enabled by that engine. The addon leaves them unchanged for every GPU, workload and profile mode, including `off`; only global flash attention is selected automatically. The old RTX-only graph toggle, its 28 GiB/960×544×124 guard and its fit-probe exclusion are removed. FLUX GEMM and bounded LTX precision policies are unchanged.

All timings below are historical November 4–5 results on the earlier engine. They are retained with their original raw data and do **not** establish current-engine speedups, quality parity or memory budgets. In particular, the old H3 combined attention/graph comparison is not an attention-only comparison against the new fused baseline. Paired model checks on the merged engine remain required before release.

The historical evidence combines the 4 November 2026 implementation checks with the 5 November Radeon 8060S HIP/Vulkan follow-up. Paired speed comparisons keep the checkpoint, prompt, seed, dimensions, sampler and steps fixed. Generation latency excludes model loading and warmup. Small timing differences on unchanged paths are not claimed improvements.

The Strix follow-up confirms H3's short-clip HIP gain and rejects automatic FLUX HIP GEMM because one repeated output was inconsistent. The corrected CI binary retains direct convolution and produces byte-identical outputs to baseline. LTX checks remain incomplete: competing work interrupted the 97-frame HIP attempt, and a host reboot ended the remaining queue. The reboot cause is unknown; kernel logs were inaccessible. No further inference was launched after it.

| Platform | Accelerator / API checked | Evidence |
| --- | --- | --- |
| Linux x64 | NVIDIA GeForce RTX 5090 / CUDA and Vulkan | November 4 implementation checks |
| Linux arm64 | NVIDIA GB10 / CUDA | November 4 implementation checks on DGX Spark; Vulkan not checked |
| macOS arm64 | Apple M3 Ultra, 60 GPU cores, 96 GiB / Metal | November 4 implementation checks; M3 Pro not checked |
| Linux x64 | Ryzen AI MAX+ 395, Radeon 8060S / HIP and Vulkan | November 5 FLUX/H3 checks; LTX incomplete. ROCm 7.2.2, RADV Mesa 25.2.8 / Vulkan 1.4.318 |

## November 17 merged-engine checks

The addon was ported onto QVAC main `f937f5f4` and built against engine
`bc53357484bc5d2ba08fbe5301dae192e5b9a176` with the existing ggml pin
`a4adfcb1304fb05b64473f1fe8d678bbce7a9ce0`. Validation used Linux arm64,
Clang 22/libc++, a CPU addon build and a separate leased GB10 CUDA operation
check. The engine archive checksum was verified; the addon overlay and prepared
registry port match byte for byte.

- `npm run typecheck`, `npm run build:ts` and `npm run lint` passed. The generated
  `index.d.ts` matches the checked-in declaration. Lint retains 72 warnings in
  existing JavaScript files, with no lint errors.
- The native addon module and `addon-test` target built against the merged
  engine. C++ formatting passed. All 12 `SdPerformanceProfiles` tests passed,
  including explicit attention aliases,
  opt-out, memory/request boundaries and metadata-only model recognition.
- `npm run test:cpp:run` ran 332 tests: 297 passed and 35 were skipped by existing
  SD2.1/FLUX fixture guards and the opt-in Wan smoke-test gate. This is not a
  complete model-backed native pass.
- All 17 engine CTest tests passed, including enabled H3 defaults, per-context
  VAE/H3 switching, runner rebuild persistence and rejection of busy setters.
- `test-h3-localops --gpu` passed on a leased GB10: primitive and production-block
  equivalence, attention on/off, changing inputs, batches, runner rebuilds and
  guarded context controls. The cached CUDA backend used the same ggml source
  and 160-character tensor-name ABI. Its initial load failed on an unresolved
  `std::condition_variable` destructor; explicitly preloading `libstdc++.so.6`,
  required by that cached backend, allowed the operation test to run. Both logs
  were retained. This workaround is local to validation and does not certify
  release-package loading.
- Full-model inference, timing and quality comparisons were not repeated. The
  operation checks do not validate packaged CUDA/Vulkan/Metal/HIP addons or final
  registry resolution.

## Historical warm-generation improvements

**A** = addon selection using existing engine features. **F** = diffusion engine change; here the engine is `stable-diffusion.cpp`, not Fabric. **FA** = both layers. No Fabric PR is needed. Times are seconds; factors and percentages use unrounded medians. Each cell compares the same workload on the same device, not performance across devices.

| Model | RTX 5090 CUDA | RTX 5090 Vulkan | DGX Spark GB10 CUDA | M3 Ultra Metal | Radeon 8060S HIP | Radeon 8060S Vulkan |
| --- | --- | --- | --- | --- | --- | --- |
| FLUX.2 Klein | 8.7 → 2.8 s **×3.1 FA [x1]**, −67.6% | Defaults retained | 40.8 → 15.4 s **×2.7 FA [x1]**, −62.3% | Defaults retained | Defaults retained **[x4]** | Defaults retained **[x5]** |
| MiniMax-H3 | 120.9 → 112.1 s **×1.1 FA [x2]**, −7.3% | 103.6 → 92.1 s **×1.1 FA [x2]**, −11.1% | 657.5 → 596.9 s **×1.1 A**, −9.2% | 1531.2 → 1238.1 s **×1.2 A**, −19.1% | 70.0 → 61.1 s **×1.1 A [x3]**, −12.8% | Defaults retained **[x5]** |
| LTX-2.3 | Defaults retained | Defaults retained | Defaults retained | 91.8 → 86.8 s **×1.1 A [x6]**, −5.4% | Defaults retained **[x7]** | Defaults retained **[x7]** |

- **[x1] FLUX CUDA:** automatic only for supported single 512²/1024² text-to-image requests and at least 16 GiB free after load. RTX VRAM rises 11.1 → 15.3 GiB (+37.7%). Reviewed images are visually identical, not byte-identical. Callers already setting `vae_conv_direct:false` already receive this gain.
- **[x2] H3 RTX (historical):** the measured combined attention/graph profile used at least 28 GiB free at load and 960×544×124 output. That graph selection policy is no longer applied; the new engine enables the fused graph by default. RTX CUDA VRAM rises 21.9 → 23.2 GiB (+5.7%). Reviewed video is visually identical; audio is exact.
- **[x3] H3 HIP:** fresh timing covers 512×288×39, eight steps, CPU-resident parameters, one prompt, one warmup and two measured requests per mode. Video is visually identical (48.1 dB PSNR), audio exact. Full-size repeated timing remains open. HIP is source-built; this PR adds no HIP release package.
- **[x4] FLUX HIP:** the 68.8 → 34.0 s GEMM candidate (×2.0, −50.6%) is rejected for automatic use. One of three outputs had 32.8 dB agreement versus 54.6 dB in the other two. Root cause and explicit-GEMM control remain open. The final default matches baseline pixels exactly; manually forcing GEMM remains experimental.
- **[x5] Strix Vulkan:** defaults and exact FLUX/H3 outputs are preserved. One measured request per mode gives 31.1 → 32.2 s for FLUX (+3.4%) and 101.4 → 101.1 s for H3 (−0.4%). These small-sample timings do not establish latency equivalence or an improvement. Earlier attention/GEMM research does not justify changing these defaults.
- **[x6] LTX Metal:** automatic only after the caller declares all output bounds up to 512×320×97 and memory guards pass. Exact video/audio, but process RSS rises 36.7 → 62.3 GiB (+70.0%) and loading 8.7 → 15.8 s (+82.1%). Load plus first clip is 2.4% slower. Single-clip callers should use `off` until cold-start validation; the gain applies to warm generation.
- **[x7] LTX Strix:** no accepted off/auto pair in this follow-up. HIP's 97-frame attempt was interrupted; the shorter fallback queue ended with a host reboot. Retained defaults are a policy decision, not a completed no-regression measurement. Long-repeat stability remains open.

Spark Vulkan and M3 Pro are not covered. RTX, Spark and Mac values are the dated 4 November implementation measurements; those hosts were not retested on 5 November.

## Implemented selection

| Model | Automatic profile | Where it applies | Baseline elsewhere |
| --- | --- | --- | --- |
| FLUX.2 Klein 4B Q8_0, image generation | GEMM VAE convolution | RTX 5090/GB10 CUDA: single 512² or 1024² text-to-image request. At least 16 GiB free after load | Direct convolution on HIP/Metal/Vulkan; reference images, LoRA, tiling, batches and unvalidated sizes retain baseline |
| MiniMax-H3 FL2VA Q4_K, video with audio | Global flash attention | RTX 5090 CUDA/Vulkan, GB10 CUDA, M3 Ultra Metal, Radeon 8060S HIP | Existing flash-attention setting |
| LTX-2.3 22B distilled Q5_K, video with audio | F16 transformer matrices | M3 Ultra Metal, declared bounds up to 512×320×97, GPU-resident parameters and sufficient memory | Original quantized matrices |

`performance_profile: 'off'` opts out of addon selection and preserves the current engine defaults, including the fused H3 graph. Explicit convolution, flash-attention and precision settings take precedence. Profiles are restricted to researched checkpoint layouts and component sizes; recognition is not a cryptographic weight identity check. Unknown GPUs/APIs/models and explicit streaming or memory-budget policies keep existing settings. Hardware and policy selection live in one addon file, `PerformanceProfiles.cpp`.

The LTX load guard requires at least 96 GiB physical memory, 76 GiB available host memory and 64 GiB available Metal budget. All three output limits must be declared together. Requests above them fail before inference. Memory checks do not reserve memory against concurrent processes.

## MiniMax-H3 FL2VA Q4_K

Generates video with synchronized audio. The historical experiment combined global flash attention and the focused H3 graph. The current addon selects attention only. Historical tests use 960×544×124 frames and eight steps unless stated otherwise.

| Platform / API | Applied method | Baseline → profile | Latency change | Decision / quality |
| --- | --- | --- | --- | --- |
| RTX 5090 / CUDA | Attention + H3 graph | 120.9 → 112.1 s | **−7.3%**, 1.1× | Enable with graph memory guard; visually identical, exact audio |
| RTX 5090 / Vulkan | Attention + H3 graph | 103.6 → 92.1 s | **−11.1%**, 1.1× | Enable with graph memory guard; visually identical, exact audio |
| GB10 / CUDA | Attention | 657.5 → 596.9 s | **−9.2%**, 1.1× | Enable; visually identical, exact audio; original graph retained |
| M3 Ultra / Metal | Attention | 1531.2 → 1238.1 s | **−19.1%**, 1.2× | Enable; visually identical, exact audio |
| Radeon 8060S / HIP | Attention | 70.0 → 61.1 s | **−12.8%**, 1.1× | Fresh short-clip pair; visually identical video, exact audio; full-size repeated timing remains open |
| Radeon 8060S / Vulkan | None | 101.4 → 101.1 s | −0.4%, one measured request | Keep baseline; exact video/audio; earlier 3.2% attention gain was below threshold |

RTX CUDA numbers use the final CI binary; the earlier source build measured 122.4 → 111.7 s (−8.8%) with identical outputs. RTX medians use two measured requests after one warmup; Mac uses one measured request after one warmup. Spark's first exploratory baseline had an unusually slow first denoising step and is not used as the final speed estimate. The new repeat excludes two warmups before two measured requests per mode.

Strix uses 512×288×39 frames, eight steps, CPU-resident parameters and one prompt. HIP has two measured requests after one warmup per mode; all three paired outputs agree at 48.1 dB PSNR with exact audio and repeat identically within each mode. Vulkan has one measured request after warmup per mode and exact output agreement. Interrupted or contended runs are excluded. These short-clip timings are not comparable with the full-size timings on the other GPUs.

**Current validation requirement:** repeat off/auto comparisons with the fused graph enabled in both modes. The historical CUDA/Vulkan combined profiles and the old unfused Spark/Metal/HIP baselines cannot quantify the benefit of the current attention-only selection. Explicit attention settings continue to take precedence; request dimensions no longer toggle the graph.

RTX CUDA quality measured 53.6 dB PSNR, Vulkan 52.5 dB, Spark CUDA 53.5 dB, and Mac Metal 59.1 dB; reviewed frames are visually identical and audio is exact. CUDA sampled GPU memory increases from 21.9 to 23.2 GiB (+1.2 GiB, +5.7%). Mac process RSS rises from 55.5 to 56.1 GiB (+0.6 GiB, +1.2%). The global-attention improvement is mainly faster VAE decoding. In the historical experiment, the isolated graph gain was below 5% and it was selected only as part of the combined profile. The new engine default supersedes that addon graph policy.

## FLUX.2 Klein 4B Q8_0

Generates images from text. One selected method is implemented: GEMM VAE convolution. Tests use 1024×1024 and ten steps unless stated otherwise.

| Platform / API | Applied method | Baseline → profile | Latency change | Decision / quality |
| --- | --- | --- | --- | --- |
| RTX 5090 / CUDA | VAE GEMM | 8.7 → 2.8 s | **−67.6%**, 3.1× | Enable within request/memory limits; visually identical |
| GB10 / CUDA | VAE GEMM | 40.8 → 15.4 s | **−62.3%**, 2.7× | Enable within request/memory limits; visually identical |
| RTX 5090 / Vulkan | None | 2.6 → 2.6 s | −0.2%, timing variation | Keep direct convolution; byte-identical fallback |
| M3 Ultra / Metal | None | 27.9 → 27.9 s | +0.1%, timing variation | Keep direct convolution; byte-identical fallback |
| Radeon 8060S / HIP | Experimental VAE GEMM | 68.8 → 34.0 s | **−50.6%**, 2.0× | Keep baseline: one repeated output failed quality agreement; not accepted for automatic selection |
| Radeon 8060S / Vulkan | None | 31.1 → 32.2 s | +3.4%, one measured request | Exact pixels; retain direct convolution. Research GEMM was 59.6% slower |

RTX CUDA numbers use the final CI binary; its outputs exactly match the source build. CUDA and Metal values use three measured requests after one warmup; RTX Vulkan uses two. Strix's original HIP pair uses two measured requests after warmup; its corrected HIP fallback and Vulkan pair each use one. Direct/GEMM research regressions were also measured on RTX Vulkan (+6.4%) and Mac Metal (+10.4%), so neither receives the GEMM profile.

**Recommendation:** select GEMM on the validated CUDA requests and retain direct convolution on HIP/Metal/Vulkan. RTX saves 5.9 s (67.6%), Spark 25.4 s (62.3%). The existing CUDA example already supplies `vae_conv_direct:false`; these are not additional gains for callers already using it.

Across three CUDA prompts, PSNR is 58.2–60.5 dB and maximum channel difference is 4/255. Reviewed images are visually identical. Around 59.0 dB means about 0.3 intensity levels of RMS difference on a 0–255 scale, not a percentage of quality retained. Sampled RTX memory rises from 11.1 to 15.3 GiB (+4.2 GiB, +37.7%). Dated Strix HIP results use 11.7→16.6 GB (+42.2%).

The 5 November HIP candidate used ROCm 7.2.2, versus 7.2.4 in earlier research. Its warmup and second measured output both reached 54.6 dB PSNR with a maximum difference of 6/255; the first measured output reached only 32.8 dB and 212/255. The cause is unresolved, so this is an output-repeatability failure rather than an accepted speed/quality tradeoff. After removing automatic HIP GEMM, both outputs from the corrected CI binary are byte-identical to the original baseline. The observed 68.8 → 67.4 s on the unchanged direct path is not claimed as an optimization. Explicit-GEMM diagnosis did not complete.

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
| Radeon 8060S / HIP and Vulkan | None | No accepted automatic profile or completed fresh pair | Incomplete | Keep baseline; contention and a host reboot ended checks; long-repeat stability remains open |

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
- **Fused SwiGLU/QKV views — engine default.** H3 reuses existing ggml operations and avoids materializing QKV slices. Engine #64 preserves the enabled default from the 2026-11-01 baseline. The addon does not call the H3 setter or switch graph implementations between requests.
- **F16 transformer matrices — precision/layout selection.** LTX converts selected transformer weights at load, using the existing tensor-type rules. It preserves exact tested pixels/audio but increases memory and load time. Encoder/VAE precision is unchanged.

## Corrections to the research interpretation

The addon already defaults to `temporal_tiling:false`. Research's LTX CUDA full-temporal gain was against explicitly tiled decoding, not the existing addon default. There is no new temporal-decoding profile or new quality-tradeoff enum. Existing explicit tiling controls remain available. Likewise, VAE GPU residency is already the default unless overridden; these profiles do not rewrite a caller's CPU-residency choice.

## Historical validation evidence

The 4 November native implementation revision is `4e027082eadc94819adfdcde8187d946e875cc56`; engine revision is `bc3890d`. The 5 November HIP fallback correction is `def6a7c3bd3105b7e32d288ace674a78c7ead4c3`; it removes only automatic FLUX HIP GEMM. Strix's corrected FLUX fallback and H3 HIP/Vulkan pairs use that exact CI binary. FLUX's rejected HIP candidate and Vulkan pair use the earlier binary.

- Windows: TypeScript/lint, 137 Bare unit tests and 91 Node unit tests passed. The two new inference schema tests passed all 17 assertions; its broader Windows suite has unrelated failures described below.
- RTX: all 331 native tests passed with every model fixture and no skips. Twelve profile tests passed. The final GitHub Actions prebuild was downloaded and its archive SHA-256 verified, then used for FLUX/H3 measurements. CI/source outputs are byte-identical. Actual tiled FLUX and unsupported-size fallbacks are byte-identical to baseline; a full → small → full H3 sequence verifies graph disable/re-enable with exact output.
- Mac and Spark: all 331 native tests passed on each host, with all fixtures and no skips. Twelve profile tests passed on both. Mac uses Metal for native generation; Spark uses the native suite's CPU device, with CUDA separately covered by paired model runs. All three hosts match the final profile, model-interface and policy-test source hashes.
- Engine: all 17 CTest tests and the new GPU operation-equivalence test passed on RTX, Spark and Mac. The [engine CI matrix](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/actions/runs/41886687513) passed all nine native build targets, including CUDA, Vulkan, ROCm, macOS and CPU.
- [Addon CI at the native revision](https://github.com/tetherto/qvac/actions/runs/41907990288): all nine prebuild targets, all three C++ targets, all seven desktop integration lanes, linking, lint, TypeScript and sanity checks passed. Windows integration initially failed before checkout because of a locked runner workspace; the unchanged retry passed. No tests, labels or workflows were disabled or weakened.
- Strix: all four existing HIP backend tests passed. The corrected CI addon archive was SHA-256 verified and loaded with the matching source-built HIP module. H3 HIP speed/quality, H3 Vulkan parity and corrected FLUX HIP fallback passed. FLUX Vulkan also has exact pixel parity. The full 331-test addon suite was not rerun on Strix. No LTX performance or stability pass is claimed.
- [CI for the HIP fallback correction](https://github.com/tetherto/qvac/actions/runs/42028874536): all nine prebuilds and all three C++ targets passed. Remaining desktop lanes were still running or queued at report time. [Windows integration](https://github.com/tetherto/qvac/actions/runs/42028874536/job/127259941020) failed before checkout because a stale Python runner workspace was locked. This infrastructure blocker is documented; no test was disabled or weakened. The earlier documentation run's Linux GPU-allocation failure remains recorded; its retry was superseded by this full run.

Reported percentages use unrounded medians.

All three original test directories were removed after preserving results, freeing 220.1 GiB. The separate Strix test directory and models were also removed before its booking ended, freeing another 70.4 GiB. No files outside these task directories were removed.

## Validation and remaining limits

- Native policy tests cover the GPU/API matrix, memory and output boundaries, explicit overrides and fallbacks. Metadata-only registry descriptions cannot produce a baseline-memory fit verdict when full downloaded weights may select GEMM. Eligible dynamic FLUX convolution profiles conservatively return `unknown`; H3 uses engine-default graph planning.
- Merged-engine operation tests exercise enabled H3 defaults, fused SwiGLU, exact QKV views, strided normalization, multiple shapes/batches, per-context isolation, runner rebuilds and rejection of busy setters. The context-parameter ABI layout is unchanged.
- Linux native tests use their existing CPU device setting; GPU model execution is validated separately. Direct runs with GPU driver modules initialized reported process-exit driver allocations under LeakSanitizer. No new leak suppression or test exclusion was added. Preserve these diagnostics alongside the final CPU-lane result.
- The local Windows SDK/inference suite has unrelated Unix-path, permission, RPC timing and shared-state failures. New schema tests pass. Its draft PR remains low priority and is not presented as fully validated.
- Strix still needs a complete LTX HIP/Vulkan fallback and repeat-stability pass, full-size repeated H3 HIP timing, and diagnosis of the rejected FLUX HIP output. A host reboot ended the final queue; it cannot be attributed to a model or driver from the available evidence. No system configuration was changed.
- This is a narrow checkpoint/workload validation, not a family-wide quality benchmark. More prompts, longer/larger outputs, adapters, concurrent contexts, other GPU variants and new checkpoint layouts need paired measurements before expanding the allowlist. GPU memory peaks are sampled, not exact allocator high-water marks. PSNR/SSIM measure numerical agreement, not human preference.
- No mobile performance profile was added. Keep the existing mobile prebuild matrix; Device Farm was not required for the desktop-only allowlist.

## Integration status

[Engine #64](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/64) is merged. Its two per-context setters are available; the addon uses the VAE setter only. No Fabric change or SDK runtime change is needed. `@qvac/inference` has a separate schema/documentation PR for forwarding optional configuration.

The addon consumes `stable-diffusion-cpp` `2026-11-01#1` from registry `main`, pinned to [registry #496](https://github.com/tetherto/qvac-registry-vcpkg/pull/496)'s merge commit `69541270b6cba537ee42b14a845013d20a061ba7`. The scoped registry entry selects only this port; the default and Microsoft registry baselines remain unchanged. All five registry port files are byte-identical to the validated overlay, which has been removed from the addon. The version history records port tree `009eb7745259b95913109f5b1f1a1ff71495718c` and retains every previous version.

The engine archive SHA-512 remains `dced9d52efbf8ae7b35cd9e81816190f85178a631c6166095034375d92e0847125f435ec8fed4e7642817158ceb5f5967d34f71b83fcd89756b5d969efa5f71a`; ggml remains on the existing 2026-11-01 revision.

A native `arm64-linux` vcpkg dry run, repeated with the CUDA and native-test
features enabled, fetched registry `main` at the merged baseline and resolved
`stable-diffusion-cpp` `2026-11-01#1` to the recorded port tree without an overlay.
It retained ggml `2026-11-01#1` and inference-addon-cpp `1.5.0` from the existing
default registry baseline. This verifies dependency resolution, not a fresh
packaged-backend build or model-performance measurement.

The registry merge and final dependency-resolution checks are complete. Remaining work: repeat paired model checks and packaged-backend validation, then complete review of [addon #5578](https://github.com/tetherto/qvac/pull/5578). The [low-priority draft inference #5577](https://github.com/tetherto/qvac/pull/5577) remains separate. Version and changelog changes belong to separate release PRs.
