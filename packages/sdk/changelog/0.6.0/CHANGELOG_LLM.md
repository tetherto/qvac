# QVAC SDK v0.6.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.6.0

This release brings major improvements to the RAG pipeline with progress streaming, cancellation support, and workspace management. We've also added OCR capabilities, a new Bergamot translation engine, and support for sharded model downloads. Several breaking changes streamline the API for better developer experience.

---

## 💥 Breaking Changes

### RAG API Redesign

The RAG system has been restructured for better control and flexibility. The main change: `ragSaveEmbeddings` now expects pre-embedded documents, while a new `ragIngest` function handles the full pipeline.

**Before:**

```typescript
await ragSaveEmbeddings({
  modelId,
  documents: ["Doc 1", "Doc 2"],
  chunk: false,
});
```

**After:**

```typescript
// Full pipeline (same behavior as old ragSaveEmbeddings)
await ragIngest({
  modelId,
  documents: ["Doc 1", "Doc 2"],
});

// Or: segregated flow with pre-embedded docs
await ragSaveEmbeddings({
  documents: [
    { id: "1", content: "Doc 1", embedding: [...], embeddingModelId: "model-id" }
  ],
});
```

Other RAG changes:
- `ragSaveEmbeddings` no longer returns `droppedIndices`
- `ragDeleteEmbeddings` now returns `void` instead of `boolean` (throws on failure)
- `ragDeleteEmbeddings` no longer requires `modelId` (uses cached workspace)
- Chunking is now enabled by default in `ragIngest`

### Embedding Config is Now Structured

No more string-based config! Use typed properties for embedding model configuration.

**Before:**

```typescript
await loadModel({
  modelSrc: "embed-model.gguf",
  modelType: "embeddings",
  modelConfig: {
    config: "-ngl\t99\n-dev\tgpu\n--batch_size\t1024",
  },
});
```

**After:**

```typescript
await loadModel({
  modelSrc: "embed-model.gguf",
  modelType: "embeddings",
  modelConfig: {
    gpuLayers: 99,
    device: "gpu",
    batchSize: 1024,
  },
});

// Escape hatch for advanced CLI control
await loadModel({
  modelSrc: "embed-model.gguf",
  modelType: "embeddings",
  modelConfig: {
    rawConfig: "-ngl\t99\n-dev\tgpu\n--batch_size\t1024",
  },
});
```

### Translation Engine Must Be Specified

Loading translation models now requires an explicit `engine` field for type-safe language validation.

**Before:**

```typescript
const modelId = await loadModel({
  modelSrc: MARIAN_OPUS_EN_IT_Q0F32,
  modelType: "nmt",
  modelConfig: { from: "en", to: "it" },
});
```

**After:**

```typescript
const modelId = await loadModel({
  modelSrc: MARIAN_OPUS_EN_IT_Q0F32,
  modelType: "nmt",
  modelConfig: {
    engine: "Opus",  // Required: "Opus" | "Bergamot" | "IndicTrans"
    from: "en",
    to: "it",
  },
});
```

---

## ✨ New Features

### Bergamot Translation Engine

A new translation engine option with support for batch translation and automatic vocabulary file derivation.

```typescript
import { loadModel, translate, BERGAMOT_ENFR } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: BERGAMOT_ENFR,
  modelType: "nmt",
  modelConfig: {
    engine: "Bergamot",
    from: "en",
    to: "fr",
    normalize: 1,  // Bergamot-specific option
  },
});

// Batch translation
const result = translate({
  modelId,
  text: ["Hello world", "How are you?"],
  modelType: "nmt",
  stream: false,
});

const translated = await result.text;
// "Bonjour le monde\nComment allez-vous?"
```

### Import Maps for Cross-Runtime Compatibility

The SDK now uses import maps internally, improving compatibility across Node.js, Bare, and React Native runtimes.

---

## 🔌 New APIs

### OCR (Optical Character Recognition)

Extract text from images with bounding boxes and confidence scores.

```typescript
import { loadModel, ocr, OCR_CRAFT_LATIN_RECOGNIZER } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: OCR_CRAFT_LATIN_RECOGNIZER,
  modelType: "ocr",
  modelConfig: { langList: ["en"] },
});

// Get all text blocks at once
const { blocks, done } = ocr({ modelId, image: "/path/to/image.png" });
const result = await blocks;
await done;

// Or stream blocks as they're detected
const { blockStream, done } = ocr({ modelId, image: imageBuffer, stream: true });
for await (const blocks of blockStream) {
  console.log(blocks);
  // [{ text: "Hello", bbox: [10, 20, 100, 50], confidence: 0.95 }]
}
```

### Sharded Model Downloads

Load large models split across multiple files, from URLs or archives.

```typescript
// Pattern-based sharded URLs (auto-detects shard pattern)
await loadModel({
  modelSrc: "https://huggingface.co/user/model/resolve/main/model-00001-of-00003.gguf",
  modelType: "llm",
});

// Archive-based shards (.tar.gz, .tar, .tgz)
await loadModel({
  modelSrc: "https://huggingface.co/user/model/resolve/main/model.tar.gz",
  modelType: "llm",
});
```

### Device-Specific Model Configuration

Configure model defaults per device brand, platform, or other runtime context.

```javascript
// qvac.config.js
{
  "deviceDefaults": [
    {
      "name": "All Google Android devices",
      "match": {
        "platform": "android",
        "deviceBrand": "google"
      },
      "defaults": {
        "llamacpp-completion": { "device": "cpu" },
        "llamacpp-embedding": { "device": "cpu" }
      }
    }
  ]
}
```

### Canonical Model Type Naming

Model types now use a consistent `engine-usecase` format. Old names still work but show deprecation warnings.

```typescript
// Preferred
loadModel({ modelType: "onnx-ocr", ... });

// Deprecated (logs warning)
loadModel({ modelType: "ocr", ... });
// [sdk:client] Model type "ocr" is an alias and will be deprecated. Use "onnx-ocr" instead.
```

---

## 🐞 Bug Fixes

- **Whisper cold start eliminated** — Transcription now starts immediately without initialization delay
- **Incomplete download detection** — Cache validation now checks file size, not just existence
- **Offline cache fallback** — HTTP model validation works without network connectivity
- **Mobile archive extraction** — Archive-based models now extract correctly on iOS/Android
- **KV cache context reuse** — Fixed issues where conversation context wasn't being preserved across requests

---

## 📦 New Models

Six new LLM models added:

- `GPT_OSS_20B_INST_Q4_K_M` — GPT-OSS 20B instruction model
- `LFM_2_5_1_2B_INST_Q4_0` — LFM 2.5 1.2B (Q4_0 quantization)
- `LFM_2_5_1_2B_INST_Q4_K_M` — LFM 2.5 1.2B (Q4_K_M quantization)
- `LLAMA_TOOL_CALLING_3_2_1B_INST_Q4_K` — Llama 3.2 1B with tool calling support
- `QWEN_3_4B_INST_Q4_K_M` — Qwen 3 4B instruction model
- `QWEN_3_8B_INST_Q4_K_M` — Qwen 3 8B instruction model

