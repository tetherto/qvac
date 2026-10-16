# QVAC Inference v0.21.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.21.1

QVAC Inference 0.21.1 updates the native add-on peer ranges to accept the corrected backend patches. The same ranges are used for development dependencies, so the declared compatibility and the development installation stay aligned.

## Bug Fixes

### Native add-on patch updates

The minimum backend versions are listed below. Each dependency uses a caret range, such as `^0.55.2` for `@qvac/llm-llamacpp`, allowing later patches within that backend minor line.

| Add-on                      | Minimum version |
| --------------------------- | --------------- |
| `@qvac/asr-ggml`            | `0.7.1`         |
| `@qvac/audiogen-ggml`       | `0.5.2`         |
| `@qvac/bci-whispercpp`      | `0.10.2`        |
| `@qvac/classification-ggml` | `0.28.2`        |
| `@qvac/diffusion-cpp`       | `0.26.1`        |
| `@qvac/embed-llamacpp`      | `0.43.2`        |
| `@qvac/ggml-rpc-server`     | `0.1.2`         |
| `@qvac/llm-llamacpp`        | `0.55.2`        |
| `@qvac/ocr-ggml`            | `0.26.2`        |
| `@qvac/translation-nmtcpp`  | `0.18.2`        |
| `@qvac/tts-ggml`            | `0.10.2`        |
| `@qvac/vla-ggml`            | `0.29.2`        |

The patch keeps the existing SDK APIs, model catalog and native runtime family. Update the application lockfile and rebuild native application bundles to include the new binaries.
