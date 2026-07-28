# QVAC OpenClaw Plugin v0.1.2 Release Notes

Release Date: 2026-07-27

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.1.2

This patch keeps OpenClaw's existing tools when QVAC setup runs, and moves the plugin onto `@qvac/ai-sdk-provider` 0.4 and `@qvac/cli` 0.9 so local serves pick up the latest SDK and CLI fixes.

## Preserve Tools During QVAC Setup

Enabling the QVAC provider no longer clears tools already configured in OpenClaw. Setup still registers the local QVAC provider and model catalog, but leaves the agent's tool configuration intact.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.4.0` for the shared model catalog (AI SDK 7 line)
- `@qvac/cli@^0.9.0` for `qvac serve` (SDK 0.16 runtime)

Node.js 22 or newer is required.
