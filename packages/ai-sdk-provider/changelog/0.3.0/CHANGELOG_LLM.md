# QVAC AI SDK Provider v0.3.0 Release Notes

Release Date: 2026-07-03

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.3.0

## Larger Agent Models in the Catalog

The friendly model catalog now includes larger models aimed at agentic and coding workloads, alongside the existing families:

- `gpt-oss-20b` → `GPT_OSS_20B_INST_Q4_K_M`
- `gemma4-31b` → `GEMMA4_31B_MULTIMODAL_Q4_K_M`
- `qwen3.6-27b` → `QWEN3_6_27B_MULTIMODAL_Q4_K_XL`
- `qwen3.6-35b-a3b` → `QWEN3_6_35B_A3B_MULTIMODAL_Q4_K_M`

These ids resolve to model constants already shipped in `@qvac/sdk` 0.14.x, so `qvac serve` can load them directly. Callers can now select these larger models by friendly id in both catalog UIs and generated serve configs.

## Managed Mode Supports CLI 0.8

`@qvac/ai-sdk-provider` now accepts the `@qvac/cli` `0.8.x` line as its optional managed-mode CLI peer, in addition to `0.6.x` and `0.7.x`. Installing the provider alongside CLI 0.8 resolves to the `@qvac/sdk` 0.14.x runtime, which is where the larger catalog models are available.

## Compatibility

External mode is unchanged and remains the default synchronous path. There are no breaking API changes in this release; the catalog additions are additive and existing model ids continue to resolve as before.
