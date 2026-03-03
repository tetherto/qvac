# qvac-lib-infer-onnx

Header-only C++ library providing ONNX Runtime session management for QVAC inference addons.

## Overview

This library provides:

- **`IOnnxSession`** - Abstract interface (no ONNX Runtime dependency)
- **`OnnxConfig`** - Session configuration types (no ONNX Runtime dependency)
- **`OnnxTensor`** - Tensor data types (no ONNX Runtime dependency)
- **`OnnxRuntime`** - Singleton ONNX Runtime environment (shared across all sessions)
- **`OnnxSession`** - Concrete session implementation (requires ONNX Runtime)
- **`OnnxSessionOptionsBuilder`** - Platform-aware session options builder (XNNPack enabled by default)
- **`OnnxTypeConversions`** - Conversion between internal and ORT tensor types

## Usage

### vcpkg dependency

Add to your `vcpkg.json`:

```json
{
  "dependencies": [
    {
      "name": "qvac-onnx",
      "version>=": "1.0.0"
    }
  ]
}
```

Consumer addons should **not** add `onnxruntime` as a direct dependency. The base library transitively provides it with the correct platform-specific features including XNNPack.

### CMake

```cmake
find_package(qvac-lib-infer-onnx CONFIG REQUIRED)
target_link_libraries(your_target PRIVATE qvac-lib-infer-onnx::qvac-lib-infer-onnx)
```

### C++ API

```cpp
#include <qvac-lib-infer-onnx/OnnxSession.hpp>

// Create a session
onnx_addon::SessionConfig config{
    .provider = onnx_addon::ExecutionProvider::CPU,
    .optimization = onnx_addon::GraphOptimizationLevel::EXTENDED
};
onnx_addon::OnnxSession session("model.onnx", config);

// Query model info
auto inputs = session.getInputInfo();
auto outputs = session.getOutputInfo();

// Run inference
onnx_addon::InputTensor input{
    .name = "input",
    .shape = {1, 3, 224, 224},
    .type = onnx_addon::TensorType::FLOAT32,
    .data = floatDataPtr,
    .dataSize = totalBytes
};
auto results = session.run(input);
```

### Interface-only usage (no ORT dependency)

Consumers that only need to accept sessions by reference can use the interface headers without pulling in ONNX Runtime:

```cpp
#include <qvac-lib-infer-onnx/IOnnxSession.hpp>

void process(onnx_addon::IOnnxSession& session) {
    auto results = session.run(input);
}
```

### Singleton runtime

All `OnnxSession` instances share a single process-wide `Ort::Env` via `OnnxRuntime::instance()`. This is automatic — consumers do not need to manage the environment. Multiple sessions across different addons loaded in the same process will reuse the same ONNX Runtime environment and thread pools.

### XNNPack

XNNPack is enabled by default for optimized CPU inference on all platforms. To disable it:

```cpp
onnx_addon::SessionConfig config{
    .enableXnnpack = false
};
```

## Headers

| Header | ORT Required | Description |
|--------|-------------|-------------|
| `IOnnxSession.hpp` | No | Abstract session interface |
| `OnnxConfig.hpp` | No | Configuration types |
| `OnnxTensor.hpp` | No | Tensor data types |
| `OnnxRuntime.hpp` | Yes | Singleton ORT environment |
| `OnnxSession.hpp` | Yes | Concrete session (header-only) |
| `OnnxSessionOptionsBuilder.hpp` | Yes | Session options builder + XNNPack |
| `OnnxTypeConversions.hpp` | Yes | Type conversion utilities |

## Platform Support

| Platform | Provider |
|----------|----------|
| Linux | XNNPack, CPU |
| macOS | CoreML, XNNPack, CPU |
| Windows | DirectML, XNNPack, CPU |
| Android | NNAPI, XNNPack, CPU |
| iOS | CoreML, XNNPack, CPU |

## Building

```bash
cmake --preset default -B build
cmake --build build
ctest --test-dir build
```

## License

Apache-2.0
