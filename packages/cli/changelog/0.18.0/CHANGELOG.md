# Changelog v0.18.0

Release Date: 2026-10-29

## ✨ Features

- Leave `parallel_tool_calls` to the SDK when a request omits it; SDK 0.23 defaults it to true. (see PR [#5283](https://github.com/tetherto/qvac/pull/5283))

## 🔌 API

- Surface context overflow and close failed HTTP streams. (see PR [#4834](https://github.com/tetherto/qvac/pull/4834)) - See [breaking changes](./breaking.md) and [API changes](./api.md)
- Assess ESRGAN and ABot world memory fit. (see PR [#5038](https://github.com/tetherto/qvac/pull/5038)) - See [API changes](./api.md)
- Serve OCR on /qvac/v1/ocr. (see PR [#5290](https://github.com/tetherto/qvac/pull/5290)) - See [API changes](./api.md)
- Support Qwen-Image-2.1 generation and reference editing. (see PR [#5302](https://github.com/tetherto/qvac/pull/5302)) - See [breaking changes](./breaking.md) and [API changes](./api.md)
- Serve image classification on /qvac/v1/classifications. (see PR [#5317](https://github.com/tetherto/qvac/pull/5317)) - See [API changes](./api.md)
- Serve image upscale on /qvac/v1/images/upscale. (see PR [#5318](https://github.com/tetherto/qvac/pull/5318)) - See [API changes](./api.md)
- Serve music generation, edits and understanding on /qvac/v1/audio. (see PR [#5355](https://github.com/tetherto/qvac/pull/5355)) - See [API changes](./api.md)
- Serve the live model registry on /qvac/v1/registry. (see PR [#5356](https://github.com/tetherto/qvac/pull/5356)) - See [breaking changes](./breaking.md) and [API changes](./api.md)

## 🐞 Fixes

- Keep private parameter values out of HTTP warnings. (see PR [#4833](https://github.com/tetherto/qvac/pull/4833))
- Surface worker startup failures in HTTP responses. (see PR [#4921](https://github.com/tetherto/qvac/pull/4921))
- Declare tools loaded by tool_search in the tools block. (see PR [#5346](https://github.com/tetherto/qvac/pull/5346)) - See [breaking changes](./breaking.md)

## 📦 Dependencies

- Move `@qvac/sdk` to `^0.23.0`. The registry routes need `ModelRegistryModelNotFoundError`, which SDK 0.22 does not have. - See [breaking changes](./breaking.md)
