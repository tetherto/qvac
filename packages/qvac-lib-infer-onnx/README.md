# @qvac/onnx

Bare addon providing ONNX Runtime session management for QVAC inference addons. Links ONNX Runtime (via vcpkg) and exposes both a C++ header-only library and a JavaScript API. On desktop platforms, `@qvac/onnx.bare` is the single shared library containing ORT — consumer addons dynamically link against it so ORT is loaded exactly once per process. On mobile (Android/iOS), consumer addons can statically link ORT via the bundled static libraries, or dynamically link (controlled by the `MOBILE_DYNAMIC_LINK` CMake option). Has no dependency on `qvac-lib-inference-addon-cpp`.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  JS API  (binding.js → addon/binding.cpp)           │
│  configureEnvironment · getAvailableProviders        │
│  createSession · run · getInputInfo · getOutputInfo  │
│  destroySession                                      │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  C++ Headers  (header-only, namespace onnx_addon)   │
│                                                     │
│  OnnxSession.hpp          Concrete session           │
│  IOnnxSession.hpp         Abstract interface (no ORT)│
│  OnnxRuntime.hpp          Process-wide Ort::Env      │
│  OnnxSessionOptionsBuilder.hpp  EP / thread config   │
│  OnnxConfig.hpp           SessionConfig, enums       │
│  OnnxTensor.hpp           TensorInfo, I/O tensors    │
│  OnnxTypeConversions.hpp  ORT ↔ addon type mapping   │
│  Logger.hpp               Logging (stdout or JS)     │
│  AndroidLog.hpp           Android logcat logging     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  ONNX Runtime  (via vcpkg)                           │
│  Desktop: exported from qvac__onnx.bare (shared)    │
│  Mobile:  dynamic (default) or static linking       │
│  + XNNPack EP · CoreML · NNAPI · DirectML           │
└─────────────────────────────────────────────────────┘
```

**Key design points:**

- **Single ORT load** — On desktop, `@qvac/onnx.bare` exports `OrtGetApiBase` and EP registration symbols. Consumer addons dynamically link against it (`DT_NEEDED: qvac__onnx@0.bare`), so ORT is loaded exactly once per process via ELF SONAME deduplication.
- **Single Ort::Env** — `OnnxRuntime` is a Meyers singleton. All sessions across all consumer addons in the same process share one environment.
- **Header-only C++** — Consumer addons include `<qvac-onnx/OnnxSession.hpp>` and link `qvac-onnx::headers` (compile-time headers only). ORT symbols are resolved at runtime from the shared `.bare`.
- **Abstract interface** — `IOnnxSession` lets consumers decouple pipeline code from ONNX Runtime headers.
- **Mobile linking** — Controlled by `MOBILE_DYNAMIC_LINK` CMake option (default `ON`). When `ON`, mobile builds use the same dynamic linking as desktop. When `OFF`, consumer addons statically link via `qvac-onnx::qvac-onnx-static` (which transitively provides `onnxruntime::onnxruntime_static`).
- **Automatic fallback chain** — Session construction retries on failure: requested config → without XNNPACK → CPU-only. This ensures models load even when an EP is unavailable.

## JS API

### `configureEnvironment(config?)`

Configures the process-wide ONNX Runtime environment. Must be called **before** the first `createSession()`. Calling after initialization throws.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `loggingLevel` | `string` | `"error"` | `"verbose"`, `"info"`, `"warning"`, `"error"`, `"fatal"` |
| `loggingId` | `string` | `"qvac-onnx"` | Identifier used in ORT log messages |

### `getAvailableProviders() → string[]`

Returns the list of execution providers compiled into this build (for example `["CPUExecutionProvider"]` or `["CPUExecutionProvider", "XnnpackExecutionProvider"]`, depending on how the addon was built).

### `createSession(modelPath, config?) → handle`

Creates an ONNX Runtime inference session for the given model file.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `string` | `"auto_gpu"` | `"cpu"`, `"auto_gpu"`, `"nnapi"`, `"coreml"`, `"directml"` |
| `optimization` | `string` | `"extended"` | `"disable"`, `"basic"`, `"extended"`, `"all"` |
| `intraOpThreads` | `number` | `0` | Intra-op parallelism thread count (0 = auto) |
| `interOpThreads` | `number` | `0` | Inter-op parallelism thread count (0 = auto) |
| `enableXnnpack` | `boolean` | `false` | Enable XNNPack execution provider for CPU |
| `enableMemoryPattern` | `boolean` | `true` | Enable memory pattern optimization |
| `enableCpuMemArena` | `boolean` | `true` | Enable CPU memory arena |
| `executionMode` | `string` | `"sequential"` | `"sequential"` or `"parallel"` |

### `getInputInfo(handle) → Array<{name, shape, type}>`

Returns input tensor metadata for the session.

### `getOutputInfo(handle) → Array<{name, shape, type}>`

Returns output tensor metadata for the session.

### `run(handle, inputs) → Array<{name, shape, type, data}>`

Runs inference. Each input: `{name: string, shape: number[], type: string, data: TypedArray}`.

Supported tensor types and corresponding TypedArrays:
- `float32` → `Float32Array`
- `float16` → Special handling (no native JS TypedArray)
- `int64` → `BigInt64Array`
- `int32` → `Int32Array`
- `int8` → `Int8Array`
- `uint8` → `Uint8Array`

Returns array of outputs: `{name: string, shape: number[], type: string, data: TypedArray}` where `data` contains the inference results as the appropriate TypedArray type.

### `destroySession(handle)`

Destroys the session and frees resources.

## C++ API

All headers are under the `qvac-onnx/` include prefix (source in `src/qvac-onnx/`).

### Headers

| Header | Description |
|--------|-------------|
| `OnnxSession.hpp` | Concrete session — load model, run inference, inspect I/O, zero-copy `runRaw()` |
| `IOnnxSession.hpp` | Abstract interface (no ORT dependency) for virtual dispatch |
| `OnnxRuntime.hpp` | Singleton `Ort::Env`; `configure()` and `getAvailableProviders()` |
| `OnnxConfig.hpp` | `SessionConfig`, `EnvironmentConfig`, enums, `providerToString()`, `optimizationToString()` |
| `OnnxTensor.hpp` | `TensorInfo`, `InputTensor`, `OutputTensor`, `TensorType`, `tensorTypeSize()` |
| `OnnxSessionOptionsBuilder.hpp` | Builds `Ort::SessionOptions` from `SessionConfig` |
| `OnnxTypeConversions.hpp` | Maps ORT element types to `TensorType` |
| `Logger.hpp` | Logging via stdout or JS (controlled by `JS_LOGGER` define) |
| `AndroidLog.hpp` | Android logcat logging (controlled by `QVAC_ONNX_ENABLE_ANDROID_LOG` define) |

### Configuration types

```cpp
// Environment (process-wide, one-time)
onnx_addon::EnvironmentConfig envCfg;
envCfg.loggingLevel = onnx_addon::LoggingLevel::ERROR;   // VERBOSE, INFO, WARNING, ERROR, FATAL
envCfg.loggingId    = "my-addon";
onnx_addon::OnnxRuntime::configure(envCfg);               // before first session

// Session (per-model)
onnx_addon::SessionConfig config;
config.provider          = onnx_addon::ExecutionProvider::CPU;       // CPU, AUTO_GPU, NNAPI, CoreML, DirectML
config.optimization      = onnx_addon::GraphOptimizationLevel::ALL;  // DISABLE, BASIC, EXTENDED, ALL
config.intraOpThreads    = 4;
config.interOpThreads    = 2;
config.enableMemoryPattern = true;
config.enableCpuMemArena   = true;
config.enableXnnpack       = false;  // Default: false (must be explicitly enabled)
config.executionMode       = onnx_addon::ExecutionMode::SEQUENTIAL;  // SEQUENTIAL, PARALLEL
```

### OnnxSession

Concrete session class inheriting from `IOnnxSession`. Header-only, requires ONNX Runtime linked by the consuming target. Non-copyable, movable.

```cpp
#include <qvac-onnx/OnnxSession.hpp>

// Construction — loads model with automatic fallback chain:
//   1. Try with requested config (may include GPU EP + XNNPACK)
//   2. If XNNPACK enabled and init fails, retry without XNNPACK
//   3. If a non-CPU provider was requested and init fails, retry CPU-only
onnx_addon::OnnxSession session("model.onnx", config);

// Introspection
auto inputs  = session.getInputInfo();    // std::vector<TensorInfo>
auto outputs = session.getOutputInfo();   // std::vector<TensorInfo>
const std::string& name = session.inputName(0);   // cached, no ORT API call
const std::string& out  = session.outputName(0);  // cached, no ORT API call
bool valid = session.isValid();           // true if session loaded successfully
const std::string& path = session.modelPath();

// Run inference — returns deep-copied OutputTensors
auto results = session.run(input);                     // single input, all outputs
auto results = session.run(inputs);                    // multiple inputs, all outputs
auto results = session.run(inputs, outputNames);       // multiple inputs, specific outputs

// Run inference — returns raw Ort::Values (zero-copy, OnnxSession-only, not in IOnnxSession)
auto ortValues = session.runRaw(input);                // single input, all outputs
auto ortValues = session.runRaw(inputs);               // multiple inputs, all outputs
auto ortValues = session.runRaw(inputs, outputNames);  // multiple inputs, specific outputs
```

The `runRaw()` methods return `std::vector<Ort::Value>` directly from ORT, avoiding the deep copy that `run()` performs. Use `runRaw()` in performance-critical pipelines where you can work with ORT values directly.

### IOnnxSession (abstract interface)

For consumers that want to decouple pipeline code from ONNX Runtime headers:

```cpp
#include <qvac-onnx/IOnnxSession.hpp>  // No ORT dependency

class IOnnxSession {
  virtual std::vector<TensorInfo> getInputInfo() const = 0;
  virtual std::vector<TensorInfo> getOutputInfo() const = 0;
  virtual const std::string& inputName(size_t index) const = 0;
  virtual const std::string& outputName(size_t index) const = 0;
  virtual std::vector<OutputTensor> run(const InputTensor& input) = 0;
  virtual std::vector<OutputTensor> run(const std::vector<InputTensor>& inputs) = 0;
  virtual std::vector<OutputTensor> run(const std::vector<InputTensor>& inputs,
                                        const std::vector<std::string>& outputNames) = 0;
  virtual bool isValid() const = 0;
  virtual const std::string& modelPath() const = 0;
};
```

### Tensor types

```cpp
// TensorType enum: FLOAT32, FLOAT16, INT64, INT32, INT8, UINT8

struct TensorInfo { std::string name; std::vector<int64_t> shape; TensorType type; };

struct InputTensor {
  std::string name;
  std::vector<int64_t> shape;
  TensorType type = TensorType::FLOAT32;
  const void* data = nullptr;  // Caller owns memory
  size_t dataSize = 0;         // Size in bytes
};

struct OutputTensor {
  std::string name;
  std::vector<int64_t> shape;
  TensorType type;
  std::vector<uint8_t> data;   // Addon owns copy
  size_t elementCount() const;
  template<typename T> const T* as() const;      // Const typed access
  template<typename T> T* asMutable();            // Mutable typed access
};

size_t tensorTypeSize(TensorType type);  // FLOAT32=4, FLOAT16=2, INT64=8, INT32=4, INT8=1, UINT8=1
```

### Quick example

```cpp
#include <qvac-onnx/OnnxSession.hpp>

onnx_addon::SessionConfig config;
config.provider = onnx_addon::ExecutionProvider::CPU;

onnx_addon::OnnxSession session("model.onnx", config);

auto inputs  = session.getInputInfo();
auto outputs = session.getOutputInfo();

onnx_addon::InputTensor input;
input.name     = inputs[0].name;
input.shape    = {1, 3, 224, 224};
input.type     = onnx_addon::TensorType::FLOAT32;
input.data     = floatData.data();  // Replace with actual data pointer
input.dataSize = floatData.size() * sizeof(float);

auto results = session.run(input);
const float* out = results[0].as<float>();
```

## Consumer Addon Integration

ONNX-based consumer addons (e.g. `ocr-onnx`, `tts`) get `@qvac/onnx` via npm. This single dependency provides the C++ headers, ONNX Runtime headers, CMake targets, and — on mobile (when static linking) — static libraries. On desktop, ORT symbols are resolved at runtime from the shared `@qvac/onnx.bare` (installed as a companion library). Consumer addons do **not** need `onnxruntime` in their own `vcpkg.json`.

See **[INTEGRATION.md](./INTEGRATION.md)** for a step-by-step guide covering `package.json`, `vcpkg.json`, `CMakeLists.txt`, symbol visibility, and platform-specific setup — including a concrete walkthrough of how `@qvac/ocr-onnx` integrates with this package.

## Building

```bash
npm run build          # bare-make generate && bare-make build && bare-make install
```

## Running C++ tests

```bash
npm run test:cpp       # build with -D BUILD_TESTING=ON, then ctest
```

Two test binaries are produced:
- `unit_tests` — pure C++ tests for tensor types, config, and the abstract interface (no ORT dependency)
- `ort_tests` — tests that link ORT: runtime singleton, type conversions, session options, session lifecycle, and the shared-runtime addon scenario

## Platform Support

| Platform | Execution Providers | Triplet |
|----------|-------------------|---------|
| Linux | XNNPack, CPU | `x64-linux` |
| macOS | CoreML, XNNPack, CPU | `arm64-osx` |
| Windows | DirectML, XNNPack, CPU | (default MSVC) |
| Android | NNAPI, XNNPack, CPU | `arm64-android` |
| iOS | CoreML, XNNPack, CPU | `arm64-ios` |
| iOS Sim | CoreML, XNNPack, CPU | `arm64-ios-simulator`, `x64-ios-simulator` |

## License

Apache-2.0
