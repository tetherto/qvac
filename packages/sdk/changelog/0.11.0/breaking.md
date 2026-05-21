# 💥 Breaking Changes v0.11.0

## Migrate SDK parakeet plugin to 0.4.0 GGML + duplex streaming

PR: [#2018](https://github.com/tetherto/qvac/pull/2018)

**BEFORE:**
**

```typescript
await loadModel({
  modelSrc: PARAKEET_TDT_ENCODER_INT8,
  modelType: "parakeet",
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_INT8,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_INT8,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_INT8,
  },
});

await loadModel({
  modelSrc: PARAKEET_CTC_FP32,
  modelType: "parakeet",
  modelConfig: {
    modelType: "ctc",
    parakeetCtcModelSrc: PARAKEET_CTC_FP32,
    parakeetTokenizerSrc: PARAKEET_CTC_TOKENIZER,
  },
});
```

**

**AFTER:**
**

---

## Add unloadModel autoClose option, default-off on Bare

PR: [#2024](https://github.com/tetherto/qvac/pull/2024)

**BEFORE:**
** (Bare)

```typescript
import { unloadModel } from "@qvac/sdk";

await unloadModel({ modelId });
// RPC connection closed → Bare worker host terminated. Long-lived workers
// had to avoid unloadModel or work around the auto-close.
```

**

**AFTER:**
** (Bare)

---

## CLI cancel bridge + cancelHandler retirement

PR: [#2074](https://github.com/tetherto/qvac/pull/2074)

**BEFORE:**
```typescript
import { downloadAsset, cancel } from "@qvac/sdk";

const op = downloadAsset({ assetSrc, onProgress });
// ...some time later, user clicks Cancel:
await cancel({ operation: "downloadAsset", downloadKey: assetSrc.key, clearCache: true });
```

**AFTER:**
```typescript
import { downloadAsset, cancel } from "@qvac/sdk";

---

## Parakeet 0.6.0 GGML + `transcribeStream` `endOfTurn` wire shape

PR: [#2184](https://github.com/tetherto/qvac/pull/2184)

**Parakeet load (breaking):**

**BEFORE:**

```typescript
await loadModel({
  modelType: "parakeet",
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_INT8,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_INT8,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR,
  },
});
```

**AFTER:**

```typescript
await loadModel({
  modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0,
  modelType: "parakeet",
});
```

**`endOfTurn` stream frames:** servers now emit `source: "whisper" | "parakeet"` on every `endOfTurn` RPC payload. Parsers accept the legacy whisper wire shape `{ silenceDurationMs }` (no `source`) and normalize it to `source: "whisper"`. Upgrade client and server together when relying on parakeet `source: "parakeet"` events.

---

