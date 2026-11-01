# 💥 Breaking Changes v0.10.0

## Remove retired ocr-onnx addon from the monorepo

PR: [#3466](https://github.com/tetherto/qvac/pull/3466)

**BEFORE:**

```typescript
// qvac.config.json — documented but broken since @qvac/sdk 0.15.0
{ "plugins": ["@qvac/sdk/onnx-ocr/plugin"] }
```

**AFTER:**

```typescript
{ "plugins": ["@qvac/sdk/ggml-ocr/plugin"] }
```

---

Related: QVAC-22515 · companion PRs: #3465 (registry deprecation, merged), #3469 (CI retirement, merged). After the registry sync, regenerate the model catalogs (`bun run update-models` in `packages/sdk` and `packages/ai-sdk-provider`) so the 19 dead OCR entries drop out.

---
