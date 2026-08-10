# QVAC AI SDK Provider v0.5.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.5.0

This release aligns managed mode with `@qvac/cli` 0.10 / `@qvac/sdk` 0.17 and drops the retired ONNX OCR plugin path from provider-facing guidance in favor of ggml OCR.

## Breaking Changes

### Managed mode requires CLI 0.10

The optional `@qvac/cli` peer for managed mode is now `^0.10.0`. Older CLI minors are no longer accepted, so managed installs resolve the CLI 0.10 / SDK 0.17 runtime.

**Before:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.9.0" } }
```

**After:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.10.0" } }
```

### OCR plugin path

Configs that still reference the retired ONNX OCR plugin must switch to ggml OCR.

**Before:**

```json
{ "plugins": ["@qvac/sdk/onnx-ocr/plugin"] }
```

**After:**

```json
{ "plugins": ["@qvac/sdk/ggml-ocr/plugin"] }
```

## Dependency Alignment

Promote this release after `@qvac/cli` 0.10.0 is on npm.
