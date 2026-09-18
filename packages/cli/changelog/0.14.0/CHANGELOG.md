# Changelog v0.14.0

Release Date: 2026-09-17

## ✨ Features

- Integrate diffusion layer streaming in the SDK. (see PR [#4389](https://github.com/tetherto/qvac/pull/4389)) - See [breaking changes](./breaking.md)

## 🔌 API

- Expose KV-cache reclaim over serve. (see PR [#4249](https://github.com/tetherto/qvac/pull/4249)) - See [API changes](./api.md)
- Integrate MiniMax-H3 video generation across inference and SDK. (see PR [#4351](https://github.com/tetherto/qvac/pull/4351)) - See [API changes](./api.md)
- Close the SDK gaps against @qvac/tts-ggml 0.8.x. (see PR [#4414](https://github.com/tetherto/qvac/pull/4414)) - See [API changes](./api.md)
- Update @qvac/tts-ggml to 0.9.1. (see PR [#4428](https://github.com/tetherto/qvac/pull/4428)) - See [API changes](./api.md)
- Accept tool_choice on the serve OpenAI routes. (see PR [#4524](https://github.com/tetherto/qvac/pull/4524)) - See [API changes](./api.md)

## ⚙️ Infrastructure

- Typecheck CLI push CI against the in-repo SDK on non-release branches. (see PR [#4470](https://github.com/tetherto/qvac/pull/4470))
