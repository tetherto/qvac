# QVAC-24205: GPU backend selection allowlist plan

## Document status

- Task: [QVAC-24205](https://app.asana.com/1/45238840754660/project/1214153063536860/task/1217874135127096)
- Prepared: 2026-09-07
- Status: investigation complete; ready to implement with the explicit policy choices below recorded during review
- Intended audience: task owner, inference-addon maintainers, QVAC-23763 owners, and reviewers
- Scope: planning only; this document does not change runtime behavior or Asana state

## Executive summary

QVAC-24205 addresses a real registration-order bug. The LLM and embedding addons currently treat nearly every GGML GPU or integrated-GPU device as eligible, so adding HIP to shared `@qvac/fabric` can make an AMD ROCm device win merely because it was registered before a backend the addon has actually validated.

The investigation found that the affected surface is broader than the two selectors named in the task:

- `llm-llamacpp` is affected in backend selection, tensor-split device discovery, row-split capability inspection, and a currently test-only effective-device count.
- `embed-llamacpp` is affected in backend selection, row-split capability inspection, and its effective-device count.
- `translation-nmtcpp` already consumes shared Fabric and can select an unvalidated device in its default and explicit selection paths.
- `model-fit` already consumes shared Fabric, and both execution paths can let llama.cpp enumerate arbitrary registered GPUs. Its public raw registered-device counts remain useful diagnostics, but must be separated from the eligible execution inventory.
- `ocr-ggml` is already allowlisted and should remain untouched.
- `vla-ggml` deliberately supports HIP/ROCm and should retain that behavior.

The active QVAC-23763 CUDA/capability stack recognizes HIP/ROCm as selectable LLM and embed backend families, while QVAC-24205 explicitly requires mock ROCm devices not to be selected. That overlap requires coordination, but QVAC-23763 is not a dependency of this task. The allowlist should be implemented from current main now and must land before either addon migrates to shared Fabric. Whichever overlapping selector change lands second must rebase and preserve both tasks' accepted behavior.

## Task state and intended acceptance

At investigation time, QVAC-24205 is assigned, incomplete, Medium priority, categorized as a Chore, and has no dependencies, subtasks, comments, or attachments.

The task requires:

1. LLM and embed never return a GPU outside an explicit validated allowlist.
2. An unrecognized or unvalidated backend falls through to the next eligible candidate or CPU.
3. Mock ROCm tests in both backend-selection unit suites prove ROCm is not selected.
4. Existing validated backend behavior is unchanged.
5. Translation and model-fit receive a written affected-or-unaffected verdict and a fix when affected.
6. OCR is not modified.
7. VLA retains its intentional HIP/ROCm behavior.

## Repository and dependency state

### Shared Fabric

Shared Fabric now ships a Linux x64 HIP backend. Any package consuming `@qvac/fabric` can therefore observe HIP/ROCm devices even if that package never requested or validated HIP itself.

### Package exposure

| Package                                                   | Fabric relationship                                                                                       | Exposure verdict                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `llm-llamacpp`                                            | Still builds its direct Fabric dependency rather than consuming the shared npm package on current main    | The selector is unsafe now and will become more exposed during shared-Fabric migration                |
| `embed-llamacpp`                                          | Same direct-build position as LLM                                                                         | The selector is unsafe now and will become more exposed during shared-Fabric migration                |
| `translation-nmtcpp`                                      | Depends on `@qvac/fabric`                                                                                 | Actively affected                                                                                     |
| `model-fit`                                               | Depends on `@qvac/fabric`                                                                                 | Both normalized and generic fit execution are affected; raw public inventory counts remain diagnostic |
| `ocr-ggml`                                                | Uses explicit supported-backend matching                                                                  | Unaffected                                                                                            |
| `vla-ggml`                                                | Shared-Fabric consumer with deliberate HIP/ROCm preference                                                | Unaffected by design                                                                                  |
| `classification-ggml`                                     | Loads the shared Fabric backend directory on Linux/Android, then explicitly requests a device by CPU type | Unaffected because registered GPU backends are never selected; record the verdict and leave unchanged |
| `tts-ggml`, `asr-ggml`, `bci-whispercpp`, `audiogen-ggml` | Use the separate `speech-cpp` GGML runtime                                                                | Out of scope; shared Fabric backends cannot reach them                                                |
| `diffusion-cpp`                                           | Uses the separate `stable-diffusion-cpp` GGML runtime                                                     | Out of scope even though #4126 also changes its own generic selector                                  |

This accounts for all twelve GGML addons: seven on the Fabric stack, four on the speech stack, and one on the diffusion stack. Package `vcpkg.json` files, rather than `ggml-coload-smoke/addons.js`, are the authority for this partition because the smoke inventory does not list every consumer.

## Conflict with QVAC-23763

The following stacked PRs are open drafts as of 2026-09-07:

- [#4126](https://github.com/tetherto/qvac/pull/4126): CUDA support and backend override for LLM/embed. It is changes-requested and currently conflicted.
- [#4127](https://github.com/tetherto/qvac/pull/4127): VLA CUDA priority and override, stacked on #4126. It is approved but remains an open draft.
- [#4203](https://github.com/tetherto/qvac/pull/4203): capability-based filtering, stacked on #4127.

The final stack recognizes `cuda`, `vulkan`, `metal`, `opencl`, `hip`, `rocm`, and `sycl`, canonicalizes `hip` to `rocm`, and currently has tests in which a ROCm device remains a valid generic GPU selection. That directly contradicts QVAC-24205's ROCm rejection criterion. Resolve the conflict through an agreed resulting policy and rebase direction, not by waiting for the draft stack to land.

### Recommended policy

Maintain two separate concepts:

1. **Recognized family:** the parser understands the name and can produce a useful validation message.
2. **Eligible family:** the consuming package has validated build, load, inference, memory, and fallback behavior for that backend.

A recognized family must not automatically become eligible. The eligibility allowlist must be package-specific.

Recommended initial policy:

| Consumer                        | Eligible families                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| LLM                             | Vulkan, verified MTL (`metal` as OCR's defensive alias), the supported OpenCL/Adreno path, and CUDA only after QVAC-23763 validation |
| Embed                           | Vulkan, verified MTL (`metal` as OCR's defensive alias), the supported OpenCL/Adreno path, and CUDA only after QVAC-23763 validation |
| Translation                     | Vulkan, verified MTL (`metal` as a defensive alias), and its existing build-guarded OpenCL path                                      |
| Model-fit normalized completion | Exactly the families eligible for the LLM load path represented by that fit request                                                  |
| Model-fit normalized embedding  | Exactly the families eligible for the embed load path represented by that fit request                                                |
| Model-fit generic fit execution | Use the LLM eligibility policy for devices supplied to `common_fit_params`; continue reporting raw inventory separately              |
| VLA                             | Preserve its existing HIP/ROCm policy                                                                                                |

HIP/ROCm and SYCL remain ineligible for LLM, embed, translation, and model-fit execution until package-specific validation exists. Model-fit may continue exposing raw registry inventory as diagnostics, but raw counts must not determine the devices used for fit estimates.

### Explicit unsupported override decision

Translation has an explicit string `gpu_backend` on current main. LLM and embed do not: their current `MainGpu` accepts an integer or the symbolic `Integrated`/`Dedicated` values. A string override such as `backend: "rocm"` becomes relevant to LLM/embed only when reconciling with #4126.

For translation now, and for LLM/embed at QVAC-23763 rebase time, the owner must choose and record one behavior for an explicitly requested unsupported family:

- Return a clear unsupported-backend error. This is recommended because silently using a different backend violates explicit user intent.
- Or treat the requested backend as unavailable and follow the established fallback chain. This is closer to the current wording of QVAC-24205.

Automatic selection must skip the backend either way. Current-main numeric `main-gpu` behavior must also be specified because its index addresses the global GGML registry rather than a filtered eligible-device array.

## Behavioral baseline

“No behavior change” means behavior on current `upstream/main` for previously validated backends, before QVAC-23763:

- Automatic LLM/embed selection admits the existing Adreno OpenCL path, then the existing non-OpenCL GPU/iGPU order, then CPU.
- Non-Adreno OpenCL is already omitted from automatic selection. QVAC-23763's override-only bucket for it is new behavior and must not be mistaken for the baseline this task preserves.
- LLM deliberately detects Adreno with the broader lowercase token `"dreno"`; embed currently uses `"adreno"`. Preserve these package-specific matches unless normalization is separately justified and regression-tested.
- Shared LLM/embed behavior—Mali/Vulkan, discrete-versus-integrated, numeric/symbolic `main-gpu`, and CPU fallback—must remain unchanged for eligible devices.
- LLM-only finetuning and BitNet branches must remain unchanged; they are not embed behavior.
- CUDA behavior is added by QVAC-23763 and must be reconciled during rebase; it is not part of QVAC-24205's pre-CUDA baseline.

## Decisions to record during implementation

These decisions must be recorded before the affected PR is finalized, but the QVAC-23763 draft does not block starting the current-main allowlist work:

| Gate                    | Required answer                                                                                                                                                                                                 | Blocking scope                                              | Evidence to record                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| Backend eligibility     | Start with current-main Vulkan, verified MTL, and supported Adreno/OpenCL eligibility. Decide whether CUDA joins during the QVAC-23763 rebase; HIP/ROCm remains excluded unless QVAC-24205 is formally revised. | LLM, embed, and model-fit                                   | Recorded eligibility matrix plus combined tests                  |
| Explicit override       | Does an explicitly requested unsupported family error or fall back? Apply now to translation and only at #4126 rebase time to LLM/embed.                                                                        | Translation now; LLM/embed during QVAC-23763 reconciliation | One documented rule plus matching negative tests                 |
| Numeric device identity | Does `main-gpu` retain global GGML index semantics when excluded devices are present?                                                                                                                           | LLM and normalized model-fit                                | Documented index rule plus excluded-index tests                  |
| CUDA overlap            | Which task lands first, and which owner rebases the second selector change while retaining both test matrices?                                                                                                  | LLM and embed                                               | Agreed rebase direction; this does not block starting QVAC-24205 |
| Generic `mainGpu`       | How is a caller's GPU ordinal mapped after unsupported devices are removed from fit execution?                                                                                                                  | Generic model-fit                                           | Documented mapping plus mixed-backend tests                      |
| Translation families    | Are CUDA and explicit guard-bypassing OpenCL considered validated for translation?                                                                                                                              | Translation                                                 | Translation-specific allowlist and fallback rule                 |

## Technical investigation

### LLM

Primary implementation:

- `packages/llm-llamacpp/addon/src/utils/BackendSelection.cpp`
- `packages/llm-llamacpp/addon/src/utils/BackendSelection.hpp`
- `packages/llm-llamacpp/test/unit/test_backend_selection.cpp`

Current behavior:

- RPC is excluded by registry name.
- OpenCL/Adreno is handled specially.
- All other discrete GPUs enter a generic GPU bucket.
- All other integrated GPUs enter a generic iGPU bucket.
- The first device in a bucket wins, making selection dependent on registration order.

All inventory consumers requiring audit:

1. Backend choice.
2. Tensor-split device discovery and physical-device deduplication.
3. Row-split capability inspection.
4. Effective GPU device count, even though production use currently appears absent.

The selected backend, split capability result, and actual device list supplied to llama.cpp must all derive from the same eligible inventory. Filtering only the returned backend would still permit an excluded HIP device to affect load behavior.

### Embed

Primary implementation:

- `packages/embed-llamacpp/addon/src/model-interface/BackendSelection.cpp`
- `packages/embed-llamacpp/addon/src/model-interface/BackendSelection.hpp`
- `packages/embed-llamacpp/test/unit/test_backend_selection.cpp`

It shares LLM's generic GPU/iGPU eligibility flaw. It also contains effective-count and row-split inspection paths, although it does not currently have LLM's tensor-split device-name helper.

### Translation

Primary implementation:

- `packages/translation-nmtcpp/addon/src/model-interface/nmt_utils.cpp`
- `packages/translation-nmtcpp/addon/src/model-interface/nmt_state_backend.cpp`

The task refers to lazy backend initialization, but actual device selection is centralized in `nmtSelectGpuDevice` and influences both loader buffer selection and compute-backend initialization.

Findings:

- Default selection can choose the first non-CPU device without validating either its backend family or its device type; this includes arbitrary ACCEL/META entries as well as GPU/IGPU entries.
- Explicit `gpu_backend` validation restricts characters, not supported backend families, so `gpu_backend: "rocm"` currently substring-matches a device such as `ROCm0`.
- The secondary ACCEL initialization walk cannot reach HIP/ROCm because HIP devices are GPU-typed. It still needs a written audit verdict for unknown ACCEL entries, but it is not part of the ROCm selection defect.
- Loader and compute paths must continue to use the same selected device.
- The pinned GGML enum orders `IGPU` between `GPU` and `ACCEL`; the translation comment about Android values “between GPU and ACCEL” therefore refers to integrated GPUs, not ACCEL devices. Primary GPU selection may admit only GPU/IGPU devices from validated backend families and reject ACCEL/META outright.

Translation is affected and requires implementation plus mockable C++ selection tests.

### Model-fit

Primary implementation:

- `packages/model-fit/addon/src/fit/FitParams.cpp`
- `packages/model-fit/addon/src/fit/LlamaLoadConfig.cpp`

Findings:

- `countDevices` includes every GPU/iGPU and affects exposed counts and `mainGpu` validation.
- `discoverBackendDevices` and its selection logic can choose arbitrary discrete or integrated GPU devices.
- The normalized LLM/embed fit path currently constrains `common_params.devices` only when split mode is `NONE`. For `LAYER` and `ROW`, it sets `main_gpu` but leaves the device list empty, causing llama.cpp to enumerate every registered GPU.
- The normalized row-split capability probe also inspects every discovered GPU rather than an eligible inventory.
- The generic `fitParams` path calls `common_fit_params` against GGML's global inventory. An extra registered backend can therefore change its estimate even if LLM would never use that backend.
- `nDevices` and `nGpuDevices` are documented public inventory fields. Reinterpreting `nGpuDevices` as an eligible count would be a contract change and is not required to fix normalized backend selection.

Model-fit therefore needs two deliberately separate concepts:

1. Raw registered-device diagnostics, preserving the current public `nDevices`/`nGpuDevices` contract.
2. An internal eligible device inventory used by generic and normalized fit execution, main-device resolution, split-capability checks, and null-terminated fitter device lists.

Model-fit is affected in both execution paths. Preserve raw diagnostic counts, but do not let them define the execution inventory. Under QVAC-24205, the generic llama fitter should use the LLM allowlist because its estimates are intended to predict llama.cpp loading. If maintainers reject that interpretation, record the path as affected-and-deferred with a follow-up task and keep QVAC-24205 incomplete until its acceptance criterion is revised; it must not be labeled unaffected.

## Implementation design

### 1. Package-local identity and eligibility helpers

Each work PR must modify one package only, so implement a small package-local helper rather than introducing a cross-package dependency. Copy the established matcher shape from `ocr-ggml` as the task explicitly requests, adapting only package-specific eligibility and ordering.

The helper must:

1. Normalize values case-insensitively.
2. Inspect both GGML device name and backend registry name.
3. Never infer backend family from the human-readable hardware description.
4. Recognize Vulkan by its family substring.
5. Recognize the pinned Fabric Metal identity through the verified `MTL` prefix: the registry is `MTL` and devices are `MTL0`, `MTL1`, and so on. Retain OCR's additional `metal` prefix only as an intentional defensive alias for a future rename, not as the current registry identity.
6. Recognize OpenCL by family identity while retaining existing device restrictions.
7. Recognize CUDA only where the QVAC-23763 capability and load path has been accepted.
8. Reject RPC, HIP/ROCm, SYCL, and unknown families unless explicitly validated for that package.

### 2. Filter once, consume consistently

Construct or classify an eligible candidate inventory before priority buckets and backend-specific side effects are evaluated. Preserve registry order among eligible candidates so validated-backend behavior does not change.

Every selection-affecting downstream operation must consume this same inventory:

- Default selection.
- Explicit selection.
- Internal eligible-device counts, where needed. Public raw diagnostic counts remain separate and clearly named.
- Main-device validation.
- Multi-device and tensor-split lists.
- Row-split capability checks.
- Loader and compute initialization.
- Model-fit inputs.

### 3. LLM implementation

1. Implement the OCR-style allowlist from current main in a separate LLM-only PR now; do not wait for QVAC-23763.
2. Separate known override names from eligible candidate families.
3. Filter candidates before the current OpenCL, generic GPU, iGPU, and CPU prioritization. When rebasing with QVAC-23763, apply the same filter before its CUDA bucket as well.
4. Preserve the current-main baseline: Adreno/OpenCL automatic selection, non-Adreno OpenCL omission, Mali/Vulkan behavior, the LLM-specific `"dreno"` match, Metal, discrete-over-integrated, and CPU fallback.
5. Reuse the filtered inventory for tensor split and row-split checks.
6. Ensure excluded device handles never reach llama.cpp model parameters.
7. Either remove the unused effective-count helper or make it consume the eligible inventory and retain focused tests.
8. Preserve global numeric device-index meaning. An index pointing to an excluded device must not be reinterpreted as a different eligible index.
9. Coordinate with QVAC-23763 so the second change to land rebases and keeps both suites; the allowlist remains a hard prerequisite for shared-Fabric migration regardless of that order.

### 4. Embed implementation

1. Apply the same identity and eligibility semantics as LLM within the embed package.
2. Filter before generic GPU/iGPU bucketing.
3. Reuse the eligible inventory for selection, effective counts, and row-split checks.
4. Preserve the current-main baseline, including embed's exact `"adreno"` match, automatic Adreno/OpenCL behavior, non-Adreno OpenCL omission, validated backend ordering, and CPU fallback.
5. Implement from current main now in an embed-only PR. Coordinate the eventual QVAC-23763 rebase in whichever direction the merge order requires.
6. Keep the allowlist as a hard prerequisite for embed's shared-Fabric migration.

### 5. Translation implementation

1. Extract selection into a pure function or introduce an injectable registry interface so tests do not require AMD hardware.
2. Build a translation-specific eligible inventory before ranking candidates. Eligibility must require GPU or IGPU type plus a validated backend family; reject ACCEL and META as primary GPU candidates.
3. Use the selected device for both model buffers and lazy compute initialization.
4. Audit the secondary ACCEL backend walk separately. Document that HIP/ROCm cannot enter it because HIP is GPU-typed, and decide whether unknown CPU-companion accelerators should retain their existing secondary initialization behavior.
5. Replace character-only explicit-backend validation with family eligibility validation while retaining safe input parsing; prove that `gpu_backend: "rocm"` cannot select `ROCm0`.
6. Preserve platform and build guards for OpenCL.
7. Record the final affected-and-fixed verdict in Asana.

### 6. Model-fit implementation

1. Preserve `countDevices`, `nDevices`, and `nGpuDevices` as raw registry diagnostics unless the owner explicitly approves a public semantic change.
2. Construct a reusable internal eligible inventory with raw registry identity retained for stable ordinal mapping.
3. For normalized completion and embedding, mirror the corresponding addon's allowlist and selection priority.
4. For split mode `NONE`, keep emitting the selected handle plus the required null terminator.
5. For `LAYER` and `ROW`, add new construction of a null-terminated list containing every eligible load device; do not leave `common_params.devices` empty and fall back to global enumeration.
6. Run the row-split capability probe against that eligible list only.
7. Resolve `main-gpu` against an explicitly documented mapping. Preserve the caller-visible meaning where possible; reject an ordinal targeting an excluded device rather than silently renumbering it.
8. Apply the LLM eligibility policy to the generic `fitParams` execution inventory and pass that null-terminated list to `common_fit_params`, while continuing to report raw diagnostic counts separately.
9. Add an injection seam around the generic fit invocation—or an equivalent dependency object carrying the prepared `common_params`—so a unit test can capture the exact device list handed to `common_fit_params` without using the real GGML registry or executing real llama.cpp.
10. If maintainers decline to make generic fitting match LLM, record it as affected-and-deferred under a follow-up task and revise QVAC-24205's acceptance criteria before closure; do not call it unaffected.
11. Record both normalized and generic execution verdicts in Asana.

## Test plan

### Common selector matrix

Both LLM and embed unit suites must cover:

1. ROCm registered before Vulkan selects Vulkan.
2. ROCm registered after Vulkan still selects Vulkan.
3. ROCm-only registry falls back to CPU.
4. Integrated ROCm is rejected.
5. Unknown discrete and integrated GPU families are rejected.
6. Mixed-case backend names are normalized.
7. Metal is recognized through the verified `MTL`/`MTL0` identity; OCR's defensive `metal` prefix alias is covered separately.
8. RPC remains excluded.
9. Existing Adreno/OpenCL, Mali/Vulkan, Metal, discrete/iGPU, and CPU tests remain unchanged.
10. Explicit numeric selection targeting an excluded device does not accidentally select another device.
11. Translation's current string override behavior matches the recorded decision. Add equivalent LLM/embed coverage only when rebasing with #4126, where that API is introduced.

### LLM-specific tests

1. Tensor-split device lists exclude ROCm, SYCL, RPC, and unknown devices.
2. Duplicate physical devices exposed through multiple registries remain correctly deduplicated after filtering.
3. Row-split support inspects exactly the devices eligible for loading.
4. The actual model device parameter contains no excluded handles.
5. CUDA cases introduced by QVAC-23763 remain valid under the approved policy.
6. Non-Adreno OpenCL remains excluded from automatic current-main selection.
7. Existing LLM Adreno detection through the lowercase `"dreno"` token retains its current behavior.

### Embed-specific tests

1. Effective count includes only eligible devices if the helper is retained.
2. Row-split support inspects only eligible devices.
3. CUDA cases introduced by QVAC-23763 remain valid under the approved policy.
4. Non-Adreno OpenCL remains excluded from automatic current-main selection.
5. Existing embed Adreno detection through the exact lowercase `"adreno"` token retains its current behavior.

### Translation-specific tests

1. ROCm-before-Vulkan chooses Vulkan.
2. ROCm-only and unknown-only registries fall back to CPU.
3. Explicit unsupported backend follows the chosen error/fallback contract.
4. Existing Vulkan, Metal, and guarded OpenCL behavior remains unchanged.
5. Buffer loading and lazy compute initialization receive the same device.
6. An unknown ACCEL entry cannot become the primary GPU; the secondary ACCEL behavior matches its recorded audit verdict.
7. An Android Vulkan IGPU remains eligible, while ACCEL and META entries cannot become the primary GPU.
8. Explicit `gpu_backend: "rocm"` cannot select `ROCm0`.

### Model-fit-specific tests

1. Raw `nDevices` and `nGpuDevices` continue to count registered devices according to their documented contract, including registered GPU-class ROCm devices.
2. A separate internal eligible inventory excludes ROCm and unknown backends from generic and normalized fit execution.
3. Registration order cannot make ROCm the selected load device.
4. `mainGpu` cannot select or be remapped through an excluded device.
5. Captured fitter parameters contain no excluded handles for `NONE`, `LAYER`, or `ROW` split modes.
6. Mixed Vulkan/ROCm and Metal/ROCm inventories produce stable results.
7. Completion and embedding modes match the corresponding addon policies.
8. CUDA parity is verified in the combined test matrix when QVAC-23763 is rebased with this work.
9. Row-split capability ignores excluded devices but still checks every eligible device.
10. Through the new generic-fit injection seam, the null-terminated device list handed to `common_fit_params` excludes ROCm and unknown devices while retaining every eligible device in stable order.

### Regression and validation commands

Run the full existing relevant suites; do not skip or weaken tests.

#### `llm-llamacpp`

- `npm run test:all`
- `npm run lint`
- `npm run lint-cpp`
- `npm run test:types`

#### `embed-llamacpp`

- `npm run test:all`
- `npm run lint`
- `npm run lint-cpp`
- `npm run test:types`

#### `translation-nmtcpp`

- `npm run test:all`
- `npm run lint`
- `npm run test:types`
- `npm run lint-cpp`

#### `model-fit`

- `npm run test`
- `npm run lint`
- `npm run test:cpp`
- `npm run test:types`
- `npm run lint-cpp`

Run the applicable package CI workflows and a shared-Fabric smoke validation. Mock registries provide the mandatory regression coverage without requiring AMD hardware. An AMD smoke run is useful additional confirmation but is not a substitute for deterministic unit tests.

Run a targeted VLA regression proving its HIP behavior remains intact without modifying the VLA package. Verify OCR through its existing selector tests without changing OCR code.

## Delivery and sequencing

Follow the repository rule that each PR modifies exactly one package.

### Recommended order

1. Record the package allowlists, explicit-override behavior, numeric-device semantics, and QVAC-23763 rebase owner.
2. Implement `llm-llamacpp` from current main as an LLM-only PR.
3. Implement `embed-llamacpp` from current main as a separate embed-only PR.
4. Implement `translation-nmtcpp` from current main with family-and-device-type eligibility.
5. Implement `model-fit` from current main, covering generic execution and all normalized split modes while preserving raw diagnostic counts.
6. Rebase whichever of QVAC-24205 or QVAC-23763 lands second and run the combined selector/capability test matrix.
7. Require the LLM and embed allowlists to be merged before their respective shared-Fabric migration PRs. No such migration PR is open at the time of this plan.
8. After each work PR lands, prepare a separate package release PR containing the version bump and changelog entry.

The four package PRs may be developed independently after the small policy decisions are recorded. QVAC-23763's draft state must not delay the allowlist. Do not fold QVAC-24205 into its existing multi-package PRs without an explicit exception to the package-boundary rule; coordinate the overlapping rebase instead.

Each work PR must state:

- Its exact eligible backend families.
- The explicit unsupported-backend behavior where such an override exists.
- Every device-registry walk audited.
- How actual load-device arrays were constrained.
- Why OCR and VLA were not modified.
- The registration-order and fallback test evidence.

## Acceptance traceability

| Acceptance requirement                                        | Planned evidence                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| LLM never automatically returns an unvalidated GPU            | Mixed-backend, unsupported-only, explicit-index, tensor-list, row-split, and captured-load-device tests in the LLM PR             |
| Embed never automatically returns an unvalidated GPU          | Mixed-backend, unsupported-only, explicit-index, row-split, and captured-selection tests in the embed PR                          |
| ROCm regression is represented without AMD CI hardware        | Deterministic mock registry entries in both required backend-selection C++ suites                                                 |
| Unknown backend falls through safely                          | Unknown GPU/iGPU before and after a validated candidate, plus unknown-only CPU-fallback cases                                     |
| Existing validated backends do not change                     | Existing selector suites pass unchanged; new ordering tests preserve the prior eligible-backend priority                          |
| Translation verdict exists                                    | Asana comment identifying the default selector and ACCEL audit result, with PR/test links when fixed                              |
| Model-fit verdict exists                                      | Asana comment recording both generic and normalized execution as affected-and-fixed, with raw counts retained only as diagnostics |
| Classification is accounted for                               | Written unaffected verdict citing its explicit CPU-type device request after backend loading; no classification files changed     |
| Speech and diffusion stacks are accounted for                 | Written out-of-scope verdict citing their separate GGML runtimes; no package changes under QVAC-24205                             |
| OCR remains unchanged                                         | No OCR files in any work PR; existing OCR selector validation remains green                                                       |
| VLA retains HIP behavior                                      | No VLA files in any work PR and targeted VLA HIP regression remains green                                                         |
| Registration order no longer determines unsupported selection | Both `ROCm,Vulkan` and `Vulkan,ROCm` arrangements produce the same validated result                                               |

## Risks and mitigations

| Risk                                                                                 | Mitigation                                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| QVAC-23763 overwrites or contradicts the selector patch                              | Start from main, agree the resulting policy and rebase owner, then require the second change to retain both test matrices |
| Device-name matching misses Metal                                                    | Match verified `MTL` registry/device prefixes; retain OCR's `metal` prefix only as a documented defensive alias           |
| Human-readable hardware descriptions produce false matches                           | Do not use descriptions for backend-family eligibility                                                                    |
| Filtering selection but not load parameters leaves HIP active                        | Derive every downstream consumer from one eligible inventory                                                              |
| Numeric `main-gpu` changes meaning after filtering                                   | Preserve global index semantics and explicitly handle excluded targets                                                    |
| Mixed-vendor or duplicate registrations destabilize splits                           | Filter first, then deduplicate and preserve existing eligible ordering                                                    |
| Translation loader and compute backend diverge                                       | Pass one selected device through both paths and assert identity in tests                                                  |
| Normalized model-fit reports a safe result for a device the target addon cannot load | Mirror target-addon policies and constrain `common_params.devices`                                                        |
| Changing allowlist logic silently changes public device-count semantics              | Preserve raw `nDevices`/`nGpuDevices`; use a separate internal eligible inventory                                         |
| Generic fitting changes when an excluded backend registers                           | Pass an LLM-eligible device list to `common_fit_params` while preserving raw diagnostic counts                            |
| Layer/row normalized fitting bypasses the filtered selection                         | Build an explicit null-terminated eligible device list for every split mode and filter the row-capability probe           |
| Translation confuses IGPU with ACCEL because of a stale comment                      | Use the pinned enum definition: admit validated GPU/IGPU candidates and reject ACCEL/META as primary GPUs                 |
| Future shared Fabric backends become silently selectable                             | Unknown and recognized-but-unvalidated families default to ineligible                                                     |
| Existing backend performance changes                                                 | Preserve the relative priority of all currently eligible candidates                                                       |

## Definition of done

QVAC-24205 is complete when:

1. The HIP/ROCm conflict with QVAC-23763 is resolved and recorded.
2. Each affected package has an explicit eligibility policy.
3. Selection, internal eligible counts, validation, split decisions, initialization, and load inputs use the same eligible inventory; public raw diagnostics remain explicitly separate.
4. ROCm, SYCL, RPC, and unknown backends cannot influence LLM, embed, translation, or model-fit execution unless explicitly validated for that consumer.
5. Required mock ordering and CPU-fallback tests pass.
6. Existing validated backend tests pass unchanged.
7. Translation and model-fit verdicts are recorded on the Asana task.
8. Classification has a written unaffected verdict based on its explicit CPU-type request after shared backend loading; the speech and diffusion stacks have written separate-runtime out-of-scope verdicts.
9. OCR remains unmodified and VLA's deliberate HIP behavior remains intact.
10. LLM/embed allowlists land before their shared-Fabric migrations.
11. Work PRs and release PRs follow package boundaries and changelog/versioning rules.

## QIP verdict

No QIP is required for the recommended implementation because it is a package-local correctness and safety fix with no required new dependency, public API, or shared runtime contract. If the policy discussion instead creates a stable cross-addon backend capability contract or changes public override semantics across packages, that broader proposal should be triaged separately before implementation.
