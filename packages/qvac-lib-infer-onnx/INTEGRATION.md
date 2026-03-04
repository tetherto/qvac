# Integrating @qvac/onnx into a Consumer Addon

This guide covers all steps needed for an ONNX-based consumer addon (e.g. `ocr-onnx`, `qvac-lib-infer-onnx-tts`) to depend on and use `@qvac/onnx`.

## Overview

`@qvac/onnx` is distributed as an **npm package** (bare addon). It ships everything a consumer addon needs to build against ONNX Runtime:

- **qvac-onnx C++ headers** (`prebuilds/include/qvac-onnx/`) — header-only `OnnxSession`, `OnnxRuntime`, config types, tensor types
- **ONNX Runtime headers and static libraries** (`prebuilds/include/onnxruntime/`, `prebuilds/lib/`) — plus all transitive dependencies (abseil, protobuf, re2, eigen, etc.)
- **CMake config** (`prebuilds/share/`) — `find_package(qvac-onnx)` exposes the `qvac-onnx::qvac-onnx` imported target which transitively provides `onnxruntime::onnxruntime_static`
- **JS API** — `configureEnvironment`, `getAvailableProviders`, `createSession`, `run`, `destroySession`, etc. (see [README.md](./README.md))

Consumer addons do **not** need `onnxruntime` in their own `vcpkg.json`. The ONNX Runtime comes bundled with `@qvac/onnx`.

---

## Step 1 — npm dependency

Add `@qvac/onnx` to the consumer's `package.json`:

```json
{
  "dependencies": {
    "@qvac/onnx": "^0.10.0"
  },
  "devDependencies": {
    "cmake-bare": "^1.5.0",
    "cmake-vcpkg": "^1.0.2"
  }
}
```

After `npm install`, the headers, static libraries, and cmake configs are available under `node_modules/@qvac/onnx/prebuilds/`.

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

A single `find_package` call discovers everything:

```cmake
cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

project(my-consumer-addon VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# --- Find @qvac/onnx (provides headers + onnxruntime) ---
find_package(qvac-onnx CONFIG REQUIRED
    PATHS node_modules/@qvac/onnx/prebuilds)

# --- Find qvac-lib-inference-addon-cpp (from vcpkg) ---
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
          "qvac-lib-inference-addon-cpp/JsInterface.hpp")

# --- Define bare addon ---
add_bare_module(my-consumer-addon EXPORTS)

target_sources(${my-consumer-addon} PRIVATE addon/binding.cpp)

target_include_directories(${my-consumer-addon} PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(${my-consumer-addon} PRIVATE
    qvac-onnx::qvac-onnx
)

# Route ONNX session logs through JsLogger
target_compile_definitions(${my-consumer-addon} PRIVATE JS_LOGGER)
```

`qvac-onnx::qvac-onnx` is an INTERFACE target that transitively provides:
- qvac-onnx C++ headers (`<qvac-onnx/OnnxSession.hpp>`, etc.)
- ONNX Runtime headers (`<onnxruntime_cxx_api.h>`, etc.)
- `onnxruntime::onnxruntime_static` link library and all its transitive dependencies

### Symbol visibility (required)

Each consumer addon **must** hide internal ONNX Runtime symbols to prevent conflicts when multiple ONNX-based addons are loaded in the same process.

Create a `symbols.map` file in the consumer addon root:

```
{
  global:
    bare_*;
    napi_*;
  local:
    *;
};
```

Then add to `CMakeLists.txt`:

```cmake
# Linux/Unix: version script
if(UNIX AND NOT APPLE)
  target_link_options(${my-consumer-addon}_module PRIVATE
      -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/symbols.map
  )
# macOS: exported symbols list
elseif(APPLE)
  target_link_options(${my-consumer-addon}_module PRIVATE
      -Wl,-exported_symbol,_bare_get_module_name_v0
      -Wl,-exported_symbol,_bare_register_module_v0
  )
endif()
```

**Note:** Target the `_module` shared library (not the object library) for link options.

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
| 1 | `package.json` | `@qvac/onnx` listed in `dependencies`; `cmake-bare` and `cmake-vcpkg` in `devDependencies` |
| 2 | `vcpkg.json` | `onnxruntime` is **not** listed (it ships with `@qvac/onnx`); only addon-specific deps remain |
| 3 | `vcpkg-configuration.json` | Tether registry as default; Microsoft registry only for addon-specific upstream packages |
| 4 | `CMakeLists.txt` | `find_package(qvac-onnx CONFIG REQUIRED PATHS node_modules/@qvac/onnx/prebuilds)`; link `qvac-onnx::qvac-onnx`; `JS_LOGGER` defined |
| 5 | `symbols.map` | Exports only `bare_*` and `napi_*`; applied via `--version-script` (Linux) or `-exported_symbol` (macOS) |
| 6 | C++ sources | Include `<qvac-onnx/OnnxSession.hpp>` instead of raw `<onnxruntime_cxx_api.h>` |
| 7 | Build | `npm run build` succeeds on target platform |

## Supported Platforms

| Platform | Execution Provider | Triplet |
|----------|--------------------|---------|
| Linux | XNNPack, CPU | `x64-linux` |
| macOS | CoreML, XNNPack, CPU | `arm64-osx` |
| Windows | DirectML, XNNPack, CPU | (default MSVC) |
| Android | NNAPI, XNNPack, CPU | `arm64-android` |
| iOS | CoreML, XNNPack, CPU | `arm64-ios` |
| iOS Sim | CoreML, XNNPack, CPU | `arm64-ios-simulator`, `x64-ios-simulator` |
