# Changelog

## [0.1.1]

Release Date: 2026-07-07

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.1.1

The first public npm release of `@qvac/openclaw-plugin` — an [OpenClaw](https://openclaw.ai) provider plugin that runs a local, fully managed QVAC serve so OpenClaw works against on-device models with no separate server to start.

### Added

- **Local QVAC provider for OpenClaw.** Registers a `qvac` provider that OpenClaw drives through its `localService` launcher: the plugin starts `qvac serve` on a loopback port, exposes an OpenAI-compatible endpoint, waits for it to become healthy, and tears it down on OpenClaw's idle/exit lifecycle.
- **Friendly model catalog.** Ships a static model catalog and OpenClaw wizard/model-picker entries using models.dev-style ids (e.g., `qwen3.5-9b`), with the friendly-id → QVAC constant mapping resolved through [`@qvac/ai-sdk-provider`](https://www.npmjs.com/package/@qvac/ai-sdk-provider)'s shared catalog. Defaults to `qwen3.5-9b`.
- **Larger agent models.** The catalog includes the larger agent-oriented families in addition to the Qwen3.5 line: `qwen3.6-27b`, `qwen3.6-35b-a3b`, `gpt-oss-20b`, and `gemma4-31b`, each mapped to its `@qvac/sdk` model constant.
- **Layered configuration.** A `configSchema` resolves options from plugin config and defaults: `model`, `host`, `port`, `baseUrl`, `apiKey`, `qvacCommand`, `cwd`, `ctxSize`, `reasoningBudget`, `tools`, `readyTimeoutMs`, `idleStopMs`, and `timeoutSeconds`.

### Requirements

- [`@qvac/ai-sdk-provider@^0.3.0`](https://www.npmjs.com/package/@qvac/ai-sdk-provider) for the shared model catalog and managed serve.
- [`@qvac/cli@^0.8.0`](https://www.npmjs.com/package/@qvac/cli) so the local service can run `qvac serve` (SDK 0.14.x runtime).
- [`openclaw@>=2026.6.0`](https://www.npmjs.com/package/openclaw) as the host (optional peer).

## [0.1.0]

Release Date: 2026-07-03

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.1.0

The first public release of `@qvac/openclaw-plugin` — an [OpenClaw](https://openclaw.ai) provider plugin that runs a local, fully managed QVAC serve so OpenClaw works against on-device models with no separate server to start.

### Added

- **Local QVAC provider for OpenClaw.** Registers a `qvac` provider that OpenClaw drives through its `localService` launcher: the plugin starts `qvac serve` on a loopback port, exposes an OpenAI-compatible endpoint, waits for it to become healthy, and tears it down on OpenClaw's idle/exit lifecycle.
- **Friendly model catalog.** Ships a static model catalog and OpenClaw wizard/model-picker entries using models.dev-style ids (e.g. `qwen3.5-9b`), with the friendly-id → QVAC constant mapping resolved through [`@qvac/ai-sdk-provider`](https://www.npmjs.com/package/@qvac/ai-sdk-provider)'s shared catalog. Defaults to `qwen3.5-9b`.
- **Larger agent models.** The catalog includes the larger agent-oriented families in addition to the Qwen3.5 line: `qwen3.6-27b`, `qwen3.6-35b-a3b`, `gpt-oss-20b`, and `gemma4-31b`, each mapped to its `@qvac/sdk` model constant.
- **Layered configuration.** A `configSchema` resolves options from plugin config and defaults: `model`, `host`, `port`, `baseUrl`, `apiKey`, `qvacCommand`, `cwd`, `ctxSize`, `reasoningBudget`, `tools`, `readyTimeoutMs`, `idleStopMs`, and `timeoutSeconds`.

### Requirements

- [`@qvac/ai-sdk-provider@^0.3.0`](https://www.npmjs.com/package/@qvac/ai-sdk-provider) for the shared model catalog and managed serve.
- [`@qvac/cli@^0.8.0`](https://www.npmjs.com/package/@qvac/cli) so the local service can run `qvac serve` (SDK 0.14.x runtime).
- [`openclaw@>=2026.6.0`](https://www.npmjs.com/package/openclaw) as the host (optional peer).
