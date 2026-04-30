# 💥 Breaking Changes v0.8.0

## Make SDK support latest LLM and Embedding add-ons

PR: [#669](https://github.com/tetherto/qvac/pull/669)

**BEFORE:**
**
```ts
await loadModel({
  modelSrc: EMBEDDINGS_NOMIC_EMBED_TEXT_V1_5,
  modelType: "embeddings",
  modelConfig: {
    rawConfig: "-ngl\t99\n-dev\tgpu\n--batch_size\t1024",
  },
});
```

**

**AFTER:**
**
```ts
await loadModel({
  modelSrc: EMBEDDINGS_NOMIC_EMBED_TEXT_V1_5,
  modelType: "embeddings",
  modelConfig: {
    gpuLayers: 99,
    device: "gpu",
    batchSize: 1024,
  },
});
```

---

## Decouple Builtin Plugins from Core Load Path

PR: [#774](https://github.com/tetherto/qvac/pull/774)

**BEFORE:**
**

```typescript
// Top-level companion source fields were accepted
await loadModel({
  modelType: "llm",
  modelSrc: ".../model.gguf",
  projectionModelSrc: ".../mmproj.gguf",
  toolFormat: "json",
});

await loadModel({
  modelType: "whisper",
  modelSrc: ".../model.bin",
  vadModelSrc: ".../vad.bin",
});

await loadModel({
  modelType: "nmt",
  modelSrc: ".../model.intgemm.alphas.bin",
  srcVocabSrc: ".../srcvocab.spm",
  dstVocabSrc: ".../trgvocab.spm",
});

// Custom plugins could omit loadConfigSchema
const myPlugin: QvacPlugin = {
  modelType: "my-plugin",
  displayName: "My Plugin",
  addonPackage: "@my/addon",
  createModel: (params) => ({ model, loader }),
  handlers: {},
};
```

**

**AFTER:**
**

```typescript
// Companion source fields must live in modelConfig
// toolFormat removed (was dead code - defined in schema but never consumed)
await loadModel({
  modelType: "llm",
  modelSrc: ".../model.gguf",
  modelConfig: {
    projectionModelSrc: ".../mmproj.gguf",
  },
});

await loadModel({
  modelType: "whisper",
  modelSrc: ".../model.bin",
  modelConfig: {
    vadModelSrc: ".../vad.bin",
  },
});

await loadModel({
  modelType: "nmt",
  modelSrc: ".../model.intgemm.alphas.bin",
  modelConfig: {
    srcVocabSrc: ".../srcvocab.spm",
    dstVocabSrc: ".../trgvocab.spm",
  },
});

await loadModel({
  modelType: "parakeet",
  modelSrc: ".../encoder.onnx",
  modelConfig: {
    parakeetEncoderSrc: ".../encoder.onnx",
    parakeetDecoderSrc: ".../decoder.onnx",
    parakeetVocabSrc: ".../vocab.txt",
    parakeetPreprocessorSrc: ".../preprocessor.onnx",
  },
});

// loadConfigSchema is now REQUIRED for all plugins (built-in and custom)
// For plugins that accept any config, use a passthrough schema:
const myPlugin: QvacPlugin = {
  modelType: "my-plugin",
  displayName: "My Plugin",
  addonPackage: "@my/addon",
  loadConfigSchema: z.object({}).catchall(z.unknown()),
  createModel: (params) => ({ model, loader }),
  handlers: {},
};
```

---

## Add CTC and Sortformer model support to SDK

PR: [#811](https://github.com/tetherto/qvac/pull/811)

**BEFORE:**
**

```typescript
import {
  PARAKEET_ENCODER_FP32,
  PARAKEET_ENCODER_DATA_FP32,
  PARAKEET_DECODER_FP32,
  PARAKEET_VOCAB,
  PARAKEET_PREPROCESSOR_FP32,
} from "@qvac/sdk";
```

**

**AFTER:**
**

```typescript
import {
  PARAKEET_TDT_ENCODER_FP32,
  PARAKEET_TDT_ENCODER_DATA_FP32,
  PARAKEET_TDT_DECODER_FP32,
  PARAKEET_TDT_VOCAB,
  PARAKEET_TDT_PREPROCESSOR_FP32,
} from "@qvac/sdk";
```

All 8 existing Parakeet model constants are renamed with a variant prefix (`TDT_`). Find-and-replace migration: `PARAKEET_ENCODER` → `PARAKEET_TDT_ENCODER`, `PARAKEET_DECODER` → `PARAKEET_TDT_DECODER`, `PARAKEET_VOCAB` → `PARAKEET_TDT_VOCAB`, `PARAKEET_PREPROCESSOR` → `PARAKEET_TDT_PREPROCESSOR`.

## 🔌 API Changes

### CTC transcription

```typescript
import {
  PARAKEET_CTC_FP32_1,
  PARAKEET_CTC_DATA_FP32_1,
  PARAKEET_CTC_TOKENIZER,
} from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: PARAKEET_CTC_FP32_1,
  modelType: "parakeet",
  modelConfig: {
    modelType: "ctc",
    parakeetCtcModelSrc: PARAKEET_CTC_FP32_1,
    parakeetCtcModelDataSrc: PARAKEET_CTC_DATA_FP32_1,
    parakeetTokenizerSrc: PARAKEET_CTC_TOKENIZER,
  },
});
const text = await transcribe({ modelId, audioChunk: "/path/to/audio.wav" });
```

### Sortformer diarization

```typescript
const modelId = await loadModel({
  modelSrc: PARAKEET_SORTFORMER_FP32,
  modelType: "parakeet",
  modelConfig: {
    modelType: "sortformer",
    parakeetSortformerSrc: PARAKEET_SORTFORMER_FP32,
  },
});
const diarization = await transcribe({ modelId, audioChunk: "/path/to/audio.wav" });
// Returns: "Speaker 0: 0.00s - 4.24s\nSpeaker 1: 4.65s - 14.32s\n..."
```

## 📦 Models

### Added models

```
PARAKEET_TDT_ENCODER_FP32
PARAKEET_TDT_ENCODER_DATA_FP32
PARAKEET_TDT_DECODER_FP32
PARAKEET_TDT_VOCAB
PARAKEET_TDT_PREPROCESSOR_FP32
PARAKEET_TDT_ENCODER_INT8
PARAKEET_TDT_DECODER_INT8
PARAKEET_TDT_PREPROCESSOR_INT8
PARAKEET_CTC_FP32
PARAKEET_CTC_DATA_FP32
PARAKEET_CTC_VOCAB
PARAKEET_CTC_INT8
PARAKEET_CTC_CONFIG
PARAKEET_CTC_FP32_1
PARAKEET_CTC_DATA_FP32_1
PARAKEET_CTC_TOKENIZER
PARAKEET_SORTFORMER_FP32
PARAKEET_EOU_ENCODER_FP32
PARAKEET_EOU_DECODER_FP32
PARAKEET_EOU_TOKENIZER
```

### Removed models

```
PARAKEET_ENCODER_FP32
PARAKEET_ENCODER_DATA_FP32
PARAKEET_DECODER_FP32
PARAKEET_VOCAB
PARAKEET_PREPROCESSOR_FP32
PARAKEET_ENCODER_INT8
PARAKEET_DECODER_INT8
PARAKEET_PREPROCESSOR_INT8
```

**Depends on:** [#586](https://github.com/tetherto/qvac/pull/586) (Parakeet addon CTC/Sortformer support) — ✅ merged

---

