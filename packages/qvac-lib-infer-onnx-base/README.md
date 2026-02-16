# @qvac/onnx-addon

A shared ONNX Runtime wrapper addon for Bare. Enables multiple addons to share ONNX sessions without duplicating the runtime or model memory.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        JavaScript                            │
│                                                              │
│   const session = createSession('model.onnx', config)       │
│                            │                                 │
└────────────────────────────┼─────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                     ONNX Addon                               │
│                                                              │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    │
│   │   Session   │    │   Session   │    │   Session   │    │
│   │  (cached)   │    │  (cached)   │    │  (cached)   │    │
│   │  refCount:2 │    │  refCount:1 │    │  refCount:3 │    │
│   └─────────────┘    └─────────────┘    └─────────────┘    │
│          │                                    │             │
│          └────────────────┬───────────────────┘             │
│                           │                                  │
│                    ┌──────┴──────┐                          │
│                    │ ONNX Runtime │                          │
│                    │   (shared)   │                          │
│                    └─────────────┘                          │
└─────────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
       ┌───────────┐  ┌───────────┐  ┌───────────┐
       │ OCR Addon │  │ TTS Addon │  │ Other...  │
       │           │  │           │  │           │
       │ IOnnxSession* (virtual dispatch)       │
       └───────────┘  └───────────┘  └───────────┘
```

**Key benefits:**
- Single ONNX Runtime instance shared across all addons
- Session caching with reference counting
- No symbol linking required between addons (virtual dispatch)
- Memory efficient - same model loaded once

## Installation

```bash
npm install @qvac/onnx-addon
```

## JavaScript API

### Creating Sessions

```javascript
const { createSession, destroySession, getCacheStats } = require('@qvac/onnx-addon')

// Create a session (or reuse from cache if same path + config)
const session = createSession(modelPath, config)

// Config options (all optional):
const config = {
  provider: 'auto_gpu',    // 'cpu', 'auto_gpu', 'nnapi', 'coreml', 'directml'
  optimization: 'extended', // 'disable', 'basic', 'extended', 'all'
  intraOpThreads: 0,        // 0 = auto
  interOpThreads: 0,        // 0 = auto
  enableMemoryPattern: true,
  enableCpuMemArena: true
}
```

### Model Introspection

```javascript
const { getInputInfo, getOutputInfo } = require('@qvac/onnx-addon')

// Get input tensor info
const inputs = getInputInfo(session)
// Returns: [{ name: 'input', shape: [1, 3, 224, 224], type: 'float32' }]

// Get output tensor info
const outputs = getOutputInfo(session)
// Returns: [{ name: 'output', shape: [1, 1000], type: 'float32' }]
```

### Running Inference

```javascript
const { run } = require('@qvac/onnx-addon')

const results = run(session, [
  {
    name: 'input',
    shape: [1, 3, 224, 224],
    type: 'float32',
    data: new Float32Array(1 * 3 * 224 * 224)
  }
])

// Returns: [{ name: 'output', shape: [...], type: 'float32', data: Float32Array }]
```

### Session Lifecycle

```javascript
// Sessions are reference-counted and cached
const s1 = createSession('model.onnx', { provider: 'cpu' })
const s2 = createSession('model.onnx', { provider: 'cpu' })  // Reuses s1, refCount=2

// Mark session for cleanup (actual cleanup on GC)
destroySession(s1)  // refCount=1
destroySession(s2)  // refCount=0, session deleted
```

### Cache Statistics

```javascript
const { getCacheStats } = require('@qvac/onnx-addon')

console.log(getCacheStats())
// {
//   sessionCount: 2,
//   sessions: [
//     { key: 'model.onnx|p=0|o=2|...', modelPath: 'model.onnx', refCount: 2 },
//     { key: 'other.onnx|p=0|o=2|...', modelPath: 'other.onnx', refCount: 1 }
//   ]
// }
```

## C++ API (For Other Addons)

Other addons can use ONNX sessions without linking to this addon. Sessions are passed as JS externals and unwrapped using virtual dispatch.

### Include Headers

```cpp
#include <onnx-addon/IOnnxSession.hpp>    // Abstract interface
#include <onnx-addon/OnnxTensor.hpp>      // Tensor types
#include <onnx-addon/JsOnnxSession.hpp>   // Unwrap helper (header-only)
```

### Unwrap Session from JS

```cpp
// In your addon's JS interface:
void createInstance(js_env_t* env, js_value_t* jsSessionExternal) {
    // Unwrap - this is header-only, no linking needed
    onnx_addon::IOnnxSession* session =
        onnx_addon::js::unwrapSession(env, jsSessionExternal);

    // Use session via virtual dispatch
    auto inputs = session->getInputInfo();
    auto outputs = session->getOutputInfo();
}
```

### Run Inference

```cpp
// Create input tensor
onnx_addon::InputTensor input{
    .name = "input",
    .shape = {1, 3, 224, 224},
    .type = onnx_addon::TensorType::FLOAT32,
    .data = floatDataPtr,
    .dataSize = totalBytes
};

// Run inference
std::vector<onnx_addon::OutputTensor> results = session->run({input});

// Or specify which outputs you want
std::vector<onnx_addon::OutputTensor> results =
    session->run({input}, {"output1", "output2"});

// Access results
for (const auto& output : results) {
    std::cout << "Name: " << output.name << std::endl;
    std::cout << "Shape: " << output.shape[0] << "x" << output.shape[1] << std::endl;

    // Get data as float pointer
    const float* data = reinterpret_cast<const float*>(output.data.data());
}
```

### Tensor Types

```cpp
enum class TensorType {
    FLOAT32,
    FLOAT16,
    INT64,
    INT32,
    INT8,
    UINT8
};
```

### CMake Integration

In your addon's `CMakeLists.txt`:

```cmake
# Add ONNX addon headers (no linking required)
set(ONNX_ADDON_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../node_modules/@qvac/onnx-addon/prebuilds/include")
target_include_directories(${YOUR_ADDON} PRIVATE ${ONNX_ADDON_INCLUDE_DIR})
```

## Session Caching

Sessions are cached by a key composed of:
- Model path
- Execution provider
- Optimization level
- Thread counts
- Memory settings

```
Cache Key Format:
{modelPath}|p={provider}|o={optimization}|intra={threads}|inter={threads}|mem={0|1}|arena={0|1}
```

**Same key = same session (reference counted)**

```javascript
// These share the same session:
createSession('model.onnx', { provider: 'cpu' })
createSession('model.onnx', { provider: 'cpu' })

// This creates a new session (different threads):
createSession('model.onnx', { provider: 'cpu', intraOpThreads: 4 })
```

## Example: OCR Addon Integration

```javascript
// ocr-addon/index.js
const { createSession, destroySession } = require('@qvac/onnx-addon')

class OcrAddon {
  async load(detectorPath, recognizerPath) {
    // Create sessions (will be cached and shared)
    this.detectorSession = createSession(detectorPath, { provider: 'auto_gpu' })
    this.recognizerSession = createSession(recognizerPath, { provider: 'auto_gpu' })

    // Pass to native addon
    this.addon = createNativeAddon({
      detectorSession: this.detectorSession,
      recognizerSession: this.recognizerSession
    })
  }

  async unload() {
    destroySession(this.detectorSession)
    destroySession(this.recognizerSession)
  }
}
```

```cpp
// ocr-addon/native.cpp
#include <onnx-addon/IOnnxSession.hpp>
#include <onnx-addon/JsOnnxSession.hpp>

void createInstance(js_env_t* env, js_value_t* config) {
    // Unwrap sessions from JS
    auto* detector = onnx_addon::js::unwrapSession(env, getProperty(config, "detectorSession"));
    auto* recognizer = onnx_addon::js::unwrapSession(env, getProperty(config, "recognizerSession"));

    // Use via virtual dispatch - no linking to onnx-addon needed
    auto detectorInputs = detector->getInputInfo();
    auto results = detector->run(inputTensor);
}
```

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
npm install
bare-make generate
bare-make build
bare-make install
```

## License

Apache-2.0
