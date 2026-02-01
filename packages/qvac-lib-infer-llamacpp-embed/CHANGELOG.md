# Changelog

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
