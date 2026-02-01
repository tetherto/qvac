# Changelog

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
