# @qvac/onnx

Bare addon providing ONNX Runtime session management for QVAC inference. Statically links onnxruntime and exposes a session-based JavaScript API. Has no dependency on `qvac-lib-inference-addon-cpp`.

## JS API

### `createSession(modelPath: string, config?: object) → handle`

Creates an ONNX Runtime session for the given model file.

**Config fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `string` | `"auto_gpu"` | Execution provider: `"cpu"`, `"auto_gpu"`, `"nnapi"`, `"coreml"`, `"directml"` |
| `optimization` | `string` | `"extended"` | Graph optimization: `"disable"`, `"basic"`, `"extended"`, `"all"` |
| `intraOpThreads` | `number` | `0` | Intra-op thread count (0 = auto) |
| `interOpThreads` | `number` | `0` | Inter-op thread count (0 = auto) |
| `enableXnnpack` | `boolean` | `true` | Enable XNNPack execution provider |

### `getInputInfo(handle) → Array<{name, shape, type}>`

Returns input tensor metadata for the session.

### `getOutputInfo(handle) → Array<{name, shape, type}>`

Returns output tensor metadata for the session.

### `run(handle, inputs) → Array<{name, shape, type, data}>`

Runs inference. Each input element: `{name: string, shape: number[], type: string, data: TypedArray}`.

Returns output tensors with `data` as the appropriate TypedArray.

### `destroySession(handle)`

Destroys the session and frees resources.

## Consumer Addon Integration

ONNX-based consumer addons (e.g. OCR, TTS) should depend on **both** `qvac-onnx` and `qvac-lib-inference-addon-cpp`:

- `qvac-onnx` provides the ONNX session management (C++ headers + static onnxruntime)
- `qvac-lib-inference-addon-cpp` provides JS binding utilities (`JsUtils.hpp`, `JsLogger`, `JsInterface`)

### vcpkg.json

```json
{
  "dependencies": [
    "qvac-onnx",
    "qvac-lib-inference-addon-cpp"
  ]
}
```

### CMakeLists.txt

```cmake
find_package(onnxruntime CONFIG REQUIRED)
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
          "qvac-lib-inference-addon-cpp/JsInterface.hpp")

add_bare_module(my-addon EXPORTS)

target_include_directories(my-addon PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)
target_link_libraries(my-addon PRIVATE
    onnxruntime::onnxruntime_static
)
target_compile_definitions(my-addon PRIVATE JS_LOGGER)
```

Setting `-DJS_LOGGER` routes ONNX session logs (from the header-only `OnnxSession.hpp`) through `qvac-lib-inference-addon-cpp`'s `JsLogger`, so they appear in the JS logging callback. Without `JS_LOGGER`, ONNX logs go to stdout.

### C++ usage in consumer addon

```cpp
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/Logger.hpp>
#include <qvac-onnx/OnnxSession.hpp>

// Use JsUtils for JS bindings, OnnxSession for inference
onnx_addon::OnnxSession session("model.onnx", config);
auto results = session.run(input);
```

## Building

```bash
npm run build
```

## Running C++ tests

```bash
npm run test:cpp
```

## Platform Support

| Platform | Provider |
|----------|----------|
| Linux | XNNPack, CPU |
| macOS | CoreML, XNNPack, CPU |
| Windows | DirectML, XNNPack, CPU |
| Android | NNAPI, XNNPack, CPU |
| iOS | CoreML, XNNPack, CPU |

## License

Apache-2.0
