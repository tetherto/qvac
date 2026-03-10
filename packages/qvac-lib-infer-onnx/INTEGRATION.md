# Integrating @qvac/onnx into a Consumer Addon

This guide covers all steps needed for an ONNX-based consumer addon (e.g. `ocr-onnx`, `qvac-lib-infer-onnx-tts`) to depend on and use `@qvac/onnx`.

## Overview

`@qvac/onnx` is distributed as an **npm package** (bare addon). It ships everything a consumer addon needs to build against ONNX Runtime:

- **qvac-onnx C++ headers** (`prebuilds/include/qvac-onnx/`) — header-only `OnnxSession`, `OnnxRuntime`, config types, tensor types
- **ONNX Runtime headers** (`prebuilds/include/onnxruntime/`) — public ORT C/C++ API headers
- **CMake config** (`prebuilds/share/qvac-onnx/`) — `find_package(qvac-onnx)` exposes:
  - `qvac-onnx::headers` — compile-time headers (always available)
  - `qvac-onnx::qvac-onnx-static` — static ORT linking (mobile builds only, when `prebuilds/share/onnxruntime/` exists)
- **Prebuilt `.bare` shared library** (`prebuilds/<platform>/qvac__onnx.bare`) — exports `OrtGetApiBase` and EP registration symbols; desktop consumers dynamically link against this
- **JS API** — `configureEnvironment`, `getAvailableProviders`, `createSession`, `run`, `destroySession`, etc. (see [README.md](./README.md))

### Desktop vs Mobile

- **Desktop** (Linux, macOS, Windows): Consumer addons dynamically link against `@qvac/onnx.bare` via `include_bare_module`. ORT symbols (`OrtGetApiBase`, etc.) are resolved at runtime from the shared `.bare`. This means ORT is loaded once per process, regardless of how many ONNX-based addons are loaded.
- **Mobile** (Android, iOS): Bare module dynamic linking is not available. Consumer addons statically link via `qvac-onnx::qvac-onnx-static`, which transitively provides `onnxruntime::onnxruntime_static`.

Consumer addons do **not** need `onnxruntime` in their own `vcpkg.json`. The ONNX Runtime comes bundled with `@qvac/onnx`.

---

## Step 1 — npm dependency

Add `@qvac/onnx` to the consumer's `package.json`:

```json
{
  "dependencies": {
    "@qvac/onnx": "^0.11.0"
  },
  "devDependencies": {
    "cmake-bare": "^1.5.0",
    "cmake-vcpkg": "^1.0.2"
  }
}
```

After `npm install`, the headers, prebuilt `.bare` shared library, and cmake configs are available under `node_modules/@qvac/onnx/prebuilds/`.

---

## Step 2 — vcpkg manifest (`vcpkg.json`)

The consumer's `vcpkg.json` only needs its own addon-specific dependencies. ONNX Runtime and its transitive dependencies are provided by `@qvac/onnx` via npm.

```json
{
  "name": "my-consumer-addon",
  "version": "1.0.0",
  "dependencies": [
    {
      "name": "qvac-lib-inference-addon-cpp",
      "version>=": "1.0.0"
    },
    {
      "name": "qvac-lint-cpp",
      "version>=": "1.4.1"
    }
  ],
  "features": {
    "tests": {
      "description": "Build tests",
      "dependencies": ["gtest"]
    }
  }
}
```

Add any addon-specific vcpkg dependencies here (e.g. `opencv4` for OCR, `tokenizers-cpp` for TTS). Do **not** add `onnxruntime`.

---

## Step 3 — vcpkg registry configuration (`vcpkg-configuration.json`)

Ensure the consumer's `vcpkg-configuration.json` includes the Tether registry as default and the Microsoft registry for any upstream packages the addon itself needs:

```json
{
  "default-registry": {
    "kind": "git",
    "baseline": "<current-baseline>",
    "repository": "git@github.com:tetherto/qvac-registry-vcpkg.git"
  },
  "registries": [
    {
      "kind": "git",
      "baseline": "8c901fe2b0e69a542d02810d4089505fd0c480d8",
      "repository": "https://github.com/microsoft/vcpkg",
      "packages": [
        "gtest"
      ]
    }
  ]
}
```

Add only the Microsoft registry packages your addon directly depends on. Packages previously required for onnxruntime (flatbuffers, re2, abseil, eigen3, etc.) are no longer needed here — they ship with `@qvac/onnx`.

---

## Step 4 — CMakeLists.txt

### Finding @qvac/onnx

A single `find_package` call discovers headers and cmake targets:

```cmake
cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

project(my-consumer-addon VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# --- Find @qvac/onnx (provides headers + cmake targets) ---
find_package(qvac-onnx CONFIG REQUIRED
    PATHS node_modules/@qvac/onnx/prebuilds)

# --- Define bare addon ---
add_bare_module(my-consumer-addon EXPORTS)

target_sources(${my-consumer-addon} PRIVATE addon/binding.cpp)

# Route ONNX session logs through JsLogger
target_compile_definitions(${my-consumer-addon} PRIVATE JS_LOGGER)
```

### Linking — desktop vs mobile

Consumer addons must use platform-conditional linking:

```cmake
if(ANDROID OR (APPLE AND CMAKE_SYSTEM_NAME STREQUAL "iOS"))
  # Mobile: static linking (bare module dynamic linking not available)
  target_link_libraries(${my-consumer-addon} PRIVATE
      qvac-onnx::qvac-onnx-static
  )
else()
  # Desktop: dynamic link against @qvac/onnx.bare
  include_bare_module("@qvac/onnx" qvac_onnx_target PREBUILD)

  # Headers for compile-time (OnnxSession.hpp, onnxruntime_cxx_api.h, etc.)
  target_link_libraries(${my-consumer-addon} PRIVATE
      qvac-onnx::headers
  )

  # Dynamic link — adds DT_NEEDED: qvac__onnx@0.bare
  target_link_libraries(${my-consumer-addon}_module PRIVATE
      ${qvac_onnx_target}_module
  )

  # Install @qvac/onnx.bare as companion library alongside the consumer .bare
  bare_target(host)
  bare_module_target("." _unused NAME addon_name)
  install(FILES $<TARGET_FILE:${qvac_onnx_target}_module>
      DESTINATION ${host}/${addon_name}
      RENAME qvac__onnx@0.bare)
endif()
```

**How it works at runtime (desktop):**

1. Consumer addon `.bare` has `DT_NEEDED: qvac__onnx@0.bare`
2. The dynamic linker resolves this via RPATH to the companion directory
3. If `qvac__onnx@0.bare` is already loaded (by another addon) → reuses it (SONAME match)
4. ORT symbols (`OrtGetApiBase`, etc.) resolve from the single loaded instance
5. All consumer addons share one ORT in memory

**CMake targets:**

| Target | Description | When available |
|--------|-------------|----------------|
| `qvac-onnx::headers` | Compile-time headers only (qvac-onnx + ORT public API) | Always |
| `qvac-onnx::qvac-onnx-static` | Headers + `onnxruntime::onnxruntime_static` | Mobile builds only (when `prebuilds/share/onnxruntime/` exists) |

### Symbol visibility

Consumer addons on desktop do **not** need a `symbols.map` or version script. ORT symbols are resolved at runtime from the shared `@qvac/onnx.bare`, not statically linked into each consumer.

On mobile, since ORT is statically linked into each consumer, symbol visibility is handled automatically by the platform's default linking behavior.

### Platform-specific additions

```cmake
# Android: Vulkan + log
if(ANDROID)
  find_package(Vulkan REQUIRED)
  target_link_libraries(${my-consumer-addon} PRIVATE ${Vulkan_LIBRARY} log)
endif()

# Windows: UTF-8, lean headers
if(WIN32)
  target_compile_options(${my-consumer-addon} PRIVATE "/utf-8")
  target_compile_definitions(${my-consumer-addon} PUBLIC
      WIN32_LEAN_AND_MEAN NOMINMAX NOGDI)
  target_link_libraries(${my-consumer-addon} PRIVATE msvcrt.lib)
endif()
```

---

## Step 5 — C++ usage

### Include headers

All headers live under the `qvac-onnx/` include prefix:

```cpp
#include <qvac-onnx/OnnxSession.hpp>   // Concrete session (header-only, pulls in ORT)
#include <qvac-onnx/IOnnxSession.hpp>   // Abstract interface (ORT-free)
#include <qvac-onnx/OnnxRuntime.hpp>    // Environment singleton, configure(), getAvailableProviders()
#include <qvac-onnx/OnnxConfig.hpp>     // SessionConfig, EnvironmentConfig, enums
#include <qvac-onnx/OnnxTensor.hpp>     // TensorInfo, InputTensor, OutputTensor, TensorType
```

### Configure the environment (optional)

The environment is process-wide. Call `configure()` before any session is created to customize logging:

```cpp
#include <qvac-onnx/OnnxRuntime.hpp>

onnx_addon::EnvironmentConfig envCfg;
envCfg.loggingLevel = onnx_addon::LoggingLevel::INFO;
envCfg.loggingId    = "my-addon";

onnx_addon::OnnxRuntime::configure(envCfg);  // throws if instance() already called
```

If `configure()` is never called, defaults are used (`WARNING` level, `"qvac-onnx"` id).

### Query available execution providers

```cpp
auto providers = onnx_addon::OnnxRuntime::getAvailableProviders();
// e.g. {"CPUExecutionProvider", "XnnpackExecutionProvider"}
```

### Create and run a session

```cpp
#include <qvac-onnx/OnnxSession.hpp>
#include <qvac-onnx/OnnxConfig.hpp>

// Configure session
onnx_addon::SessionConfig config;
config.provider          = onnx_addon::ExecutionProvider::AUTO_GPU;
config.optimization      = onnx_addon::GraphOptimizationLevel::EXTENDED;
config.intraOpThreads    = 4;
config.interOpThreads    = 2;
config.enableMemoryPattern = true;
config.enableCpuMemArena   = true;
config.enableXnnpack       = true;
config.executionMode       = onnx_addon::ExecutionMode::SEQUENTIAL;

// Create session
onnx_addon::OnnxSession session("path/to/model.onnx", config);

// Inspect model
auto inputs = session.getInputInfo();   // std::vector<TensorInfo>
auto outputs = session.getOutputInfo(); // std::vector<TensorInfo>

// Prepare input tensor
onnx_addon::InputTensor input;
input.name = inputs[0].name;
input.shape = {1, 3, 224, 224};
input.type = onnx_addon::TensorType::FLOAT32;
input.data = myFloatData.data();
input.dataSize = myFloatData.size() * sizeof(float);

// Run inference
auto results = session.run(input);

// Access output
const auto& output = results[0];
auto floatData = output.as<float>();  // span-like typed access
```

### Use the abstract interface for decoupling

If your addon wants to avoid pulling ONNX Runtime headers into every translation unit, use the abstract interface:

```cpp
#include <qvac-onnx/IOnnxSession.hpp>  // No ORT dependency

class MyPipeline {
  std::unique_ptr<onnx_addon::IOnnxSession> session_;
public:
  void setSession(std::unique_ptr<onnx_addon::IOnnxSession> s) {
    session_ = std::move(s);
  }
  std::vector<onnx_addon::OutputTensor> infer(const onnx_addon::InputTensor& in) {
    return session_->run(in);
  }
};
```

Then construct the concrete session in the translation unit that links ORT:

```cpp
#include <qvac-onnx/OnnxSession.hpp>
pipeline.setSession(std::make_unique<onnx_addon::OnnxSession>(path, config));
```

### Shared ORT runtime singleton

`OnnxSession` internally uses `OnnxRuntime::instance()` — a process-wide Meyers singleton that creates a single `Ort::Env`. Multiple sessions across different consumer addons share the same runtime environment. You do not need to manage `Ort::Env` yourself.

---

## Step 6 — JS-side usage (optional)

If the consumer addon needs to call the `@qvac/onnx` JS API directly (rather than only using the C++ headers):

```js
const onnx = require('@qvac/onnx')

// Optional: configure environment before first session
onnx.configureEnvironment({
  loggingLevel: 'info',   // 'verbose' | 'info' | 'warning' | 'error' | 'fatal'
  loggingId: 'my-addon'
})

// Query available execution providers
const providers = onnx.getAvailableProviders()
// e.g. ['CPUExecutionProvider', 'XnnpackExecutionProvider']

// Create session
const handle = onnx.createSession('/path/to/model.onnx', {
  provider: 'auto_gpu',
  optimization: 'extended',
  intraOpThreads: 4,
  interOpThreads: 2,
  enableXnnpack: true,
  enableMemoryPattern: true,
  enableCpuMemArena: true,
  executionMode: 'sequential'
})

const inputInfo = onnx.getInputInfo(handle)
const outputInfo = onnx.getOutputInfo(handle)

const results = onnx.run(handle, [{
  name: inputInfo[0].name,
  shape: [1, 3, 224, 224],
  type: 'float32',
  data: new Float32Array(1 * 3 * 224 * 224)
}])

// results: [{ name, shape, type, data: Float32Array }]

onnx.destroySession(handle)
```

---

## Step 7 — Build

```bash
npm install        # Resolves @qvac/onnx + devDependencies (cmake-bare, cmake-vcpkg)
npm run build      # bare-make generate && bare-make build && bare-make install
```

---

## Thread pool configuration

ONNX Runtime uses two thread pools per session:

| Setting | What it controls | Default |
|---------|-----------------|---------|
| `intraOpThreads` | Parallelism **within** a single operator (e.g. matrix multiply) | `0` (all cores) |
| `interOpThreads` | Parallelism **between** independent operators in the graph | `0` (all cores) |
| `executionMode` | Whether independent operators run in parallel or sequentially | `"sequential"` |

- **Sequential mode** (default): Operators run one at a time. Only intra-op parallelism is used. This is the safest default and recommended for most workloads.
- **Parallel mode**: Independent operators can run concurrently. Requires `interOpThreads > 1` to be effective. Useful for models with many independent branches.

### Memory options

| Setting | What it controls | Default |
|---------|-----------------|---------|
| `enableMemoryPattern` | Reuse memory allocations based on execution patterns | `true` |
| `enableCpuMemArena` | Use a memory arena for CPU allocations to reduce malloc overhead | `true` |

DirectML on Windows automatically disables memory patterns and forces sequential mode — this is handled internally by the session options builder.

---

## Checklist

| # | Step | What to verify |
|---|------|----------------|
| 1 | `package.json` | `@qvac/onnx` `^0.11.0` in `dependencies`; `cmake-bare` and `cmake-vcpkg` in `devDependencies` |
| 2 | `vcpkg.json` | `onnxruntime` is **not** listed (it ships with `@qvac/onnx`); only addon-specific deps remain |
| 3 | `vcpkg-configuration.json` | Tether registry as default; Microsoft registry only for addon-specific upstream packages |
| 4 | `CMakeLists.txt` | `find_package(qvac-onnx ...)`, platform guard with `qvac-onnx::headers` + `include_bare_module` (desktop) or `qvac-onnx::qvac-onnx-static` (mobile); `JS_LOGGER` defined |
| 5 | Companion lib | Desktop: `qvac__onnx@0.bare` installed in `prebuilds/<host>/<addon_name>/` |
| 6 | C++ sources | Include `<qvac-onnx/OnnxSession.hpp>` instead of raw `<onnxruntime_cxx_api.h>` |
| 7 | Build | `npm run build` succeeds; `readelf -d` shows `NEEDED qvac__onnx@0.bare` (desktop) |

## Supported Platforms

| Platform | Execution Provider | Triplet |
|----------|--------------------|---------|
| Linux | XNNPack, CPU | `x64-linux` |
| macOS | CoreML, XNNPack, CPU | `arm64-osx` |
| Windows | DirectML, XNNPack, CPU | (default MSVC) |
| Android | NNAPI, XNNPack, CPU | `arm64-android` |
| iOS | CoreML, XNNPack, CPU | `arm64-ios` |
| iOS Sim | CoreML, XNNPack, CPU | `arm64-ios-simulator`, `x64-ios-simulator` |
