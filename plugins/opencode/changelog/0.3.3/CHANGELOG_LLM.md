# QVAC OpenCode Plugin v0.3.3 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.3.3

This patch moves the OpenCode plugin onto `@qvac/ai-sdk-provider` 0.9 and `@qvac/cli` 0.15, so managed installs resolve a provider and CLI that agree on the SDK 0.21 line.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.9.0` for managed mode, which narrows its optional CLI peer to `^0.15.0`
- `@qvac/cli@^0.15.0` for that serve

The two floors have to move together. A 0.x caret range does not cross a minor, so `@qvac/cli@^0.14.0` will not install 0.15.

Plugin behavior is unchanged. No plugin source changed in this release.
