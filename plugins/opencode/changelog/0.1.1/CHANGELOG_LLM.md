# QVAC OpenCode Plugin v0.1.1 Release Notes

Release Date: 2026-07-27

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.1.1

This patch moves the OpenCode plugin onto `@qvac/ai-sdk-provider` 0.4 and `@qvac/cli` 0.9 so managed local serves pick up the AI SDK 7 provider and the latest CLI / SDK fixes.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.4.0` for managed mode
- `@qvac/cli@^0.9.0` for `qvac serve` (SDK 0.16 runtime)
- `@ai-sdk/openai-compatible@^3.0.0` and `ai@^7.0.0` for the AI SDK 7 peer graph

Node.js 22 or newer is required. Plugin behavior is unchanged: the host still starts managed QVAC serve, injects the OpenAI-compatible `qvac` provider, and keeps the existing compatibility shim.
