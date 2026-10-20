# QVAC OpenCode Plugin v0.3.4 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.3.4

This patch moves the OpenCode plugin onto `@qvac/ai-sdk-provider` 0.10 and `@qvac/cli` 0.16, so managed installs resolve a provider and CLI that agree on the SDK 0.22 line.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.10.0` for managed mode, which narrows its optional CLI peer to `^0.16.0`
- `@qvac/cli@^0.16.0` for that serve

The two floors have to move together. A 0.x caret range does not cross a minor, so `@qvac/cli@^0.15.0` will not install 0.16.

Plugin behavior is unchanged. No plugin source changed in this release.
