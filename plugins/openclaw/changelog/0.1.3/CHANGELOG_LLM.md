# QVAC OpenClaw Plugin v0.1.3 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.1.3

This patch moves the OpenClaw plugin onto `@qvac/ai-sdk-provider` 0.5 and `@qvac/cli` 0.10 so local serves pick up the CLI 0.10 / SDK 0.17 runtime.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.5.0` for the shared model catalog
- `@qvac/cli@^0.10.0` for `qvac serve` (SDK 0.17 runtime)

Plugin behavior is unchanged.
