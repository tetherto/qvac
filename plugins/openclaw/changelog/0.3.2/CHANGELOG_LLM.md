# QVAC OpenClaw Plugin v0.3.2 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.3.2

This patch moves the OpenClaw plugin onto `@qvac/ai-sdk-provider` 0.8 and `@qvac/cli` 0.14 so the shared catalog and `qvac serve` line match SDK 0.20.0.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.8.0` for the shared model catalog
- `@qvac/cli@^0.14.0` for `qvac serve --openai --no-default`

A 0.x caret range does not cross a minor. Publish after provider 0.8.0 and CLI 0.14.0 are on npm.

Plugin behavior is unchanged.
