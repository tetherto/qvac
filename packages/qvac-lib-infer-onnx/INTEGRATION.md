# Integrating @qvac/onnx into a Consumer Addon

This guide covers all steps needed for an ONNX-based consumer addon to depend on and use `@qvac/onnx`. It uses `@qvac/ocr-onnx` as a concrete reference implementation throughout.

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
- **Mobile** (Android, iOS): Controlled by the `MOBILE_DYNAMIC_LINK` CMake option (default `ON`). When `ON`, mobile builds use the same dynamic linking as desktop. When `OFF`, consumer addons statically link via `qvac-onnx::qvac-onnx-static`, which transitively provides `onnxruntime::onnxruntime_static`.

Consumer addons do **not** need `onnxruntime` in their own `vcpkg.json`. The ONNX Runtime comes bundled with `@qvac/onnx`.

---

## Step 1 — npm dependency

Add `@qvac/onnx` to the consumer's `package.json`:

```json
{
  "dependencies": {
    "@qvac/onnx": "^0.13.3"
  },
  "devDependencies": {
    "cmake-bare": "^1.7.5",
    "cmake-vcpkg": "^1.1.0"
  }
}
```

After `npm install`, the headers, prebuilt `.bare` shared library, and cmake configs are available under `node_modules/@qvac/onnx/prebuilds/`.

**How `ocr-onnx` does it:** `@qvac/ocr-onnx` depends on `"@qvac/onnx": "^0.13.3"` in its `dependencies`. It also depends on `@qvac/infer-base` (shared base class for ONNX inference addons), `@qvac/error`, and `@qvac/response` for the JS layer, and `opencv4` (via vcpkg) for image processing in C++.

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
      "version>=": "1.4.4"
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

Add any addon-specific vcpkg dependencies here. Do **not** add `onnxruntime`.

**How `ocr-onnx` does it:** Its `vcpkg.json` lists `opencv4` (with specific features: `jpeg`, `png`, `quirc`, `tiff`, `webp`), `qvac-lib-inference-addon-cpp`, and `qvac-lint-cpp`. No `onnxruntime` — that comes from `@qvac/onnx`.

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

**How `ocr-onnx` does it:** Its `vcpkg-configuration.json` lists the Microsoft registry packages for `opencv4` and its transitive dependencies (libjpeg-turbo, libpng, libwebp, zlib, etc.) plus `gtest`. The list is large because OpenCV pulls in many upstream deps, but none are onnxruntime-related.

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
set(qvac-onnx_DIR "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/@qvac/onnx/prebuilds/share/qvac-onnx/cmake")
find_package(qvac-onnx CONFIG REQUIRED)

# --- Define bare addon ---
add_bare_module(my-consumer-addon EXPORTS)

target_sources(${my-consumer-addon} PRIVATE addon/binding.cpp)

# Route ONNX session logs through JsLogger
target_compile_definitions(${my-consumer-addon} PRIVATE JS_LOGGER)
```

**How `ocr-onnx` does it:** It sets the cmake config path explicitly via `set(qvac-onnx_DIR ...)` rather than passing `PATHS` to `find_package`:

```cmake
set(qvac-onnx_DIR "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/@qvac/onnx/prebuilds/share/qvac-onnx/cmake")
find_package(qvac-onnx CONFIG REQUIRED)
```

### Linking — desktop vs mobile

Consumer addons must use platform-conditional linking. The `MOBILE_DYNAMIC_LINK` CMake option (default `ON`) controls whether mobile builds use dynamic or static linking:

```cmake
option(MOBILE_DYNAMIC_LINK "Use dynamic linking for ONNX Runtime on mobile" ON)

if((ANDROID OR (APPLE AND CMAKE_SYSTEM_NAME STREQUAL "iOS")) AND NOT MOBILE_DYNAMIC_LINK)
  # Mobile (static): each addon embeds ONNX Runtime
  target_link_libraries(${my-consumer-addon} PRIVATE
      qvac-onnx::qvac-onnx-static
  )
else()
  # Desktop and mobile (dynamic): link against @qvac/onnx.bare shared module
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

**How `ocr-onnx` does it:** The `ocr-onnx` CMakeLists.txt uses exactly this pattern. Dynamic linking is the default path for both desktop and mobile. The `else()` branch handles desktop + dynamic mobile, while `MOBILE_DYNAMIC_LINK=OFF` falls back to static linking for mobile targets:

```cmake
if((ANDROID OR (APPLE AND CMAKE_SYSTEM_NAME STREQUAL "iOS")) AND NOT MOBILE_DYNAMIC_LINK)
  target_link_libraries(
    ${qvac-lib-inference-addon-onnx-ocr-fasttext}
    PRIVATE
      ${OpenCV_LIBS}
      qvac-onnx::qvac-onnx-static
  )
else()
  include_bare_module("@qvac/onnx" qvac_onnx_target PREBUILD)

  target_link_libraries(
    ${qvac-lib-inference-addon-onnx-ocr-fasttext}
    PRIVATE
      ${OpenCV_LIBS}
      qvac-onnx::headers
  )
  target_link_libraries(
    ${qvac-lib-inference-addon-onnx-ocr-fasttext}_module
    PRIVATE
      ${qvac_onnx_target}_module
  )

  bare_target(host)
  bare_module_target("." _unused NAME addon_name)
  install(FILES $<TARGET_FILE:${qvac_onnx_target}_module>
    DESTINATION ${host}/${addon_name}
    RENAME qvac__onnx@0.bare)
endif()
```

Note: `ocr-onnx` also links `${OpenCV_LIBS}` alongside the onnx targets — this is addon-specific. The onnx linking pattern is the same for all consumers.

**How it works at runtime (desktop / dynamic mobile):**

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

Consumer addons on desktop do **not** need a `symbols.map` or version script for ORT symbols. ORT symbols are resolved at runtime from the shared `@qvac/onnx.bare`, not statically linked into each consumer.

Consumer addons typically use a standard visibility map that exports only `bare_*` and `napi_*` symbols:

```
{
  global:
    bare_*;
    napi_*;
  local:
    *;
};
```

On mobile with static linking, symbol visibility is handled automatically by the platform's default linking behavior.

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

**How `ocr-onnx` does it:** Uses the exact same Android (Vulkan + log) and Windows (/utf-8, lean headers, msvcrt.lib) blocks, plus Android-specific library stripping for OpenCV.

---

## Step 5 — JS-side: pre-loading @qvac/onnx

Consumer addons that dynamically link against `@qvac/onnx.bare` **must** pre-load it in their `binding.js` before calling `require.addon()`. This ensures the bare runtime has registered the `.bare` module before the dynamic linker tries to resolve it (required for Windows delay-load):

```js
// Pre-load @qvac/onnx so its .bare module is registered with the bare runtime
// before our addon triggers Windows delay-load resolution of qvac__onnx@0.bare
// (bare_module_find requires modules to be already loaded).
require('@qvac/onnx')

module.exports = require.addon()
```

**How `ocr-onnx` does it:** Its `binding.js` does exactly this — `require('@qvac/onnx')` followed by `module.exports = require.addon()`. This is the only place where `ocr-onnx` references the `@qvac/onnx` JS module. All ONNX inference in `ocr-onnx` happens through the C++ API (see Step 6).

---

## Step 6 — C++ usage

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

If `configure()` is never called, defaults are used (`ERROR` level, `"qvac-onnx"` id).

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

// Create session (automatic fallback: requested config → no XNNPACK → CPU-only)
onnx_addon::OnnxSession session("path/to/model.onnx", config);

// Inspect model
auto inputs = session.getInputInfo();   // std::vector<TensorInfo>
auto outputs = session.getOutputInfo(); // std::vector<TensorInfo>

// Direct name access (cached, avoids ORT API calls)
const std::string& inputName = session.inputName(0);
const std::string& outputName = session.outputName(0);

// Prepare input tensor
onnx_addon::InputTensor input;
input.name = inputs[0].name;
input.shape = {1, 3, 224, 224};
input.type = onnx_addon::TensorType::FLOAT32;
input.data = myFloatData.data();
input.dataSize = myFloatData.size() * sizeof(float);

// Run inference (deep copy of outputs)
auto results = session.run(input);

// Access output
const auto& output = results[0];
auto floatData = output.as<float>();  // typed pointer access
```

### Zero-copy inference with `runRaw()`

For performance-critical pipelines, `runRaw()` returns raw `Ort::Value` objects directly, avoiding the deep copy that `run()` performs:

```cpp
// Returns std::vector<Ort::Value> — zero-copy output
auto ortValues = session.runRaw(input);

// Access tensor data directly from ORT memory
auto typeInfo = ortValues[0].GetTypeInfo();
auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();
const float* data = ortValues[0].GetTensorData<float>();
```

`runRaw()` is only available on `OnnxSession` (not `IOnnxSession`) since it exposes ORT types.

### How `ocr-onnx` uses the C++ API

`ocr-onnx` uses `@qvac/onnx` exclusively through the C++ header-only API — it does **not** call the JS API for inference. All pipeline steps use `runRaw()` for zero-copy performance. The integration pattern is:

1. **`PipelineConfig` holds an `onnx_addon::SessionConfig`** — the JS layer passes provider/optimization/thread configuration down to C++ via the config struct. Defaults to `CPU` provider.

2. **Each pipeline step owns an `onnx_addon::OnnxSession`** — there are four step classes that each create and hold their own session:
   - `StepDetectionInference` — CRAFT text detection (EasyOCR mode)
   - `StepRecognizeText` — CTC text recognition (EasyOCR mode)
   - `StepDoctrDetection` — DBNet text detection (DocTR mode)
   - `StepDoctrRecognition` — PARSeq/CRNN recognition (DocTR mode)

3. **Sessions are constructed with model path + shared config:**
   ```cpp
   // In Pipeline constructor
   stepDetection_ = std::make_unique<StepDetectionInference>(
       pathDetector, config.sessionConfig, config.magRatio);
   ```

4. **Each step includes `<qvac-onnx/OnnxSession.hpp>`** and uses the session member directly for inference, calling `session_.runRaw()` with prepared `InputTensor` objects built from OpenCV `cv::Mat` data.

5. **Windows session lifetime workaround** — On Windows, all four pipeline steps defer session destruction to avoid an ORT global-state crash during process teardown:
   ```cpp
   #if defined(_WIN32) || defined(_WIN64)
     ~StepDetectionInference() { deferWindowsSessionLeak(std::move(session_)); }
   #endif
   ```
   The `deferWindowsSessionLeak()` function moves the session to a leaked pointer that the OS reclaims on process exit, avoiding a crash in ORT's global cleanup.

6. **Two pipeline modes** — Pipeline supports `EASYOCR` mode (3 steps: detect → bounding boxes → recognize) and `DOCTR` mode (2 steps: detect → recognize). Both modes share the same `SessionConfig`.

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

Note: `ocr-onnx` does not use the abstract interface — it includes `OnnxSession.hpp` directly in each pipeline step and stores `onnx_addon::OnnxSession` as a direct member. This is simpler when all translation units already link ORT headers, and allows access to `runRaw()` which is not part of the abstract interface.

### Shared ORT runtime singleton

`OnnxSession` internally uses `OnnxRuntime::instance()` — a process-wide Meyers singleton that creates a single `Ort::Env`. Multiple sessions across different consumer addons share the same runtime environment. You do not need to manage `Ort::Env` yourself.

---

## Step 7 — JS-side usage (optional)

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

**How `ocr-onnx` uses the JS API:** It does **not** use the JS API for inference at all. The only JS-side interaction is the `require('@qvac/onnx')` pre-load in `binding.js` (see Step 5). All session creation and inference happens through the C++ API in the pipeline steps. The JS layer (`ONNXOcr` class in `index.js`) passes configuration parameters down to C++ via `createInstance` / `runJob` bindings, and receives results via callbacks.

The config parameters mapped from JS to `onnx_addon::SessionConfig` in the C++ binding layer (`AddonJs.hpp`) are:

| JS parameter | C++ field | Mapping |
|-------------|-----------|---------|
| `useGPU` | `sessionConfig.provider` | `true` → `AUTO_GPU`, `false` → `CPU` |
| `graphOptimization` | `sessionConfig.optimization` | `"basic"`, `"extended"`, `"all"`, `"disable"` |
| `enableXnnpack` | `sessionConfig.enableXnnpack` | boolean |
| `enableCpuMemArena` | `sessionConfig.enableCpuMemArena` | boolean |
| `intraOpThreads` | `sessionConfig.intraOpThreads` | integer |

---

## Step 8 — Build

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

## `ocr-onnx` integration summary

Here is how `@qvac/ocr-onnx` integrates `@qvac/onnx` end-to-end:

```
JS layer (index.js)
│  ONNXOcr extends ONNXBase
│  Passes config params (useGPU, timeout, graphOptimization,
│  enableXnnpack, intraOpThreads, enableCpuMemArena, etc.) to C++
│
├── binding.js
│   require('@qvac/onnx')     ← pre-load for Windows delay-load
│   require.addon()            ← loads ocr-onnx .bare addon
│
├── ocr-fasttext.js
│   OcrFasttextInterface wraps native binding calls
│   (createInstance, runJob, activate, destroy, cancel)
│
└── C++ layer (addon/)
    │
    ├── addon/AddonJs.hpp
    │   Maps JS params → PipelineConfig with onnx_addon::SessionConfig
    │   (useGPU → provider, graphOptimization → optimization, etc.)
    │
    └── pipeline/
        ├── Pipeline.cpp
        │   Constructs steps, passes onnx_addon::SessionConfig to each
        │   Two modes: EASYOCR (3 steps) or DOCTR (2 steps)
        │
        ├── StepDetectionInference   ← owns onnx_addon::OnnxSession
        │   #include <qvac-onnx/OnnxSession.hpp>
        │   CRAFT text detection model — uses runRaw() for zero-copy
        │
        ├── StepRecognizeText        ← owns onnx_addon::OnnxSession
        │   #include <qvac-onnx/OnnxSession.hpp>
        │   CTC text recognition model — uses runRaw() for zero-copy
        │
        ├── StepDoctrDetection       ← owns onnx_addon::OnnxSession
        │   #include <qvac-onnx/OnnxSession.hpp>
        │   DBNet detection model — uses runRaw() for zero-copy
        │
        └── StepDoctrRecognition     ← owns onnx_addon::OnnxSession
            #include <qvac-onnx/OnnxSession.hpp>
            PARSeq/CRNN recognition model — uses runRaw() for zero-copy
```

Key takeaways from the `ocr-onnx` integration:
- All ONNX inference is C++-only; the JS API is not used for inference
- All pipeline steps use `runRaw()` for zero-copy output, avoiding `memcpy` of output tensors
- Each pipeline step creates its own `OnnxSession` from the shared `SessionConfig`
- The `binding.js` pre-load is essential for cross-platform module resolution
- OpenCV is the only additional native dependency (`vcpkg.json`)
- The `MOBILE_DYNAMIC_LINK` option allows switching between dynamic and static ORT linking on mobile
- Windows requires deferred session destruction (`deferWindowsSessionLeak`) to avoid ORT global-state crashes

---

## Checklist

| # | Step | What to verify |
|---|------|----------------|
| 1 | `package.json` | `@qvac/onnx` `^0.13.3` in `dependencies`; `cmake-bare` and `cmake-vcpkg` in `devDependencies` |
| 2 | `vcpkg.json` | `onnxruntime` is **not** listed (it ships with `@qvac/onnx`); only addon-specific deps remain |
| 3 | `vcpkg-configuration.json` | Tether registry as default; Microsoft registry only for addon-specific upstream packages |
| 4 | `CMakeLists.txt` | `find_package(qvac-onnx ...)`, platform guard with `qvac-onnx::headers` + `include_bare_module` (desktop/dynamic) or `qvac-onnx::qvac-onnx-static` (static mobile); `JS_LOGGER` defined |
| 5 | `binding.js` | `require('@qvac/onnx')` **before** `require.addon()` (Windows delay-load) |
| 6 | Companion lib | Desktop: `qvac__onnx@0.bare` installed in `prebuilds/<host>/<addon_name>/` |
| 7 | C++ sources | Include `<qvac-onnx/OnnxSession.hpp>` instead of raw `<onnxruntime_cxx_api.h>` |
| 8 | Build | `npm run build` succeeds; `readelf -d` shows `NEEDED qvac__onnx@0.bare` (desktop) |

## Supported Platforms

| Platform | Execution Provider | Triplet |
|----------|--------------------|---------|
| Linux | XNNPack, CPU | `x64-linux` |
| macOS | CoreML, XNNPack, CPU | `arm64-osx` |
| Windows | DirectML, XNNPack, CPU | (default MSVC) |
| Android | NNAPI, XNNPack, CPU | `arm64-android` |
| iOS | CoreML, XNNPack, CPU | `arm64-ios` |
| iOS Sim | CoreML, XNNPack, CPU | `arm64-ios-simulator`, `x64-ios-simulator` |
