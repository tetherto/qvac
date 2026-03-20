# QVAC SDK v0.8.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.8.0

This release adds Parakeet as a new transcription engine alongside Whisper, decouples builtin plugins from the core load path for a cleaner architecture, adds CTC and Sortformer transcription models, introduces a built-in profiler for diagnosing performance, and brings Bergamot pivot translation support. Several addon logging and delegation bugs have also been resolved.

---

## 💥 Breaking Changes

### Embedding Model Config Uses Structured Fields

The embedding addon no longer accepts the raw tab-delimited config string. Use the structured fields instead.

**Before:**

```typescript
await loadModel({
  modelSrc: EMBEDDINGS_NOMIC_EMBED_TEXT_V1_5,
  modelType: "embeddings",
  modelConfig: {
    rawConfig: "-ngl\t99\n-dev\tgpu\n--batch_size\t1024",
  },
});
```

**After:**

```typescript
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

### Companion Model Sources Moved Into `modelConfig`

Top-level companion source fields (`projectionModelSrc`, `vadModelSrc`, `srcVocabSrc`, `dstVocabSrc`) have been removed from `loadModel`. They now live inside `modelConfig`. The unused `toolFormat` field has also been removed.

**Before:**

```typescript
await loadModel({
  modelType: "llm",
  modelSrc: ".../model.gguf",
  projectionModelSrc: ".../mmproj.gguf",
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
```

**After:**

```typescript
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
```

Additionally, custom plugins must now provide a `loadConfigSchema`. For plugins that accept any config, use a passthrough schema:

```typescript
const myPlugin: QvacPlugin = {
  modelType: "my-plugin",
  displayName: "My Plugin",
  addonPackage: "@my/addon",
  loadConfigSchema: z.object({}).catchall(z.unknown()),
  createModel: (params) => ({ model, loader }),
  handlers: {},
};
```

### Parakeet Model Constants Renamed

All existing Parakeet model constants now include a variant prefix (`TDT_`) to distinguish them from the new CTC and Sortformer variants. This is a find-and-replace migration:

| Old Constant | New Constant |
|---|---|
| `PARAKEET_ENCODER_*` | `PARAKEET_TDT_ENCODER_*` |
| `PARAKEET_DECODER_*` | `PARAKEET_TDT_DECODER_*` |
| `PARAKEET_VOCAB` | `PARAKEET_TDT_VOCAB` |
| `PARAKEET_PREPROCESSOR_*` | `PARAKEET_TDT_PREPROCESSOR_*` |

---

## 🔌 New APIs

### Parakeet Transcription Plugin

NVIDIA Parakeet ONNX models are now supported as an alternative transcription engine alongside Whisper.cpp. Parakeet uses a multi-file model architecture (encoder, encoder-data, decoder, vocab, preprocessor) resolved through the QVAC Registry.

```typescript
import {
  PARAKEET_TDT_ENCODER_FP32,
  PARAKEET_TDT_ENCODER_DATA_FP32,
  PARAKEET_TDT_DECODER_FP32,
  PARAKEET_TDT_VOCAB,
  PARAKEET_TDT_PREPROCESSOR_FP32,
} from "@qvac/sdk";

const modelId = await loadModel({
  modelType: "parakeet",
  modelSrc: PARAKEET_TDT_ENCODER_FP32,
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_FP32,
    parakeetEncoderDataSrc: PARAKEET_TDT_ENCODER_DATA_FP32,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_FP32,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_FP32,
  },
});

const stream = transcribeStream({ modelId, audioInput: "./audio.mp3" });
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

Supports MP3, WAV, OGG, M4A, RAW, and FLAC audio formats. The plugin filters `[No speech detected]` chunks automatically, mirroring Whisper's `[BLANK_AUDIO]` filtering.

### Bergamot Pivot Translation

Translate between language pairs that don't have a direct model by chaining through a pivot language (typically English). Configure the pivot model inside `modelConfig`:

```typescript
await loadModel({
  modelSrc: BERGAMOT_ES_EN,
  modelType: "nmt",
  modelConfig: {
    engine: "Bergamot",
    from: "es",
    to: "it",
    pivotModel: {
      modelSrc: BERGAMOT_EN_IT,
      beamsize: 4,
      temperature: 0.3,
      topk: 100,
      normalize: 1,
      lengthpenalty: 1.2,
    },
  },
});
```

### SDK Profiler

A built-in profiler lets you measure SDK operation performance at runtime. Enable it globally or on a per-call basis:

```typescript
import { profiler } from "@qvac/sdk";

profiler.enable({
  mode: "verbose",
  includeServerBreakdown: true,
});

// Run operations, then export results
console.log(profiler.exportSummary());
console.log(profiler.exportTable());
console.log(profiler.exportJSON({ includeRecentEvents: true }));

profiler.disable();
```

Per-call profiling control is also available on `embed`, `completion`, `transcribe`, `translate`, `ragSearch`, and `invokePlugin`:

```typescript
await embed(
  { modelId, text: "hello" },
  { profiling: { enabled: true } },
);
```

---

## ✨ Features

### CTC and Sortformer Transcription Models

The SDK now supports two additional Parakeet model variants beyond the existing TDT models:

**CTC transcription** for fast, streaming-friendly speech-to-text:

```typescript
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

**Sortformer diarization** for speaker identification:

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

### AfriqueGemma Support

AfriqueGemma models for African language translation are now available through the SDK.

### Profiler Operation Transport and Metrics

The profiler now captures detailed load/download metrics and stream profiling data, giving deeper visibility into SDK operation performance.

---

## 🐞 Bug Fixes

- **Addon logging fixed across all plugins** — Logging callbacks were not being properly attached to some addon plugins, resulting in missing addon-level logs. All plugins now correctly route native addon logs through the SDK logging system.
- **Parakeet addon logger** now uses the correct `params.modelId` for log routing.
- **RPC race condition** in `getRPCInstance` resolved — concurrent initialization calls no longer create duplicate worker instances.
- **Delegated model unload** now correctly unloads the model on the provider device instead of only removing the local registry entry.
- **Stale delegated model entries** are replaced on re-registration instead of accumulating.

---

## 📦 Model Changes

### Added Models

**OCR:**
- `OCR_DETECTOR_DB_MOBILENET_V3_LARGE`
- `OCR_DETECTOR_DB_RESNET50`
- `OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL`
- `OCR_RECOGNIZER_PARSEQ`

**Parakeet (CTC):**
- `PARAKEET_CTC_FP32`, `PARAKEET_CTC_DATA_FP32`, `PARAKEET_CTC_VOCAB`, `PARAKEET_CTC_INT8`, `PARAKEET_CTC_CONFIG`
- `PARAKEET_CTC_FP32_1`, `PARAKEET_CTC_DATA_FP32_1`, `PARAKEET_CTC_TOKENIZER`

**Parakeet (Sortformer / EOU):**
- `PARAKEET_SORTFORMER_FP32`
- `PARAKEET_EOU_ENCODER_FP32`, `PARAKEET_EOU_DECODER_FP32`, `PARAKEET_EOU_TOKENIZER`

**Parakeet (TDT — renamed from unprefixed):**
- `PARAKEET_TDT_ENCODER_FP32`, `PARAKEET_TDT_ENCODER_DATA_FP32`, `PARAKEET_TDT_DECODER_FP32`, `PARAKEET_TDT_VOCAB`, `PARAKEET_TDT_PREPROCESSOR_FP32`
- `PARAKEET_TDT_ENCODER_INT8`, `PARAKEET_TDT_DECODER_INT8`, `PARAKEET_TDT_PREPROCESSOR_INT8`

### Removed Models

The following unprefixed Parakeet constants were replaced by their `TDT_` equivalents (see breaking changes):

- `PARAKEET_ENCODER_FP32`, `PARAKEET_ENCODER_DATA_FP32`, `PARAKEET_DECODER_FP32`, `PARAKEET_VOCAB`, `PARAKEET_PREPROCESSOR_FP32`
- `PARAKEET_ENCODER_INT8`, `PARAKEET_DECODER_INT8`, `PARAKEET_PREPROCESSOR_INT8`

---

## 🧹 Other Changes

- Consolidated transcription schemas and shared ops into a unified structure.
- Updated `@qvac/tts-onnx` to v0.6.1 and `@qvac/transcription-whispercpp` addon.
- Aligned TTS plugin artifact patterns.
- Ported Android E2E test workflow to the monorepo.
- Improved changelog aggregation to prefer `CHANGELOG_LLM.md` when available.
- Reorganized monorepo documentation structure.
- Ported logging executor to direct assertions and added missing test handlers.
- Enabled profiling in test-qvac desktop and mobile consumers.
