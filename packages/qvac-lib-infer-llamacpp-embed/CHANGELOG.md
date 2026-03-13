# Changelog

## [0.12.0] - 2026-03-13

### Changed

- Updated qvac-fabric dependency from 7248.1.3 to 7248.1.4.

## [0.11.3] - 2026-03-06

### Fixed

- The `GGMLConfig` type now exposes `embd_normalize` instead of `embed_normalize` in `index.d.ts`. This fixes a mismatch where TypeScript users could be guided toward an incorrect property name, reducing configuration mistakes and autocomplete friction.

## [0.11.2] - 2026-03-03

### Fixed

- **Deterministic busy detection:** Replaced the timing-based `_lastJobResult` + 30ms timeout with a synchronous `_hasActiveResponse` boolean flag. On fast hardware (iPhone Metal GPU), short embedding jobs could complete in under 30ms, causing the timeout-based race to be won by the resolved promise instead of the busy guard — allowing a second `run()` through. The flag is now checked synchronously inside `_withExclusiveRun` before any `await`, and cleared via a chained `response.await()` promise so ordering is structurally explicit.
- **Concurrency test made deterministic:** The `run | run` concurrency test now uses `Promise.race` to handle the case where the first job finishes before the second `run()` is rejected, preventing flaky failures on fast hardware.

## [0.11.1] - 2026-02-23
- Use patched version of addon-cpp to reduce logging noise.

## [0.11.0] - 2026-02-18

- Use new addon-cpp architecture for simplified Js Addon creation and usage.
- Use AddonCpp on test executable (to mimick JsAddon behavior/usage).
- Add inference stopping feature

---

### Breaking Changes

**BertInterface / Addon (native addon surface):**

- **Constructor:** The 4th argument `transitionCb` (state-change callback) was removed. The addon no longer reports LISTENING / IDLE / STOPPED etc.
- **Removed methods:** `pause()`, `stop()`, `status()`, **`destroyInstance()`** — single-job addon no longer exposes queue/state or pause/stop. Use **`unload()`** instead of `destroyInstance()` to release the addon and clear resources.
- **`runJob(input)`:** Input remains a single object `{ type: 'text' | 'sequences', input }` (one string or array of sequences). **No longer returns a job ID** (only one job per instance); it now returns a boolean accepted flag (false when busy).
- **`cancel(jobId?)` → `cancel()`:** No `jobId` argument (only one job). **Behavior:** `await addon.cancel()` (and thus `await response.cancel()`) now **waits until the job is actually finished** (future-based cancel in C++); previously `await` did not guarantee the job had stopped.

**GGMLBert usage:**

- **Single job per run:** Each `run(text)` sends one `runJob(input)` and uses a fixed job id `'job'`. Queueing multiple jobs or using multiple job IDs is no longer supported.
- **Full input in one call:** The full input (single string or array of sequences) is sent in one `runJob()` call.

#### BEFORE

```typescript
// Old: constructor with state callback
const addon = new BertInterface(binding, config, outputCb, (state) => logger.info(state))

// Old: runJob returned job ID; cancel by job ID
const jobId = await addon.runJob({ type: 'text', input: singleString })
// or
const jobId = await addon.runJob({ type: 'sequences', input: stringArray })
// ...
await addon.cancel(jobId)  // jobId optional; await did NOT guarantee job finished

// Old: state and control
await addon.status()
await addon.pause()
await addon.stop()
```

#### AFTER

```typescript
// New: no state callback
const addon = new BertInterface(binding, config, outputCb)

// New: single run with one input object; returns boolean accepted (no job ID); cancel with no args and proper completion
const accepted = await addon.runJob({ type: 'text', input: singleString })
if (!accepted) throw new Error('Addon busy')
// or
const acceptedSeq = await addon.runJob({ type: 'sequences', input: stringArray })
if (!acceptedSeq) throw new Error('Addon busy')
// ...
await addon.cancel()  // no jobId; Promise resolves when job is actually finished

// status / pause / stop removed
```

### API Changes

**Addon (BertInterface):**

- **`runJob(input)`** — Runs one embedding job. `input` is `{ type: 'text', input: string }` or `{ type: 'sequences', input: string[] }`. Returns Promise<boolean> (true if accepted, false if busy). No job ID is returned.
- **`cancel()`** — Cancels the current job. No arguments. Returns a Promise that resolves when the job has finished (async cancel backed by futures in C++).
- **Constructor** — `(binding, configurationParams, outputCb)` only; `transitionCb` removed.
- **Removed:** `pause`, `stop`, `status`, **`destroyInstance`** (use `unload()` only).

**Usage from GGMLBert (unchanged for callers):**

- `model.run(text)` still returns a `QvacResponse` (single string or array of sequences).
- `response.cancel()` still takes no arguments; the only change is that **`await response.cancel()`** now waits until the underlying job has actually stopped.

```typescript
// New API usage: single job per run, cancel waits for completion
await model.run(text)  // text: string | string[]
// … optionally cancel and wait until job is really finished
await model.cancel()
```

## [0.10.7] - 2026-02-11
This release updates the qvac-fabric-llm.cpp vcpkg dependency from v7248.1.1 to v7248.1.2. This brings the fix for apple A19 devices when loading models using Metal backend.

## [0.10.6] - 2026-02-05
This release updates the underlying llama.cpp native library to v7248.1.2, bringing upstream improvements and fixes.

## Breaking Changes

There are no breaking changes in this release.

## New APIs

There are no new public APIs in this release.

## Other

### Native Library Update

Updated the llama-cpp vcpkg dependency from v7248.1.1 to v7248.1.2. This brings the latest upstream llama.cpp improvements, optimizations, and bug fixes to the embeddings inference addon.

## [0.10.5] - 2026-02-01
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

## [0.10.4] - 2026-02-01
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

## [0.10.3] - 2026-02-01
This release expands platform support by providing prebuilt binaries for Ubuntu 22.04 on ARM64 systems. Users on older ARM64 Linux distributions can now install the addon without compiling from source.

## Breaking Changes

There are no breaking changes in this release.

## New APIs

There are no new public APIs in this release.

## Features

### Ubuntu 22.04 ARM64 prebuilt binaries

Linux ARM64 prebuilds now target Ubuntu 22.04 instead of Ubuntu 24.04. This broadens compatibility for users running ARM64 servers or devices on the more widely deployed Ubuntu 22.04 LTS release. The prebuilt binaries will work on Ubuntu 22.04 and newer, whereas previously ARM64 users on 22.04 would need to build from source due to glibc version requirements.

## Bug Fixes

There are no user-facing bug fixes in this release.

## [0.10.2] - 2026-02-01
This release focuses on improving distribution quality for prebuilt artifacts without changing the public API surface. Prebuilds are now leaner, which reduces download size and speeds up installation for supported platforms.

## Breaking Changes
There are no breaking changes in this release.

## New APIs
There are no new public APIs in this release.

## Features
The prebuild workflow now removes debug symbols by applying platform-specific stripping tools, using the Android NDK’s `llvm-strip` on Android, `strip -S` on Apple platforms, and `strip --strip-debug` on Linux, which reduces package size and improves download times while keeping runtime behavior unchanged.

## Bug Fixes
There are no user-facing bug fixes in this release.

## [0.10.1] - 2026-02-01
This release improves Linux compatibility by ensuring the addon builds and runs on Ubuntu 22.04 LTS, the oldest currently supported LTS version. This change ensures broader compatibility with older Linux distributions while maintaining support for newer versions.

## Compatibility Improvements

### Enhanced Linux LTS Support

The Linux x64 prebuilds are now built on Ubuntu 22.04 LTS instead of Ubuntu 24.04, ensuring compatibility with the oldest currently supported LTS version. This means the addon will work reliably on systems running Ubuntu 22.04 and later, providing better support for users on older but still-supported Linux distributions. The build process has been updated to install the necessary compiler toolchain (g++-13) on Ubuntu 22.04 to meet build requirements, and integration tests now verify compatibility on both Ubuntu 22.04 and 24.04 to ensure the addon works correctly across the supported LTS range.

## [0.10.0] - 2025-01-15
### Changed 
- Upgraded llm fabric to 7248.1.0, which containes new Vulkan implementation improvements (VMA, shaders).

## [0.9.3] - 2025-01-14
### Changed
- Cleaned up package.json by removing unused packages and scripts

## [0.9.2] - 2026-01-12
### Added
- TypeScript type declarations for `addonLogging` subpath export (`addonLogging.d.ts`)
- Conditional `types` exports in `package.json` for both main and `./addonLogging` entries
- `modelPath` property to `EmbedLlamacppArgs` interface
- Re-export of `ReportProgressCallback` and `QvacResponse` types from `@qvac/infer-base`

### Changed
- Updated `tsconfig.dts.json` to validate both `index.d.ts` and `addonLogging.d.ts`

## [0.9.1] - 2025-01-12
### Changed
- remove unnecessary package dependency from package.json

## [0.9.0] - 2025-01-08
### Added
- Linux ARM 64 platform support - added ubuntu-24.04-arm build target to prebuild and integration test workflows

## [0.8.0] - 2025-01-07
### Added
- TypeScript type declarations (`index.d.ts`) - migrated from `@qvac/sdk` and aligned with runtime API
- CI job for type declaration validation (`ts-checks`)
- `test:dts` script for type checking

## [0.7.7] - 2025-12-19
### Changed
- Upgrade llm fabric to 7248

## [0.7.6] - 2025-12-2
### Changed
- This PR is for updating the llama-cpp port after the repository name change.

## [0.7.5] - 2025-11-28
### Changed
- updated llama.cpp port to 7028.0.1#0

## [0.7.4] - 2025-11-27
### Changed
- support 16KB pages in android with NDK = 29

## [0.7.3] - 2025-11-26
### Added
- Add "./addonLogging": "./addonLogging.js" for Node.js extensionless imports
- Add "./addonLogging.js": "./addonLogging.js" for Bare runtime (auto-appends .js)


## [0.7.2] - 2025-11-25
### Added
- export addonLogging.js in package.json. 
- Added verbosity parameter from 0 (error)  to 3 (debug). Default is 0.
```
config = '-ngl\t25\n--batch_size\t1024\nverbosity\t3' 
```

## [0.7.1] - 2025-11-25
### Added 
IGPU/GPU backend selection logic:

| Scenario                       | main-gpu not specified                | main-gpu: `"dedicated"`             | main-gpu: `"integrated"`           |
|---------------------------------|---------------------------------------|-------------------------------------|-------------------------------------|
| Devices considered              | All GPUs (dedicated + integrated)     | Only dedicated GPUs                 | Only integrated GPUs                |
| System with iGPU only           | ✅ Uses iGPU                          | ❌ Falls back to CPU                | ✅ Uses iGPU                        |
| System with dedicated GPU only  | ✅ Uses dedicated GPU                 | ✅ Uses dedicated GPU               | ❌ Falls back to CPU                |
| System with both                | ✅ Uses dedicated GPU (preferred)     | ✅ Uses dedicated GPU               | ✅ Uses integrated GPU              |


## [0.7.0] - 2025-11-21
### Changed
Enable dynamic backends for Linux instead of static backends.

## [0.6.2] - 2025-11-18
### Changed
- bump llama.cpp portfile version to 6469.1.2#1

## [0.6.1] - 2025-11-14
### Changed
- using QvacResponse imported from @qvac/infer-base

## [0.6.0] - 2025-11-11

### Added
- Enable dynamic backends for Android,  solving the issue related to device crashing when OpenCL not supported. 
- Improve back-end selection logic (automatic fallback to CPU)

### Breaking:  
 - bare-runtime=^1.24.1, react-native-bare-kit=^0.10.4, bare-link=1.5.0 are required.



## [0.5.0] - 2025-11-6

### Added
- Support for passing an **array of sequences** as input to `model.run()` along with text input.  
  You can now pass `query = ["text1", "text2", ...]` to generate batched embeddings in a single call.  
  Returns a `1×n` embedding matrix when an array of `n` sequences is provided.

### Changed
- **Input handling**: Model now accepts `std::variant<std::string, std::vector<std::string>>` instead of just `std::string`.  
  Internal processing uses `std::visit` to handle both single strings and sequence arrays uniformly.
- **Batching behavior**:  
  - A single input string (even with newlines) is now treated as **one sequence** and produces **one embedding**.  
  - Multiple embeddings are only returned when an **array** is explicitly passed.
- **Context size**:  
  - Fixed context length is now enforced using the model's trained context size (default: 512 tokens).  
  - Custom context sizes are **no longer supported**.  
  - Pass `batch_size` directly as a parameter instead of relying on context configuration.
- **Batch size**: 
  - Typically `1024` tokens (configurable via `--batch_size\t1024` in config string).
  - Sequences from array inputs are accumulated token-by-token until total tokens reach `batch_size`, then processed together in one forward pass. Larger values = more sequences per batch (better throughput, more memory); smaller values = fewer sequences per batch (less memory, more passes).
- **JavaScript API**:  
  - `run()` now detects array inputs and sends them with `type: 'sequences'`. Text input is sent with `type: 'text'`.

### Removed
- Removed automatic splitting by delimiters (e.g., `\n`). 

### Fixed
- **Batch decoding crash when `n_parallel = 1`**  
  Previously, setting `n_parallel = 1` caused `n_seq_max = 1`, triggering "Sequence Id does not exist" in `llama_batch_init`.  
  Now fixed by forcing `kv_unified = true` when `n_parallel == 1`, allowing up to 64 sequences in a batch.  

### Security
- **Context overflow protection**:  
  An error is now thrown if any input sequence exceeds 512 tokens:  
  - Single string > 512 tokens → error  
  - Any string in input array > 512 tokens → error
- **Batch overflow**: Any input sequence > `batch_size` → error (even if ≤ 512)  
- Both checks run independently for robust validation.
 

---

## How to Update This Changelog

When releasing a new version:

1. Move items from `[Unreleased]` to a new version section
2. Add the version number and date: `## [X.Y.Z] - YYYY-MM-DD`
3. Keep the `[Unreleased]` section at the top for ongoing changes
4. Group changes by category: Added, Changed, Deprecated, Removed, Fixed, Security

### Categories

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** in case of vulnerabilities
