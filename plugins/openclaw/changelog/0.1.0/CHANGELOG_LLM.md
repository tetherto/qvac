# QVAC OpenClaw Plugin v0.1.0 Release Notes

Release Date: 2026-07-03

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.1.0

The first public release of `@qvac/openclaw-plugin` — an [OpenClaw](https://openclaw.ai) provider plugin that runs a local, fully managed QVAC serve so OpenClaw works against on-device models with no separate server to start.

## Local QVAC Provider for OpenClaw

The plugin registers a `qvac` provider that OpenClaw drives through its `localService` launcher. On use it starts `qvac serve` on a loopback port, exposes an OpenAI-compatible endpoint, waits for it to become healthy, and reaps it on OpenClaw's idle/exit lifecycle. It also contributes OpenClaw wizard and model-picker entries so QVAC can be selected like any other provider.

## Model Catalog With Larger Agent Models

The plugin ships a static model catalog using models.dev-style ids, resolving each friendly id to its `@qvac/sdk` model constant through `@qvac/ai-sdk-provider`'s shared catalog. Alongside the Qwen3.5 line it exposes the larger agent-oriented families — `qwen3.6-27b`, `qwen3.6-35b-a3b`, `gpt-oss-20b`, and `gemma4-31b` — which resolve to model constants shipped in `@qvac/sdk` 0.14.x. The default model is `qwen3.5-9b`.

## Requirements

This release targets the current agent stack: `@qvac/ai-sdk-provider` `^0.3.0` (shared catalog and managed serve), `@qvac/cli` `^0.8.0` (runs `qvac serve` on the SDK 0.14.x runtime), and `openclaw` `>=2026.6.0` as the optional host peer.
