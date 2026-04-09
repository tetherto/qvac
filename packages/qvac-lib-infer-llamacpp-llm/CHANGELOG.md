# Changelog

## [0.14.3] - 2026-04-07

### Added

#### `backendDevice` runtime stat
- `runtimeStats()` now includes `backendDevice` (`"cpu"` or `"gpu"`) reporting the actual resolved device used for inference.
- Reflects the device after backend selection and fallback logic, not the user-configured preference.
- Captured as numeric `int64_t` (0/1) at the C++ level, mapped to a string in the JS layer.

## [0.14.2] - 2026-04-07

This patch release updates the qvac-fabric native dependency.

### Changed

#### qvac-fabric dependency bump

Updated qvac-fabric from 7248.2.1#1 to 7248.2.2, aligning all llamacpp-based addons on the same fabric version.

### Pull Requests

- [#1358](https://github.com/tetherto/qvac/pull/1358) - Qvac 16779 qvac fabric lockstep

## [0.14.1] - 2026-04-02

### Changed

- Updated qvac-lib-inference-addon-cpp dependancy from 1.1.2 to 1.1.5
- Reason for the version update:
    - addon-cpp v1.1.2's cancelJob() unconditionally set the model's stop flag whenever a job existed, even if that job was only queued and never started processing. Since the queued job never entered process(), the flag was never consumed or reset.
    - In the llm addon, this meant that cancelling a request and then submitting a new one would cause the new request to abort instantly on entry — returning no results — because it inherited the stale stop flag from the previous cancel.

## [0.14.0] - 2026-03-19

### Added

#### `tools_at_end` configuration for dynamic tool management in multi-turn conversations

New `tools_at_end` configuration option (`"true"` or `"false"`, default: `"false"`) places tool definitions at the end of the prompt (after conversation history) instead of in the system prompt. This enables KV cache optimization for multi-turn conversations with dynamic tool sets, where tools change between turns. Currently supports Qwen3 models only.

- **KV cache trimming**: After each turn, tools are automatically removed from the KV cache, preventing stale tool definitions from accumulating
- **Conversation history reuse**: History tokens are preserved in cache, saving recomputation on long conversations
- **Dynamic tool replacement**: Different tool sets can be used per turn without cache bloat from unused tools

## [0.13.0] - 2026-03-18

### Added

#### LoRA finetuning support

`model.finetune(options)` trains a LoRA adapter on top of a loaded GGUF base model. The adapter is saved as a `.gguf` file and can be loaded at inference time via the `lora` config option. Supports SFT (chat) and causal (next-token) training modes, configurable LoRA parameters (rank, alpha, target modules), validation (none / split / separate dataset), learning rate schedulers with warmup, pause/resume from checkpoints, and inference while paused. The returned `FinetuneHandle` emits `'stats'` progress events during training.

#### New public methods

- `model.finetune(options)` — starts LoRA finetuning, returns a `FinetuneHandle` with `on('stats', cb)` and `await()`.
- `model.pause()` — pauses finetuning and saves a checkpoint so training can resume later. Also cancels an in-flight inference job.
- Added typed `FinetuneOptions`, `FinetuneValidation`, `FinetuneProgressStats`, `FinetuneStats`, `FinetuneResult`, and `FinetuneHandle` interfaces to `index.d.ts`
- Added finetuning guide at `docs/finetuning.md`

### Changed

- `model.cancel()` now also clears pause checkpoints (`pause_checkpoint_step_*`) from the checkpoint directory, so the next `finetune()` call starts fresh instead of resuming.

## [0.12.3] - 2026-03-17

### Added

#### `contextSlides` runtime stat

`runtimeStats()` now includes a `contextSlides` counter that reports how many times the KV cache context window was slid during inference. This replaces the previous approach of parsing log messages to detect sliding context events, providing a reliable, structured stat for downstream consumers.

#### `RuntimeStats` TypeScript interface

Added a `RuntimeStats` type to `index.d.ts` covering all stats keys returned by the C++ addon: `TTFT`, `TPS`, `CacheTokens`, `generatedTokens`, `promptTokens`, and `contextSlides`.

## [0.12.2] - 2026-03-13

This release fixes antiprompt (reverse-prompt) detection for short stop sequences like `\n`, which is critical for translation workloads that rely on newline-based early stopping.

## Bug Fixes

### Antiprompt detection for short stop sequences

Fixed a bug where `checkAntiprompt()` in both `TextLlmContext` and `MtmdLlmContext` only searched the last few characters of the decoded output buffer for the antiprompt string. For short antiprompts like `"\n"` (length 1), the search window was limited to 3 characters at the tail. However, a single llama.cpp token can decode to many characters, placing `"\n"` far from the string's tail end — causing the antiprompt to be missed entirely.

The model would then run to `n_predict` (typically 256 tokens) instead of stopping after the first translated line, wasting compute and producing multi-line output that required post-processing to recover.

The fix widens the search to the entire `kNPrev`-token decoded window (32 tokens by default), reliably catching the antiprompt regardless of where it appears in the decoded string. This only affects models that use the `reverse-prompt` configuration — in practice, the AfriqueGemma translation workflow where `"\n"` signals end of translation.

## [0.12.1] - 2026-03-12

### Added

#### Per-request generation parameter overrides

`model.run(prompt, { generationParams: { temp: 0.7, predict: 256 } })` applies sampling parameter overrides for a single inference call without reloading the model. Load-time defaults are automatically restored after each request.

- Supported parameters: `temp`, `top_p`, `top_k`, `predict`, `seed`, `frequency_penalty`, `presence_penalty`, `repeat_penalty`.
- `generationParams` is passed as a direct property on the addon input (same transport as `prefill`), parsed via N-API in `AddonJs.hpp`.
- C++ `applyGenerationParams()` returns a restore callable that captures saved state; exception-safe via try/catch in `processPrompt()`.
- Supported for both text and multimodal (`MtmdLlmContext`) models.
- Integration tests cover seed reproducibility, predict token limits, and defaults restoration.


## [0.12.0] - 2026-03-09

### Added

#### Hot-reload support (`LlamaModel::reload()`)

`LlamaModel` now stores its construction arguments (`modelPath`, `projectionPath`, `configFilemap`) and exposes a `reload()` method that rebuilds the model in-place from the stored args with `IMMEDIATE` loading (synchronous, blocking). This avoids tearing down and reconstructing the entire `LlamaModel` instance when the same model needs to be reloaded — for example, to reclaim GPU memory or recover from a corrupted context state.

All mutable model state (context, cache manager, backends handle, async weights loader, etc.) is grouped into an internal `ReloadableState` struct. On reload, the old state is replaced atomically with a freshly initialized one.

#### Thread-safe reload with `shared_mutex`

`LlamaModel` is now protected by a `std::shared_mutex` (`stateMtx_`):

- **Shared lock** for all read/use operations: `processPrompt`, `process`, `cancel`, `reset`, `runtimeStats`, `isLoaded`, `waitForLoadInitialization`, and `setWeightsForFile`.
- **Exclusive lock** only in `reload()` via `setInitLoader()`.

This means `reload()` blocks until all in-flight operations complete, while concurrent reads (e.g. multiple inference queries) can proceed in parallel. `cancel()` uses `std::try_to_lock` to gracefully skip cancellation if a reload is already in progress, since there would be nothing to cancel after the reload completes.

#### Streaming-loaded model reload guard

`reload()` now throws `ReloadNotSupportedForStreamedModel` (`StatusError`, error code 24) when called on a model that was loaded via streamed shards (`setWeightsForFile`). The streamed weight buffers are consumed (moved out) by llama.cpp during the initial load and cannot be replayed on reload.

### Changed

- Refactored `LlamaModel` internals: extracted `processPromptImpl` and `cancelImpl` (lock-free implementations) to separate locking concerns from business logic.
- `initializeBackend()` is now private — it is only called internally during `init()`.


## [0.11.1] - 2026-03-09

### Added

#### Prefill mode for context preloading

`model.run(prompt, { prefill: true })` evaluates the prompt into the KV cache without generating tokens. This enables context preloading so that subsequent runs start with a warm cache.

- Prefill runs report `TTFT=0`, `TPS=0`, `generatedTokens=0`, `promptTokens=0`, while `CacheTokens` reflects actual KV cache occupancy.
- JS `normalizeRunOptions` validates `prefill` as a boolean; a `TypeError` is thrown otherwise.
- C++ `evalMessage`/`evalMessageWithTools` suppress logits on the last token when prefill is set; `processPrompt` returns immediately after evaluation.

## [0.11.0] - 2026-03-05

Preparation before fully supporting BitNet. Not officially supported yet, but this version already integrates logic necessary to support BitNet models.

### Added

#### Preparation: BitNet-aware backend selection for Adreno GPUs

Backend selection now detects BitNet models (TQ1_0 / TQ2_0 quantization via `hasOneBitQuantization()` and `general.architecture == "bitnet"`) and adjusts GPU routing on Adreno devices:

- **Adreno 800+** (e.g. Adreno 830): Vulkan is preferred over OpenCL, since BitNet TQ kernels are not supported on OpenCL.
- **Adreno < 800** (e.g. Adreno 740): Falls back to CPU, as TQ kernels run faster on CPU than on older Adreno GPU backends.
- **Non-Adreno GPUs**: No change — normal GPU selection applies.

This logic only activates when no explicit `main-gpu` is configured.

Adreno version detection works regardless of which backend exposes the GPU. The numeric generation (e.g. 830, 740) is parsed from the device description via `parseAdrenoVersion()` and tracked as `maxAdrenoVersion` during device enumeration for any Adreno device — whether it appears behind OpenCL, Vulkan, or another backend. This ensures the BitNet safety checks (CPU fallback on Adreno <800, Vulkan preference on Adreno 800+) are not bypassed when only Vulkan registers a device, as observed on Adreno 750.

#### Preparation: BitNet-aware config tuning (`tuneConfigMap`)

For BitNet models, `tuneConfigMap` injects default overrides into the config map before argument parsing:

- `flash-attn=off` — disables flash attention (unless the user explicitly set `flash-attn` or `flash_attn`).
- `ubatch-size=128` — on Adreno 800+ only (unless the user explicitly set `ubatch-size` or `ubatch_size`).

These entries are written to `configFilemap` (not to `common_params` directly), so they flow through the normal llama.cpp arg parser in `commonParamsParse`. The call sits after backend selection (where the Adreno version is known) but before the config map is converted to the arg vector.

#### `ModelMetaData::tryGetString()` method

`ModelMetaData` now exposes `tryGetString(key)` to retrieve string-typed GGUF metadata values. This is used by the BitNet backend selection logic to read `general.architecture`. Both `tryGetString()` and `hasOneBitQuantization()` are now virtual to support test mocking.

#### Unit tests for BitNet backend selection

Added comprehensive unit tests covering BitNet TQ backend selection across Adreno 830/740, non-Adreno GPUs, OpenCL-only scenarios, Vulkan-only scenarios, and mixed GPU/iGPU configurations. `MockModelMetaData` is defined in `test_common.hpp` and shared across test files.

### Changed

- Updated qvac-fabric-llm.cpp dependency from 7248.1.3 to 7248.1.4.
- Refactored `ModelMetaData` internal getters using a template helper, reducing duplication between `tryGetU32` and `tryGetString`.
- Added virtual destructor to `ModelMetaData` for correct polymorphic cleanup.
- Simplified `REQUIRE_MODEL` test macro by removing the `do {} while(false)` wrapper to suppress compiler warnings.


## [0.10.0] - 2026-03-02

### Added

#### Model metadata querying via LlamaModel

`LlamaModel` now exposes `ModelMetaData`, which parses GGUF key-values at init time (before weights are fully loaded) and makes them available for early decisions such as quantization detection and backend selection. Queries are available through `tryGetU32()`, `isU32OneOf()`, and `hasOneBitQuantization()`.

#### ModelMetaData streaming synchronization

For streaming model loads, `ModelMetaData` coordinates with `AsyncWeightsLoader` to borrow the first shard buffer. The synchronization state is encapsulated in a public nested class `ModelMetaData::FirstFileFromGgufStreamState` with `waitForRelease()` and `provide()` methods, protected by a mutex and condition variable. Both the consumer and producer waits are bounded by configurable timeouts.

### Fixed

#### GGUF streambuf reader fails to align data section (Fabric 1.1.3 upgrade)

Fixed a bug in the GGUF buffer reader (`gguf_bytes_buffer_reader::align`) where `pubseekoff` was called without specifying a direction (`std::ios_base::in`). The default `which` parameter is `ios_base::in | ios_base::out`, and per the C++ spec, `std::stringbuf::seekoff` with `way=cur` and both directions set always returns `-1` — regardless of the streambuf's open mode. This caused `"gguf_init_from_reader_impl: failed to align data section"` when loading model metadata from an in-memory stream (e.g. during streaming model loads), while the disk-backed `FILE*` path was unaffected because `fseek` has no direction concept.

The fix passes `std::ios_base::in` explicitly to `pubseekoff` in the llamacpp tether layer. This low-level alignment fix stems from the upgrade to Fabric 1.1.3.

## [0.9.2] - 2026-03-03

### Fixed

- **Deterministic busy detection:** Replaced the timing-based `_lastJobResult` + 30ms timeout with a synchronous `_hasActiveResponse` boolean flag. On fast hardware (iPhone Metal GPU), short jobs could complete in under 30ms, causing the timeout-based race to be won by the resolved promise instead of the busy guard — allowing a second `run()` through. The flag is now checked synchronously inside `_withExclusiveRun` before any `await`, and cleared via a chained `response.await()` promise so ordering is structurally explicit.
- **Concurrency test made deterministic:** The `run | run` concurrency test now uses `Promise.race` to handle the case where the first job finishes before the second `run()` is rejected, preventing flaky failures on fast hardware.

## [0.9.1] - 2026-02-23
- Use patched version of addon-cpp to reduce logging noise.

## [0.9.0] - 2026-02-18

- Use new addon-cpp architecture for simplified Js Addon creation and usage.
- Use AddonCpp on CLI executable (to mimic JsAddon behavior/usage).
- Single job per addon instance; no templates, no state tracking.
- Asynchronous cancel based on futures: `await addon.cancel()` / `await response.cancel()` now wait until the job is actually finished.
- **Multiple images support:** Prompts can now include several `type: 'media'` user messages; each image is loaded in order and matched to placeholders so the model receives all images.
- Integration test for multiple images in one prompt (`llama addon can handle multiple images in one prompt`).

---

### Changed
- Multimodal parser now emits one user message per image (each with a single placeholder) so the tokenizer maps each placeholder to the corresponding bitmap and all images are in context.

### Breaking Changes

**LlamaInterface / Addon (native addon surface):**

- **Constructor:** The 4th argument `transitionCb` (state-change callback) was removed. The addon no longer reports LISTENING / IDLE / STOPPED etc.
- **Removed methods:** `pause()`, `stop()`, `status()`, **`destroyInstance()`** — single-job addon no longer exposes queue/state or pause/stop. Use **`unload()`** for teardown instead of `destroyInstance()`.
- **`append(data)` → `runJob(messages)`:** Input was a single object `{ type, input? }` (and a separate "end of job" append); now a **single array** of message objects for the whole run. No longer returns a job ID (only one job per instance).
- **`cancel(jobId?)` → `cancel()`:** No `jobId` argument (only one job). **Behavior:** `await addon.cancel()` (and thus `await response.cancel()`) now **waits until the job is actually finished** (future-based cancel in C++); previously `await` did not guarantee the job had stopped.

**LlmLlamacpp usage:**

- **Single job per run:** Each `run(prompt)` sends one `runJob(promptMessages)` and uses a fixed job id `'job'`. Queueing multiple `append()` calls and using multiple job IDs is no longer supported.
- **`END_OF_INPUT` / second append:** No longer used; the full prompt (including optional media) is sent in one `runJob()` call.

#### BEFORE

```typescript
// Old: constructor with state callback
const addon = new LlamaInterface(binding, config, outputCb, (state) => logger.info(state))

// Old: queue text then end-of-input; cancel by job ID
const jobId = await addon.append({ type: 'text', input: JSON.stringify(prompt) })
await addon.append({ type: 'end of job' })
// ...
await addon.cancel(jobId)  // jobId optional; await did NOT guarantee job finished

// Old: state and control
await addon.status()
await addon.pause()
await addon.stop()

// Old: teardown
await addon.destroyInstance()
```

#### AFTER

```typescript
// New: no state callback
const addon = new LlamaInterface(binding, config, outputCb)

// New: single run with array of messages; cancel with no args and proper completion
const promptMessages = [
  { type: 'media', content: mediaUint8Array },
  { type: 'text', input: JSON.stringify(textMessages) }
]
await addon.runJob(promptMessages)
// ...
await addon.cancel()  // no jobId; Promise resolves when job is actually finished

// status / pause / stop removed; use unload() for teardown
await addon.unload()
```

### API Changes

**Addon (LlamaInterface):**

- **`runJob(messages)`** — Runs one inference job. `messages` is an array of `{ type: 'media', content: Uint8Array }` and/or `{ type: 'text', input: string }` (e.g. JSON-stringified chat messages). No return value (no job ID).
- **`cancel()`** — Cancels the current job. No arguments. Returns a Promise that resolves when the job has finished (async cancel backed by futures in C++).
- **Constructor** — `(binding, configurationParams, outputCb)` only; `transitionCb` removed.
- **Removed:** `append`, `pause`, `stop`, `status`, `destroyInstance`. Use `unload()` for cleanup.

**Usage from LlmLlamacpp (unchanged for callers):**

- `model.run(prompt)` still returns a `QvacResponse`.
- `response.cancel()` still takes no arguments; the only change is that **`await response.cancel()`** now waits until the underlying job has actually stopped.

```typescript
// New API usage: single job per run, cancel waits for completion
await model.run(prompt)
// … optionally cancel and wait until job is really finished
await model.cancel()
```

## [0.8.9] - 2026-02-11
This release updates the qvac-fabric-llm.cpp vcpkg dependency from v7248.1.1 to v7248.1.2. This brings the fix for apple A19 devices when loading models using Metal backend.

## [0.8.8] - 2026-02-05
This release updates the underlying llama.cpp native library to v7248.1.2, bringing upstream improvements and fixes.

## Breaking Changes

There are no breaking changes in this release.

## New APIs

There are no new public APIs in this release.

## Other

### Native Library Update

Updated the llama-cpp vcpkg dependency from v7248.1.1 to v7248.1.2. This brings the latest upstream llama.cpp improvements, optimizations, and bug fixes to the LLM inference addon.

## [0.8.7] - 2026-02-01
This release fixes a critical crash that occurred when processing large embedding outputs, such as high-dimensional embeddings or large batch sizes.

## Breaking Changes

There are no breaking changes in this release.

## New APIs

There are no new public APIs in this release.

## Bug Fixes

### Large Embedding Output Crash Resolved

Fixed a `RangeError: Invalid string length` crash that occurred when processing large embedding datasets. The issue manifested when running inference on many sequences (e.g., 39,024 sequences from a 10MB text file with 256-character chunks and batch size of 512).

The root cause was in the base inference class, where debug logging attempted to `JSON.stringify` the entire embedding output data. JavaScript strings have a maximum length limit (~2^30-1 characters), which large embedding arrays can exceed.

This is fixed by updating the `@qvac/infer-base` dependency to v0.2.2, which removes the problematic debug logging while preserving all functional behavior. The `response.updateOutput(data)` call continues to work correctly—only the debug log that caused crashes was removed.

## [0.8.6] - 2026-02-01
This release fixes a library conflict issue affecting certain Linux systems and improves documentation with comprehensive platform support tables and build requirements.

## Breaking Changes

There are no breaking changes in this release.

## New APIs

There are no new public APIs in this release.

## Bug Fixes

### System-Wide Library Conflicts Resolved

Fixed a critical issue where the addon could crash on systems with globally-installed llama.cpp libraries. The runtime's `dlopen()` calls were resolving `libggml-*.so` to system-wide installations (e.g., `/usr/lib/libggml-vulkan.so`) instead of the SDK's bundled backends, causing version mismatches and crashes like:

```
/usr/lib/libggml-base.so.0: GGML_ASSERT(prev != ggml_uncaught_exception) failed
```

This is fixed by updating the inference engine (qvac-fabric-llm.cpp 7248.1.0 → 7248.1.1) which introduces two changes:

1. **Namespaced backend libraries**: Backend libraries are now prefixed with `qvac-` (e.g., `libqvac-ggml-vulkan.so`), ensuring the runtime never accidentally loads incompatible system libraries.

2. **Eliminated unnecessary `dlopen()` calls**: On platforms using statically-linked backends (Linux, macOS, iOS, Windows), `dlopen()` is now skipped entirely, removing any risk of loading external libraries.

| Platform | Dynamic Backends | Behavior |
|----------|------------------|----------|
| Android | ON | Searches for `libqvac-ggml-*.so` (isolated from system) |
| Linux/macOS/iOS/Windows | OFF | No `dlopen()` - uses statically linked backends |

## [0.8.5] - 2026-02-01
This release fixes Android build support by ensuring Vulkan SDK is properly configured in the Android builder.

## Breaking Changes

There are no breaking changes in this release.

## New APIs

There are no new public APIs in this release.

## Features

### Android Build Improvements

Android prebuild workflows now properly install and configure the Vulkan SDK on the builder. The Vulkan SDK is installed on the host, the same way as in Linux x64 builds. This change ensures that Android builds have access to the necessary Vulkan tools and libraries required for building the qvac-fabric dependency.

### Build Workflow Consistency

The build workflow conditions have been updated to use more consistent checks across Ubuntu-based builds. The Vulkan installation and configuration steps now use `startsWith(matrix.os, 'ubuntu-')` conditions instead of platform-specific checks, making the workflow more maintainable and consistent.

## Bug Fixes

There are no user-facing bug fixes in this release.

## [0.8.4] - 2026-02-01
This release improves compatibility for Linux ARM64 users by building prebuilt binaries on Ubuntu 22.04 instead of Ubuntu 24.04. This results in binaries linked against an older glibc version, enabling the addon to run on a wider range of Linux ARM64 systems.

## Improved Linux ARM64 Compatibility

Linux ARM64 prebuilt binaries are now built on Ubuntu 22.04 runners instead of Ubuntu 24.04. This change produces binaries with lower glibc requirements, making them compatible with more Linux distributions and older system versions. Users on Linux ARM64 systems that previously encountered glibc version errors should now be able to use the prebuilt binaries without issues.

## Internal Changes

- Added Ubuntu 22.04 ARM to the integration test matrix for broader CI coverage
- Removed obsolete cross-compilation tooling

## [0.8.3] - 2026-02-01
This release improves addon compatibility by switching Linux x64 builds to Ubuntu 22.04. The change add support for the current oldest Ubuntu LTS version (Ubuntu-22.04), while maintaining support for Ubuntu-24.04.

## Breaking Changes

There are no breaking changes in this release.

## New APIs

There are no new public APIs in this release.

## Features

### Build System Improvements

Linux x64 prebuilds are now built on Ubuntu 22.04 instead of Ubuntu 24.04, providing compatibility with the current oldest Ubuntu LTS release. The build workflow has been updated to install g++-13 on Ubuntu 22.04, providing support for modern C++ features while linking against the Ubuntu-22 glibc version. Integration tests now run on both Ubuntu 22.04 and 24.04 to ensure compatibility across both versions.

### Workflow Simplification

The CI/CD workflows have been simplified with more generic condition checks that work across all Ubuntu versions. This makes the workflows easier to maintain and reduces the need for version-specific conditionals. The ccache configuration has also been simplified for better reliability.

## Bug Fixes

There are no user-facing bug fixes in this release.

## [0.8.2] - 2026-02-01
This release focuses on improving distribution quality for prebuilt artifacts without changing the public API surface. Prebuilds are now leaner, which reduces download size and speeds up installation for supported platforms.

## Breaking Changes
There are no breaking changes in this release.

## New APIs
There are no new public APIs in this release.

## Features
The prebuild workflow now removes debug symbols by applying platform-specific stripping tools, using the Android NDK’s `llvm-strip` on Android, `strip -S` on Apple platforms, and `strip --strip-debug` on Linux, which reduces package size and improves download times while keeping runtime behavior unchanged.

## Bug Fixes
There are no user-facing bug fixes in this release.

## [0.8.1] - 2025-01-15
### Changed
- Cleaned up package.json by removing unused packages and scripts

## [0.8.0] - 2025-01-15
### Changed 
- Upgraded llm fabric to 7248.1.0, which containes new Vulkan implementation improvements (VMA, shaders).

## [0.7.1] - 2025-01-14
### Added
- Missing model config params to `LlamaConfig` TypeScript interface and README

## [0.7.0] - 2025-01-12
### Added
- Linux ARM 64 platform support - added ubuntu-24.04-arm build target to prebuild and integration test workflows
- TypeScript type declarations for `addonLogging` subpath export (`addonLogging.d.ts`)
- Conditional `types` exports in `package.json` for both main and `./addonLogging` entries
- `modelPath` and `modelConfig` properties to `LlmLlamacppArgs` interface
- `'session'` role to `UserTextMessage.role` union type
- Re-export of `ReportProgressCallback` and `QvacResponse` types from `@qvac/infer-base`

### Changed
- Updated `tsconfig.dts.json` to validate both `index.d.ts` and `addonLogging.d.ts`

## [0.6.0] - 2025-01-07
### Added
- TypeScript type declarations (`index.d.ts`) - migrated from `@qvac/sdk` and aligned with runtime API
- CI job for type declaration validation (`ts-checks`)
- `test:dts` script for type checking

## [0.5.10] - 2025-01-05
### Changed
- Enforce cache usage only when explicitly specified in prompt. Prompts without session messages now perform single-shot inference with cleared context.
- Add context-size validation: allow using same cache with different configs if cache tokens <= ctx_size, error only if cache tokens exceed ctx_size.

### Added
- Add `getTokens` session command to query cache token count without performing inference or cache operations.

## [0.5.9] - 2025-12-19
### Changed
- Upgrade llm fabric to 7248

## [0.5.8] - 2025-12-16
- Fix memory leak on unique pointer custom deleter

## [0.5.7] - 2025-12-2
### CHANGED
- llama-cpp repository was renamed, so new port version is required to update hash.
- Also updated dl-filesystem dependency version for 16kb pages support.

## [0.5.6] - 2025-11-28
### CHANGED
- Disabled dynamic backends for Linux.

## [0.5.5] - 2025-11-28
### CHANGED
- update llama.cpp  to 7028.0.1  to add support for Qwen3 VL

## [0.5.4] - 2025-11-27
### Changed
- change runner to build linux and android package from Ubuntu 22 to Ubuntu24
- using ANDROID_NDK_LATEST_HOME=29.0.14206865

## [0.5.3]
### Fixed
- Fix premature EOS during Qwen3 reasoning tag generation by replacing EOS with closing tag and injecting newlines

## [0.5.2] - 2025-11-26
### Added
- Add "./addonLogging": "./addonLogging.js" for Node.js extensionless imports
- Add "./addonLogging.js": "./addonLogging.js" for Bare runtime (auto-appends .js)

## [0.5.1] - 2025-11-25
### Added 
IGPU/GPU backend selection logic:

| Scenario                       | main-gpu not specified                | main-gpu: `"dedicated"`             | main-gpu: `"integrated"`           |
|---------------------------------|---------------------------------------|-------------------------------------|-------------------------------------|
| Devices considered              | All GPUs (dedicated + integrated)     | Only dedicated GPUs                 | Only integrated GPUs                |
| System with iGPU only           | ✅ Uses iGPU                          | ❌ Falls back to CPU                | ✅ Uses iGPU                        |
| System with dedicated GPU only  | ✅ Uses dedicated GPU                 | ✅ Uses dedicated GPU               | ❌ Falls back to CPU                |
| System with both                | ✅ Uses dedicated GPU (preferred)     | ✅ Uses dedicated GPU               | ✅ Uses integrated GPU              |


## [0.5.0] - 2025-11-21
### Changed
Enable dynamic backends for Linux instead of static backends.

## [0.4.5] - 2025-11-18

### Changed
- bump llama.cpp portfile version to 6469.1.2#1

## [0.4.4] - 2025-11-17

### Added
- Add generatedTokens and promptTokens to output stats.
```
Inference stats: {"TTFT":103.458,"TPS":58.520540923442745,"CacheTokens":0,"generatedTokens":411,"promptTokens":53}
```

## [0.4.3] - 2025-11-13
### Changed
- using QvacResponse imported from @qvac/infer-base

## [0.4.2] - 2025-11-12

### Fixed
- fix Qwen3 chat template

## [0.4.1] - 2025-11-11

### Fixed
- fix different backends from  Vulkan not loaded.

## [0.4.0] - 2025-11-10

### Added
- Enable dynamic backends for Android,  solving the issue related to device crashing when OpenCL not supported. 
- Improve back-end selection logic (automatic fallback to CPU)

### Breaking:  
 - bare-runtime=^1.24.1, react-native-bare-kit=^0.10.4, bare-link=1.5.0 are required.

---

## How to Update This Changelog

When releasing a new version:

1. Move items from `[Unreleased]` to a new version section
2. Add the version number and date: `## [X.Y.Z] - YYYY-MM-DD`
3. Keep the `[Unreleased]` section at the top for ongoing changes
4. Group changes by category: Added, Changed, Deprecated, Removed, Fixed, Security, Breaking

### Categories

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** in case of vulnerabilities
