# vcpkg Management — Domain Knowledge

Reference for addon specialist sub-agents. Read this before debugging build failures, bumping dependencies, or working on native addon packages.

## Architecture

### Build Pipeline

```
npm install -> bare-make generate -> bare-make build -> bare-make install
                  |
                  v
          cmake-vcpkg (npm package)
                  |
                  v
          CMake toolchain file
                  |
                  v
          vcpkg manifest mode (vcpkg.json)
                  |
                  v
     Resolve deps from registries + overlay ports
                  |
                  v
     Build into build/_vcpkg/<triplet>/
```

The `cmake-vcpkg` npm package (version `^1.1.0` for most packages, `^1.0.2` for older ONNX packages) bridges `bare-make` -> CMake -> vcpkg. It provides:
- CMake toolchain integration via `find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)`
- 15 standard triplet files in `node_modules/cmake-vcpkg/triplets/`
- Automatic `VCPKG_ROOT` detection

### VCPKG_ROOT Requirement

`VCPKG_ROOT` must point to a vcpkg installation:
- **Linux CI (ubuntu-24.04)**: `VCPKG_ROOT=$VCPKG_INSTALLATION_ROOT` (pre-installed on runner)
- **macOS CI**: Clones `microsoft/vcpkg` branch `2025.12.12`, bootstraps, sets `VCPKG_ROOT`
- **Windows CI**: `VCPKG_ROOT=$env:VCPKG_INSTALLATION_ROOT` (pre-installed on runner)
- **Local dev**: Must have vcpkg installed and `VCPKG_ROOT` set in environment

### Per-Package Isolated Installs

Each package gets its own vcpkg install tree at `build/_vcpkg/<triplet>/`. This avoids cross-package contamination and allows different packages to use different baseline versions.

## Registry Setup — Dual Registry Model

Every addon package uses two registries configured in `vcpkg-configuration.json`:

### 1. Private Registry (default)

```json
{
  "default-registry": {
    "kind": "git",
    "baseline": "<commit-sha>",
    "repository": "https://github.com/tetherto/qvac-registry-vcpkg.git"
  }
}
```

Hosts QVAC-specific packages: `qvac-fabric`, `qvac-lib-inference-addon-cpp`, `qvac-lint-cpp`, `onnxruntime`, `whisper-cpp`, `tokenizers-cpp`, `bergamot-translator`, `sentencepiece`, `ssplit`, and others.

**Authentication**: Requires `GH_TOKEN` (GitHub PAT) with read access to `tetherto/qvac-registry-vcpkg`. In CI, git credentials are configured automatically. Locally, HTTPS access works with token-based auth or credential helpers.

### 2. Microsoft Upstream Registry

```json
{
  "registries": [
    {
      "kind": "git",
      "baseline": "<commit-sha>",
      "repository": "https://github.com/microsoft/vcpkg",
      "packages": ["gtest", "picojson", "opencv4", ...]
    }
  ]
}
```

Provides standard open-source deps. Only packages explicitly listed in the `packages` array resolve from this registry — everything else falls through to the default (private) registry.

**Common baselines**:
- `16c71a39e5a0fc0bdb3fad03beef8f38ee00ee3b` — used by LLM, Embed, NMT, Whisper
- `8c901fe2b0e69a542d02810d4089505fd0c480d8` — used by ONNX, OCR, TTS, Parakeet
- `f26ec398c25c4980f33a50391f00a75f7ad62ef7` — used by inference-addon-cpp base

### Baseline Pinning

Each package pins its own baseline commits independently. This means different addon packages can use different versions of the same vcpkg port. When bumping a dependency, you must update the baseline in the specific package's `vcpkg-configuration.json`.

## Dependency Declaration — vcpkg.json

### Basic Structure

```json
{
  "dependencies": [
    "simple-dep",
    {
      "name": "versioned-dep",
      "version>=": "1.1.2"
    },
    {
      "name": "platform-dep",
      "platform": "android"
    },
    {
      "name": "host-tool",
      "host": true
    }
  ],
  "features": {
    "tests": {
      "description": "Build tests",
      "dependencies": ["gtest"]
    }
  },
  "overrides": [
    {
      "name": "flatbuffers",
      "version": "23.5.26"
    }
  ]
}
```

### Platform-Conditional Dependencies

Used extensively for hardware acceleration:

```json
{ "name": "onnxruntime", "features": ["nnapi-ep"], "platform": "android" },
{ "name": "onnxruntime", "features": ["dml-ep"], "platform": "windows" },
{ "name": "onnxruntime", "features": ["coreml-ep"], "platform": "osx | ios" },
{ "name": "onnxruntime", "platform": "!(android | osx | ios | windows)" },
{ "name": "opencl", "platform": "android" }
```

### Features

Features are opt-in dependency groups activated via CMake:

```cmake
if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()
if(VK_PROFILING)
  list(APPEND VCPKG_MANIFEST_FEATURES "vk-profiling")
endif()
```

Common features across packages:
- **`tests`** — adds `gtest` dependency (all packages)
- **`vk-profiling`** — force Vulkan performance logging (LLM, Embed)
- **`xnnpack`** — XNNPack execution provider (OCR, ONNX)
- **`vulkan`** — Vulkan GPU acceleration (Whisper)
- **`gpu`** — CUDA support (Parakeet)

### Version Overrides

The `overrides` array forces specific versions regardless of what registries resolve:

```json
"overrides": [
  { "name": "flatbuffers", "version": "23.5.26" }
]
```

The `flatbuffers` 23.5.26 override appears in most ONNX-based packages — this is critical for ONNX Runtime compatibility. Do not remove it.

### Port-Version Syntax

Port versions use `#N` suffix: `"version>=": "0.1.1#2"` means version 0.1.1, port-version 2. This is used when a port's build recipe changes without the upstream version changing.

## Triplets

### Standard Triplets (from cmake-vcpkg)

The `cmake-vcpkg` npm package provides 15 standard triplets:

| Triplet | Platform |
|---------|----------|
| `arm-android` | Android ARM32 |
| `arm64-android` | Android ARM64 |
| `x64-android` | Android x64 |
| `arm-linux` | Linux ARM32 |
| `arm64-linux` | Linux ARM64 |
| `ia32-linux` | Linux x86 |
| `x64-linux` | Linux x64 |
| `arm64-ios` | iOS ARM64 |
| `arm64-ios-simulator` | iOS Simulator ARM64 |
| `x64-ios-simulator` | iOS Simulator x64 |
| `arm64-osx` | macOS ARM64 |
| `x64-osx` | macOS x64 |
| `arm64-windows` | Windows ARM64 |
| `x64-windows` | Windows x64 |

### Custom Override Triplets

Packages can override standard triplets for specific build requirements. Override triplets are prepended to the triplet search path in CMake:

```cmake
set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")
```

#### LLM / Embed — Clang-19 Toolchain

Location: `packages/qvac-lib-infer-llamacpp-llm/vcpkg/triplets/`

Custom `x64-linux.cmake` and `arm64-linux.cmake` that enforce:
- clang-19 compiler via custom toolchain file
- Static linking (`VCPKG_LIBRARY_LINKAGE static`)
- libc++ stdlib (`-stdlib=libc++`)
- Position-independent code (`-fPIC`)

```cmake
set(VCPKG_TARGET_ARCHITECTURE x64)  # or arm64
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../toolchains/linux-clang.cmake")
set(VCPKG_C_FLAGS "-fPIC")
set(VCPKG_CXX_FLAGS "-fPIC -stdlib=libc++")
set(VCPKG_LINKER_FLAGS "-stdlib=libc++")
```

#### ONNX Packages — Release-Only Triplets

Location: `packages/ocr-onnx/vcpkg-override-triplets/triplets/` (and similar for TTS, Parakeet)

Custom triplets for ONNX-based packages that set `VCPKG_BUILD_TYPE release` to halve build time and disk usage:

```cmake
set(VCPKG_BUILD_TYPE release)
set(VCPKG_LIBRARY_LINKAGE static)
```

Platform-specific triplets also set deployment targets (e.g., iOS 13.3) and architecture details.

## Overlay Ports

Overlay ports let a package override a registry port with a local version. They are declared in `vcpkg-configuration.json`:

```json
{
  "overlay-ports": ["vcpkg/ports"]
}
```

### qvac-fabric Local Dev Pattern (LLM / Embed)

Location: `packages/qvac-lib-infer-llamacpp-llm/vcpkg/ports/qvac-fabric/`

When developing against a local build of `qvac-fabric` (the llama.cpp fork):
1. The overlay port's `portfile.cmake` points to a local source directory (e.g., `/home/olya/claude_folders/addons_folders/fabric/qvac-fabric-llm.cpp`)
2. It configures platform-specific GGML backends (Metal for macOS/iOS, Vulkan for Linux/Android)
3. The overlay takes precedence over the published version in the private registry

**To switch between local and published fabric:**
- **Local dev**: Keep the overlay port directory, ensure the source path is correct
- **Published version**: Remove or rename the overlay port directory, the registry version will be used

### NMT Overlay Ports (7 ports)

Location: `packages/qvac-lib-infer-nmtcpp/vcpkg-overlays/`

NMT has the most overlay ports of any package, each building a specific fork or patched version:

| Port | Purpose |
|------|---------|
| `bergamot-translator` | Translation model runtime |
| `marian-dev` | Neural MT framework |
| `intgemm` | Integer matrix multiplication |
| `ruy` | Matrix multiplication library |
| `simd-utils` | SIMD utilities |
| `ssplit` | Sentence splitting |
| `whisper-cpp` | Speech recognition (v1.7.6 fork) |

These are referenced in `vcpkg-configuration.json`:
```json
"overlay-ports": [
  "./vcpkg-overlays/whisper-cpp",
  "./vcpkg-overlays/ruy",
  "./vcpkg-overlays/intgemm/",
  "./vcpkg-overlays/simd-utils/",
  "./vcpkg-overlays/marian-dev/",
  "./vcpkg-overlays/ssplit",
  "./vcpkg-overlays/bergamot-translator/"
]
```

## Key vcpkg Packages

### qvac-fabric

The llama.cpp fork maintained in `qvac-registry-vcpkg`. This is the core LLM inference engine.

- Used by: LLM, Embed
- Features: `force-profiler` (Vulkan performance logging)
- Platform-specific backends: Metal (macOS/iOS), Vulkan (Linux/Android), CPU fallback
- Current version: `7248.1.2+` (version tracks llama.cpp upstream commits)

### qvac-lib-inference-addon-cpp

Shared C++ addon framework providing the JS<->C++ binding interface (`JsInterface.hpp`).

- Used by: all addon packages
- Current version: `1.1.2`
- Provides: `find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/JsInterface.hpp")`

### qvac-lint-cpp

Shared C++ linting configuration (`.clang-format`, `.clang-tidy`).

- Used by: all addon packages
- Current version: `1.4.4`
- Provides: `find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)`

### onnxruntime

ONNX Runtime with platform-conditional execution providers.

- Used by: OCR, ONNX, TTS, Parakeet
- Platform features: `nnapi-ep` (Android), `dml-ep` (Windows), `coreml-ep` (macOS/iOS), `xnnpack-ep` (CPU optimization), `cuda` (GPU)
- Requires `flatbuffers` 23.5.26 override

### whisper-cpp

Whisper speech recognition.

- Used by: Whisper (direct), NMT (overlay port with custom fork)
- Features: `vulkan` (GPU acceleration)
- Whisper package overrides to version `1.7.5.1`

## CI Caching

### GitHub Actions Files Backend

Used for most CI jobs:

```yaml
env:
  VCPKG_BINARY_SOURCES: "clear;files,${{ github.workspace }}/${{ inputs.workdir }}/vcpkg/cache,readwrite"
```

This stores compiled vcpkg packages as files in a local directory, which is then cached using `actions/cache`:

```yaml
- uses: actions/cache@668228422ae6a00e4ad889ee87cd7109ec5666a7 # 5.0.4
  with:
    path: ${{ env.WORKDIR }}/vcpkg/cache
    key: vcpkg-<platform>-<arch>-${{ hashFiles('vcpkg.json', 'vcpkg-configuration.json') }}
    restore-keys: vcpkg-<platform>-<arch>-
```

### Cache Key Design

Cache keys include:
- Platform and architecture (e.g., `linux-x64`, `darwin-arm64`)
- Hash of `vcpkg.json` and `vcpkg-configuration.json`
- Partial restore keys allow incremental cache reuse

### When Caches Invalidate

- Any change to `vcpkg.json` (new dep, version bump, feature change)
- Any change to `vcpkg-configuration.json` (baseline bump, new registry package)
- Runner image updates that change pre-installed vcpkg version
- Manual cache clearing via GitHub Actions UI

## Environment Variables

| Variable | Purpose | Where Set |
|----------|---------|-----------|
| `VCPKG_ROOT` | Path to vcpkg installation | CI runner env / local `.bashrc` |
| `VCPKG_BINARY_SOURCES` | Binary caching backend config | CI workflow env |
| `VCPKG_BUILD_TYPE` | `release` to skip debug builds | Custom triplet files |
| `GH_TOKEN` | GitHub PAT for private registry | CI secrets / local env |
| `GIT_TERMINAL_PROMPT` | Set to `0` in CI to prevent git auth prompts | CI workflow env |
| `VCPKG_OVERLAY_TRIPLETS` | Additional triplet search paths | CMakeLists.txt |
| `VCPKG_MANIFEST_FEATURES` | Active vcpkg features for build | CMakeLists.txt |
| `VCPKG_INSTALL_OPTIONS` | Extra vcpkg install flags | CMakeLists.txt |
| `MACOSX_DEPLOYMENT_TARGET` | macOS minimum version (14.0) | CI workflow env |
| `ANDROID_STL` | Android STL type (`c++_shared`) | CMake option |

## CMake Integration Patterns

### Standard Preamble

Every addon `CMakeLists.txt` follows this pattern:

```cmake
cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

# Optional: prepend custom triplets
set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(<project-name> C CXX)
```

**Important**: `VCPKG_MANIFEST_FEATURES` and `VCPKG_OVERLAY_TRIPLETS` must be set **before** the `project()` call, because vcpkg toolchain runs during project initialization.

### Finding Dependencies

```cmake
# find_package for CMake config-based packages
find_package(llama CONFIG REQUIRED)
find_package(GTest CONFIG REQUIRED)

# find_path for header-only or non-config packages
find_path(PICOJSON_INCLUDE_DIRS "picojson/picojson.h")
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/JsInterface.hpp")
find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)
```

### Linux-Specific Linking

LLM and Embed packages enforce libc++ and symbol hiding on Linux:

```cmake
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++ -Wl,--exclude-libs,ALL)
endif()
```

The `--exclude-libs,ALL` flag hides all symbols from static libraries, preventing symbol conflicts when the addon is loaded into Node.js/Bare.

## Troubleshooting

### Clean Rebuild

```bash
cd packages/<addon>
rm -rf build/           # remove CMake build tree + vcpkg installs
bare-make generate      # regenerate from scratch
bare-make build
bare-make install
```

### Clearing vcpkg Binary Cache

```bash
# Local files cache (CI-style)
rm -rf vcpkg/cache/

# Or clear the default user-wide cache
rm -rf ~/.cache/vcpkg/archives/
```

### Switching Local / Published Fabric

To use a local `qvac-fabric` build:
1. Ensure `vcpkg/ports/qvac-fabric/` overlay exists with correct `portfile.cmake` source path
2. Run `bare-make generate` — the overlay takes priority

To use the published registry version:
1. Remove or rename `vcpkg/ports/qvac-fabric/` directory
2. Clean build: `rm -rf build/`
3. Run `bare-make generate`

### Bumping a vcpkg Baseline

1. Get the latest commit SHA from the registry repo (private or microsoft/vcpkg)
2. Update the `baseline` field in the target package's `vcpkg-configuration.json`
3. Clean build to verify: `rm -rf build/ && bare-make generate && bare-make build`
4. If new packages were added to the Microsoft registry, add them to the `packages` array

### Bumping a Dependency Version

1. Update `version>=` in `vcpkg.json`
2. If the new version is in a newer baseline, bump the baseline too
3. Clean build and test

### Android Vulkan Headers Issue

If Android builds fail with missing Vulkan headers:
- Check that `opencl` dependency has `"platform": "android"` in `vcpkg.json`
- Verify the Android NDK version includes Vulkan headers
- Check the `arm64-android` triplet configuration

### ONNX Symbol Visibility Issues

If ONNX Runtime symbols conflict at runtime:
- Ensure the triplet sets `VCPKG_LIBRARY_LINKAGE static`
- On Linux, verify `--exclude-libs,ALL` is in linker flags
- Check that `VCPKG_BUILD_TYPE release` is set in override triplets (avoids debug symbol bloat)

### Registry Authentication Failures

If `bare-make generate` fails with git authentication errors:
- Verify `GH_TOKEN` is set and has read access to `tetherto/qvac-registry-vcpkg`
- For local dev with SSH: verify `https://github.com/tetherto/qvac-registry-vcpkg.git` is accessible
- In CI: check that the `.npmrc` setup step and git credential configuration ran successfully
- Set `GIT_TERMINAL_PROMPT=0` to prevent hanging on auth prompts

### vcpkg Port Not Found

If a package can't be resolved:
1. Check if it's listed in the correct registry's `packages` array in `vcpkg-configuration.json`
2. If it's a private package, it should resolve from the default registry (no listing needed)
3. If it's an upstream package, it must be explicitly listed in the Microsoft registry's `packages` array
4. Check baseline — the package may not exist at the pinned baseline commit

## Package Reference Table

| Addon Package | vcpkg Dependencies | Overlay Ports | Custom Triplets |
|--------------|-------------------|---------------|-----------------|
| `qvac-lib-infer-llamacpp-llm` | qvac-fabric, qvac-lib-inference-addon-cpp, qvac-lint-cpp, picojson, opencl (Android) | qvac-fabric (local dev) | Linux clang-19 |
| `qvac-lib-infer-llamacpp-embed` | qvac-fabric, qvac-lib-inference-addon-cpp, qvac-lint-cpp, opencl (Android) | qvac-fabric (local dev) | Linux clang-19 |
| `ocr-onnx` | onnxruntime (platform EPs), opencv4, qvac-lib-inference-addon-cpp, qvac-lint-cpp | None | Release-only |
| `qvac-lib-infer-onnx-tts` | onnxruntime (platform EPs), fmt, spdlog, tokenizers-cpp, qvac-lib-inference-addon-cpp, qvac-lint-cpp | None | Release-only (macOS/iOS) |
| `qvac-lib-infer-parakeet` | onnxruntime, qvac-lib-inference-addon-cpp | None | Release-only |
| `qvac-lib-infer-onnx` | onnxruntime (platform EPs), qvac-lib-inference-addon-cpp, qvac-lint-cpp | None | None |
| `qvac-lib-infer-whispercpp` | whisper-cpp, qvac-lib-inference-addon-cpp, qvac-lint-cpp | None | None |
| `qvac-lib-infer-nmtcpp` | bergamot-translator, sentencepiece, ssplit, whisper-cpp, qvac-lib-inference-addon-cpp, qvac-lint-cpp | 7 ports (bergamot, marian-dev, intgemm, ruy, simd-utils, ssplit, whisper-cpp) | None |
| `qvac-lib-inference-addon-cpp` | qvac-lint-cpp | None | None |
| `qvac-lint-cpp` | (none — self-contained) | None | None |
