# QVAC OpenCode Plugin v0.3.5 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.3.5

This patch moves the OpenCode plugin onto `@qvac/cli` 0.17 and `@qvac/ai-sdk-provider` 0.10.1. Plugin behavior is unchanged.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.10.1` for managed mode, whose optional CLI peer is `^0.17.0`
- `@qvac/cli@^0.17.0` for the managed serve

The two move together. A 0.x caret range does not cross a minor, so `@qvac/cli@^0.16.0` would not install 0.17.
