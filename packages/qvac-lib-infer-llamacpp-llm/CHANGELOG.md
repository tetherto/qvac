# Changelog

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
