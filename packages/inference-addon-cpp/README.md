# qvac-lib-inference-addon-cpp

**Version:** 1.1.0  
**Technology Stack:** C++20, CMake, vcpkg, Bare Runtime  
**Package Type:** Header-only C++ library

A header-only C++ library that provides common abstractions and infrastructure for building high-performance inference addons on the Bare runtime. This library serves as the foundational framework for QVAC inference addons, handling the complexity of JavaScript-C++ bridging, asynchronous job processing, model lifecycle management, and streaming model weight loading.

## Key Features

- **Simple addon framework** with `process(std::any)` interface for flexible model implementations
- **Single job runner** with cancellation support on a dedicated processing thread
- **Streaming weight loader** for efficient loading of large model files (including sharded GGUF models)
- **JavaScript-C++ bridge** with comprehensive type marshalling and error handling
- **Output handlers** for flexible output type conversion
- **Thread-safe logging** infrastructure with optional JavaScript callback integration

## Ecosystem Position

This library sits between the Bare runtime and specific inference addons. Communication between JavaScript and native code is mediated by Bare runtime's native addon API.

**Consumer Addons** (built on this library):
- [qvac-lib-infer-llamacpp-llm](https://github.com/tetherto/qvac-lib-infer-llamacpp-llm) - LLM inference
- [qvac-lib-infer-whispercpp](https://github.com/tetherto/qvac-lib-infer-whispercpp) - Speech recognition
- [qvac-lib-infer-nmtcpp](https://github.com/tetherto/qvac-lib-infer-nmtcpp) - Neural translation
- [qvac-lib-infer-onnx-tts](https://github.com/tetherto/qvac-lib-infer-onnx-tts) - Text-to-speech
- [qvac-lib-infer-llamacpp-embed](https://github.com/tetherto/qvac-lib-infer-llamacpp-embed) - Embeddings
- [qvac-lib-inference-addon-onnx-ocr-fasttext](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext) - OCR

## Table of Contents

- [Installation](#installation)  
- [Usage](#usage)  
- [Quickstart Example](#quickstart-example)
- [Common Gotchas](#common-gotchas)
- [Platform-Specific Constraints](#platform-specific-constraints)
- [Development](#development)
- [Architecture Documentation](#architecture-documentation)
- [Glossary](#glossary)  
- [Resources](#resources)  
- [License](#license)

## Installation

### Prerequisites

- vcpkg installed and `VCPKG_ROOT` set (see vcpkg docs)

### Platform Requirements

- **CMake:** >= 3.25
- **C++ Standard:** C++20
- **Compilers:** 
  - macOS: Xcode Command Line Tools
  - Linux: Clang/LLVM 19 with libc++
  - Windows: Visual Studio 2022 with C++ workload
- **vcpkg:** For C++ dependency management

### Integration

This is a header-only library. Include it in your addon's `vcpkg.json`:

```json
{
  "dependencies": [
    {
      "name": "qvac-lib-inference-addon-cpp",
      "version>=": "1.1.0"
    }
  ]
}
```

In your CMake configuration:

```cmake
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/JsInterface.hpp")

add_bare_module(module_name)

target_include_directories(
  ${module_name}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)
```

Then in your C++ code:

```cpp
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>
#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
```

## Usage

### Building an Inference Addon

1. **Implement the model interface** with `process(std::any)`:

```cpp
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>

class MyModel : public model::IModel {
public:
  std::string getName() const override { return "MyModel"; }
  RuntimeStats runtimeStats() const override { return {}; }
  
  std::any process(const std::any& input) override {
    auto text = std::any_cast<std::string>(input);
    std::string result = doInference(text);
    return std::any(result);
  }
};
```

2. **Create the addon** with output handlers:

```cpp
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp>

using namespace qvac_lib_inference_addon_cpp;

// Set up output handler
auto handler = std::make_shared<
    out_handl::CppContainerOutputHandler<std::set<std::string>>>();

out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>> outputHandlers;
outputHandlers.add(handler);

auto outputCallback = std::make_unique<OutputCallBackCpp>(std::move(outputHandlers));

// Create addon
auto addon = std::make_unique<AddonCpp>(
    std::move(outputCallback),
    std::make_unique<MyModel>()
);

addon->activate();
addon->runJob(std::any(std::string("Hello")));
```

For more details, see [docs/usage.md](docs/usage.md).

### JavaScript API

The authoritative API surface is defined in `src/qvac-lib-inference-addon-cpp/JsInterface.hpp`. Example usage:

```javascript
const addon = require('./my-addon')

// Create instance
const handle = addon.createInstance(
  config,          // { path: '/model/path', config: {...} }
  outputCallback   // (handle, event, data, error) => {}
)

// Load model weights (streaming)
for (const chunk of modelChunks) {
  addon.loadWeights(handle, chunk)
}

// Activate processing
addon.activate(handle)

// Run a job
addon.runJob(handle, { type: 'text', input: 'Hello world' })

// Cancel current job (returns a Promise)
await addon.cancelJob(handle)

// Cleanup
addon.destroyInstance(handle)
```

### C++ Logger

The C++ logger is thread-safe and can send logs to JavaScript or stdout.

**On JavaScript side:**
```javascript
addon.setLogger(...)  // Set up JS callback for logs
addon.releaseLogger() // Clean up logger
```

**On C++ side:**
```cpp
Logger::log(Logger::Level::DEBUG, "hello from C++");
QLOG(Logger::Level::DEBUG, "hello from C++");  // Macro version
```

## Quickstart Example

Build and run C++ tests using CMake and vcpkg:

```bash
cd qvac-lib-inference-addon-cpp

# Configure
cmake -S . -B build \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTING=ON

# Build
cmake --build build --config Release

# Test
ctest --test-dir build --output-on-failure
```

## Common Gotchas

### 1. Must Call `activate()` After `loadWeights()`

❌ **Wrong** - no output will be produced:
```javascript
addon.loadWeights(handle, weights)
addon.runJob(handle, { type: 'text', input: 'test' })
```

✅ **Correct**:
```javascript
addon.loadWeights(handle, weights)
addon.activate(handle)  // Ensures model is ready
addon.runJob(handle, { type: 'text', input: 'test' })
```

### 2. Output Callback Must Be Fast

The callback runs on the JavaScript event loop. Blocking operations stall all addons.

❌ **Wrong** - blocks event loop:
```javascript
function onOutput(handle, event, data, error) {
  fs.writeFileSync('output.txt', data)  // Synchronous I/O
}
```

✅ **Correct** - queue work asynchronously:
```javascript
function onOutput(handle, event, data, error) {
  setImmediate(() => fs.writeFile('output.txt', data))
}
```

### 3. One Job at a Time

The framework processes one job at a time. If you need to queue multiple jobs, manage the queue in your application code.

---

## Platform-Specific Constraints

### Mobile Platforms (iOS/Android)

#### Background Execution
Apps may suspend during processing:
- **Workaround:** Cancel pending jobs on `suspend` event

```javascript
process.on('suspend', async () => {
  await addon.cancelJob(handle)
})
```

#### Memory Pressure
Large models may trigger OS kills:
- **Workaround:** Use smaller quantized models on mobile

### Windows

#### Long Paths
- **Issue:** Windows has 260-character path limit by default
- **Workaround:** Enable long path support:
  ```bash
  git config --system core.longpaths true
  ```

---

## Development

### Building the Library

1. **Clone the repository:**
   ```bash
   git clone https://github.com/tetherto/qvac-lib-inference-addon-cpp.git
   cd qvac-lib-inference-addon-cpp
   ```

2. **Configure with vcpkg toolchain:**
   ```bash
   cmake -S . -B build \
     -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
     -DCMAKE_BUILD_TYPE=Release \
     -DBUILD_TESTING=ON
   ```

3. **Build:**
   ```bash
   cmake --build build --config Release
   ```

### Running Tests

```bash
ctest --test-dir build --output-on-failure
```

## Architecture Documentation

- **[docs/architecture.md](docs/architecture.md)** - Complete architecture documentation
- **[docs/data-flows-detailed.md](docs/data-flows-detailed.md)** - Detailed data flow diagrams
- **[docs/usage.md](docs/usage.md)** - Usage guide

## Glossary

* [**Bare**](https://github.com/holepunchto/bare) – A lightweight, modular JavaScript runtime for desktop and mobile.
* **QVAC** – Our decentralized AI SDK for building runtime-portable inference apps.

## References

### Documentation

- **Bare Runtime Documentation:** https://github.com/holepunchto/bare
- **Bare Native Addons Guide:** https://github.com/holepunchto/bare#addon

### Consumer Addons

Production addons built on this library:
- [qvac-lib-infer-llamacpp-llm](https://github.com/tetherto/qvac-lib-infer-llamacpp-llm) - LLM inference
- [qvac-lib-infer-whispercpp](https://github.com/tetherto/qvac-lib-infer-whispercpp) - Speech recognition
- [qvac-lib-infer-nmtcpp](https://github.com/tetherto/qvac-lib-infer-nmtcpp) - Neural translation
- [qvac-lib-infer-onnx-tts](https://github.com/tetherto/qvac-lib-infer-onnx-tts) - Text-to-speech
- [qvac-lib-infer-llamacpp-embed](https://github.com/tetherto/qvac-lib-infer-llamacpp-embed) - Embeddings
- [qvac-lib-inference-addon-onnx-ocr-fasttext](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext) - OCR

### Dependencies

- [qvac-lint-cpp](https://github.com/tetherto/qvac-lint-cpp) - Code quality tools

### External Resources

- **GitHub Repository:** [tetherto/qvac-lib-inference-addon-cpp](https://github.com/tetherto/qvac-lib-inference-addon-cpp)
- **vcpkg:** https://vcpkg.io/
- **CMake Documentation:** https://cmake.org/documentation/
- **libuv Documentation:** https://docs.libuv.org/

## License

This project is licensed under the Apache-2.0 License – see the [LICENSE](LICENSE) file for details.

*For questions or issues, please open an issue on the GitHub repository.*
