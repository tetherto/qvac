# QVAC OpenClaw Plugin v0.3.4 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.3.4

This patch moves the OpenClaw plugin onto `@qvac/ai-sdk-provider` 0.9 and `@qvac/cli` 0.15 so the shared catalog and `qvac serve` line match SDK 0.21.0.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.9.0` for the shared model catalog
- `@qvac/cli@^0.15.0` for `qvac serve --openai --no-default`

A 0.x caret range does not cross a minor. Publish after provider 0.9.0 and CLI 0.15.0 are on npm.

Plugin behavior is unchanged.
