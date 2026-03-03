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

ONNX-based consumer addons (e.g. OCR, TTS) get `@qvac/onnx` via **npm**. This single dependency provides the qvac-onnx C++ headers, the ONNX Runtime headers, static libraries, and cmake targets. Consumer addons do **not** need `onnxruntime` in their own `vcpkg.json`. See [INTEGRATION.md](./INTEGRATION.md) for the full step-by-step guide.

### package.json

```json
{
  "dependencies": {
    "@qvac/onnx": "^0.9.0"
  }
}
```

### CMakeLists.txt

```cmake
find_package(qvac-onnx CONFIG REQUIRED
    PATHS node_modules/@qvac/onnx/prebuilds)

add_bare_module(my-addon EXPORTS)

target_link_libraries(my-addon PRIVATE
    qvac-onnx::qvac-onnx
)
target_compile_definitions(my-addon PRIVATE JS_LOGGER)
```

Linking `qvac-onnx::qvac-onnx` transitively provides the onnxruntime headers and static library. Setting `-DJS_LOGGER` routes ONNX session logs through `qvac-lib-inference-addon-cpp`'s `JsLogger`. Without it, logs go to stdout.

### C++ usage in consumer addon

```cpp
#include <qvac-onnx/OnnxSession.hpp>

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
