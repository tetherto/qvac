# QVAC OpenClaw Plugin v0.4.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.4.1

This patch moves the OpenClaw plugin onto `@qvac/cli` 0.17 and `@qvac/ai-sdk-provider` 0.10.1. Plugin behavior is unchanged.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.10.1` for the shared model catalog
- `@qvac/cli@^0.17.0` for `qvac serve --openai --no-default`

A 0.x caret range does not cross a minor, so `@qvac/cli@^0.16.0` would not install 0.17. The plugin manifest version is now 0.4.1, matching the package.
