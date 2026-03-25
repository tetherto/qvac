# 💥 Breaking Changes v0.6.0

## RAG lifecycle improvements with progress streaming, cancellation & workspace management

PR: [#329](https://github.com/tetherto/qvac-sdk/pull/329)

**BEFORE:**
**

```typescript
// Old: pass raw docs, SDK embeds internally
await ragSaveEmbeddings({
  modelId,
  documents: ["Doc 1", "Doc 2"],
  chunk: false,
});
```

**

**AFTER:**
**

```typescript
// New: use ragIngest for full pipeline (same behavior as old ragSaveEmbeddings)
await ragIngest({
  modelId,
  documents: ["Doc 1", "Doc 2"],
});

// Or: ragSaveEmbeddings now expects pre-embedded docs (segregated flow)
await ragSaveEmbeddings({
  documents: [{ id: "1", content: "Doc 1", embedding: [...], embeddingModelId: "model-id" }],
});
```

### `ragSaveEmbeddings` Return Type

**BEFORE:**

```typescript
const { processed, droppedIndices } = await ragSaveEmbeddings(...);
```

**AFTER:**

```typescript
const processed = await ragSaveEmbeddings(...);
// droppedIndices no longer returned
```

### `ragDeleteEmbeddings` Return Type

**BEFORE:**

```typescript
const success = await ragDeleteEmbeddings(...); // boolean
```

**AFTER:**

```typescript
await ragDeleteEmbeddings(...); // void (throws on failure)
```

### `ragDeleteEmbeddings` - `modelId` Now Optional

**BEFORE:** `modelId` required

**AFTER:** `modelId` optional (uses cached workspace if available)

### `chunk` Default Changed

**BEFORE:** `chunk: false` (no chunking by default)

**AFTER:** `chunk: true` (chunking enabled by default in `ragIngest`)

---

## Examples

```bash
# Ingest (full pipeline)
bun examples/rag/rag-hyperdb/ingest.ts

# Segregated pipeline (chunk → embed → save)
bun examples/rag/rag-hyperdb/pipeline.ts

# Workspace management
bun examples/rag/rag-hyperdb/workspaces.ts

# Progress + cancellation
bun examples/rag/rag-hyperdb/cancellation.ts
```

---

## Depends on
This PR depends on the following PRs from RAG lib:
- [#42](https://github.com/tetherto/qvac-lib-rag/pull/42)
- [#43](https://github.com/tetherto/qvac-lib-rag/pull/43)
- [#44](https://github.com/tetherto/qvac-lib-rag/pull/44)

---

## Improve embed config with structured options

PR: [#335](https://github.com/tetherto/qvac-sdk/pull/335)

**BEFORE:**
**

```typescript
await loadModel({
  modelSrc: "embed-model.gguf",
  modelType: "embeddings",
  modelConfig: {
    config: "-ngl\t99\n-dev\tgpu\n--batch_size\t1024",
  },
});
```

**

**AFTER:**
**

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

// Or use rawConfig for exact CLI control
await loadModel({
  modelSrc: "embed-model.gguf",
  modelType: "embeddings",
  modelConfig: {
    rawConfig: "-ngl\t99\n-dev\tgpu\n--batch_size\t1024",
  },
});
```

### Property Removed

- `config: string` → Replaced by structured properties + `rawConfig` escape hatch

---

## Examples

```bash
# Embed with structured config
bun examples/embed-p2p.ts
```

---

## Add Bergamot translation engine support

PR: [#343](https://github.com/tetherto/qvac-sdk/pull/343)

**BEFORE:**
**

```typescript
const modelId = await loadModel({
  modelSrc: MARIAN_OPUS_EN_IT_Q0F32,
  modelType: "nmt",
  modelConfig: {
    from: "en",
    to: "it",
  },
});
```

**

**AFTER:**
**

```typescript
const modelId = await loadModel({
  modelSrc: MARIAN_OPUS_EN_IT_Q0F32,
  modelType: "nmt",
  modelConfig: {
    engine: "Opus",  // Required: "Opus" | "Bergamot" | "IndicTrans"
    from: "en",      // Must be valid for the specified engine
    to: "it",
  },
});
```

### New API Usage

**Loading a Bergamot model (simplified - vocab files auto-derived):**

```typescript
import { loadModel, translate, BERGAMOT_ENFR } from "@qvac/sdk";

// Vocabulary files are automatically derived from pear:// model source!
const modelId = await loadModel({
  modelSrc: BERGAMOT_ENFR,
  modelType: "nmt",
  modelConfig: {
    engine: "Bergamot",
    from: "en",
    to: "fr",
    normalize: 1,  // Bergamot-specific
  },
});
```

**Loading a Bergamot model (explicit vocab override):**

```typescript
import { loadModel, BERGAMOT_ENFR, BERGAMOT_ENFR_VOCAB } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: BERGAMOT_ENFR,
  modelType: "nmt",
  srcVocabSrc: BERGAMOT_ENFR_VOCAB,  // Optional: explicit override
  dstVocabSrc: BERGAMOT_ENFR_VOCAB,  // Optional: explicit override
  modelConfig: {
    engine: "Bergamot",
    from: "en",
    to: "fr",
  },
});
```

**Batch translation (NMT only):**

```typescript
const result = translate({
  modelId,
  text: ["Hello world", "How are you?", "Goodbye"],  // Array input
  modelType: "nmt",
  stream: false,
});

const translatedText = await result.text;
// Returns: "Bonjour le monde\nComment allez-vous?\nAu revoir"
```

**Type-safe language validation:**

```typescript
// ✅ Valid - "en" and "it" are in MARIAN_LANGUAGES
{ engine: "Opus", from: "en", to: "it" }

// ❌ TypeScript error - "fr" is not in MARIAN_LANGUAGES
{ engine: "Opus", from: "en", to: "fr" }

// ✅ Valid - "fr" is in BERGAMOT_LANGUAGES  
{ engine: "Bergamot", from: "en", to: "fr" }

// ✅ Valid - Indic languages for IndicTrans
{ engine: "IndicTrans", from: "eng_Latn", to: "hin_Deva" }
```

---

