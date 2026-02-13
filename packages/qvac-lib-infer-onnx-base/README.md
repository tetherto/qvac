# qvac-lib-infer-onnx-base

Header-only C++ library providing ONNX Runtime session management for QVAC inference addons.

## Overview

This library provides:

- **`IOnnxSession`** - Abstract interface (no ONNX Runtime dependency)
- **`OnnxConfig`** - Session configuration types (no ONNX Runtime dependency)
- **`OnnxTensor`** - Tensor data types (no ONNX Runtime dependency)
- **`OnnxSession`** - Concrete session implementation (requires ONNX Runtime)
- **`OnnxSessionOptionsBuilder`** - Platform-aware session options builder
- **`OnnxTypeConversions`** - Conversion between internal and ORT tensor types

## Usage

### vcpkg dependency

Add to your `vcpkg.json`:

```json
{
  "dependencies": [
    {
      "name": "qvac-lib-infer-onnx-base",
      "version>=": "1.0.0"
    }
  ]
}
```

### CMake

```cmake
find_package(qvac-lib-infer-onnx-base CONFIG REQUIRED)
target_link_libraries(your_target PRIVATE qvac-lib-infer-onnx-base::qvac-lib-infer-onnx-base)
```

### C++ API

```cpp
#include <qvac-lib-infer-onnx-base/OnnxSession.hpp>

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
#include <qvac-lib-infer-onnx-base/IOnnxSession.hpp>

void process(onnx_addon::IOnnxSession& session) {
    auto results = session.run(input);
}
```

## Headers

| Header | ORT Required | Description |
|--------|-------------|-------------|
| `IOnnxSession.hpp` | No | Abstract session interface |
| `OnnxConfig.hpp` | No | Configuration types |
| `OnnxTensor.hpp` | No | Tensor data types |
| `OnnxSession.hpp` | Yes | Concrete session (header-only) |
| `OnnxSessionOptionsBuilder.hpp` | Yes | Session options builder |
| `OnnxTypeConversions.hpp` | Yes | Type conversion utilities |

## Platform Support

| Platform | Provider |
|----------|----------|
| Linux | CPU |
| macOS | CPU, CoreML |
| Windows | CPU, DirectML |
| Android | CPU, NNAPI |
| iOS | CPU, CoreML |

## Building

```bash
cmake --preset default
cmake --build build
ctest --test-dir build
```

## License

Apache-2.0
