# QVAC OpenCode Plugin v0.3.6 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.3.6

This patch moves the OpenCode plugin onto `@qvac/cli` 0.18 and `@qvac/ai-sdk-provider` 0.11.0. Plugin behavior is unchanged.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.11.0` for managed mode, whose optional CLI peer is `^0.18.0`
- `@qvac/cli@^0.18.0` for the managed serve, which runs on `@qvac/sdk` 0.23

The two move together. A 0.x caret range does not cross a minor, so `@qvac/cli@^0.17.0` would not install 0.18.
