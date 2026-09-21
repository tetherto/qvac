# QVAC OpenCode Plugin v0.1.2 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.1.2

This patch moves the OpenCode plugin onto `@qvac/ai-sdk-provider` 0.5 and `@qvac/cli` 0.10 so managed local serves pick up the CLI 0.10 / SDK 0.17 runtime.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.5.0` for managed mode
- `@qvac/cli@^0.10.0` for `qvac serve` (SDK 0.17 runtime)

Plugin behavior is unchanged: the host still starts managed QVAC serve, injects the OpenAI-compatible `qvac` provider, and keeps the existing compatibility shim.
