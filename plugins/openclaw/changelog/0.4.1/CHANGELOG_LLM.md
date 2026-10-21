# QVAC OpenClaw Plugin v0.4.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.4.1

This patch moves the OpenClaw plugin onto `@qvac/ai-sdk-provider` 0.11 and `@qvac/cli` 0.17 so the shared catalog and `qvac serve` line match SDK 0.23.0.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.11.0` for the shared model catalog
- `@qvac/cli@^0.17.0` for `qvac serve --openai --no-default` with `--port 0 --ready-fd 3`

A 0.x caret range does not cross a minor. The published plugin manifest version is now 0.4.1, matching the package.

Plugin behavior is unchanged. No plugin source changed in this release.
