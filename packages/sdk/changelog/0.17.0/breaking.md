# 💥 Breaking Changes v0.17.0

## Refresh SDK model constants from registry

PR: [#3488](https://github.com/tetherto/qvac/pull/3488)

Legacy ONNX OCR constants are removed. The SDK swapped the ONNX OCR engine for GGML-OCR earlier, and the registry deprecated these models, but they were still exported.

**BEFORE:**

```typescript
import { OCR_CRAFT_DETECTOR, OCR_LATIN_RECOGNIZER } from '@qvac/sdk'
```

**AFTER:**

```typescript
// GGML-OCR equivalents, already shipping
import { OCR_CRAFT, OCR_LATIN } from '@qvac/sdk'
```

Migration notes:

- `OCR_CRAFT_DETECTOR` → `OCR_CRAFT`, `OCR_LATIN_RECOGNIZER` → `OCR_LATIN`
- `OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL` → `OCR_DOCTR`, `OCR_DETECTOR_DB_MOBILENET_V3_LARGE` → `OCR_DOCTR_1`
- The non-Latin per-script recognizers (Arabic, Bengali, Cyrillic, Devanagari, Japanese, Kannada, Korean, Tamil, Telugu, Thai, Chinese) have **no** GGML replacement today. Consumers relying on those scripts should track the GGML-OCR coverage work before upgrading.

---

## Add Wan 2.2 video support

PR: [#3529](https://github.com/tetherto/qvac/pull/3529)

Wan 2.2 A14B-only options are no longer accepted for single-expert models such as TI2V-5B. These requests now fail validation before generation.

**BEFORE:**

```typescript
// TI2V-5B has no high-noise expert, but the SDK accepted and forwarded
// this unsupported A14B-only option to the native backend.
const { outputs } = video({
  modelId: ti2vModelId,
  mode: 'txt2vid',
  prompt: 'A running fox',
  high_noise_steps: 8
})

await outputs
```

**AFTER:**

```typescript
// This request now fails validation because TI2V-5B is single-expert.
const { outputs } = video({
  modelId: ti2vModelId,
  mode: 'txt2vid',
  prompt: 'A running fox',
  high_noise_steps: 8
})

await outputs // Throws PluginRequestValidationFailedError before generation.

// Migration: omit all high_noise_* and moe_boundary options for TI2V-5B.
const { outputs: validOutputs } = video({
  modelId: ti2vModelId,
  mode: 'txt2vid',
  prompt: 'A running fox',
  steps: 4,
  cfg_scale: 1
})

await validOutputs
```

---
