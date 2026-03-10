# Changelog

## [0.7.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.7.0

This release introduces the Model Registry integration, a powerful plugin system, and two new TTS engines (Chatterbox and Supertonic). Model constant names have been standardized for consistency, and several Windows-specific bugs have been resolved.

---

## 💥 Breaking Changes

### Model Constant Naming Standardization

Model constant names have been normalized for consistency. If your code references model constants directly, you'll need to update the imports.

**Bergamot translation models** now use underscores between language codes:

```typescript
// Before
import { BERGAMOT_AREN } from "@qvac/sdk";

// After
import { BERGAMOT_AR_EN } from "@qvac/sdk";
```

**Whisper models** have simplified names without author/repo prefixes:

```typescript
// Before
import { WHISPER_ENGLISH_BASE_OPENAI_WHISPER_BASE_F16 } from "@qvac/sdk";

// After
import { WHISPER_EN_BASE_Q0F16 } from "@qvac/sdk";
```

**LLM models** have normalized version prefixes:

```typescript
// Before
import { QWEN_3_1_7B_INST_Q4 } from "@qvac/sdk";

// After
import { QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";
```

### HyperdriveItem Type Renamed to RegistryItem

The model metadata type has been renamed and restructured to support the new registry system.

```typescript
// Before
import type { HyperdriveItem } from "@qvac/sdk";

// After
import type { RegistryItem } from "@qvac/sdk";
```

The shape has also changed: `hyperdriveKey` and `hyperbeeKey` fields are replaced by `registryPath`, `registrySource`, `blobCoreKey`, and new metadata fields (`engine`, `quantization`, `params`).

---

## ✨ New Features

### Model Registry Integration

Discover and search models directly through the SDK without needing a separate registry client package.

```typescript
import {
  modelRegistryList,
  modelRegistrySearch,
  modelRegistryGetModel,
} from "@qvac/sdk";

// List all available models
const models = await modelRegistryList();

// Search by engine type
const llmModels = await modelRegistrySearch({ engine: "@qvac/llm-llamacpp" });

// Search by text filter
const whisperModels = await modelRegistrySearch({ filter: "whisper" });

// Search by quantization
const q4Models = await modelRegistrySearch({ quantization: "q4" });

// Get a specific model by path
const model = await modelRegistryGetModel(registryPath, registrySource);
```

### Plugin System

Build custom model integrations with the new plugin architecture. Plugins support both request/reply and streaming patterns.

```typescript
import { invokePlugin, invokePluginStream, definePlugin, defineHandler } from "@qvac/sdk";

// Invoke a plugin handler
const result = await invokePlugin<MyResponse>({
  modelId,
  handler: "myHandler",
  params: { key: "value" },
});

// Stream responses from a plugin
for await (const chunk of invokePluginStream<MyStreamResponse>({
  modelId,
  handler: "myStreamHandler",
  params: { key: "value" },
})) {
  console.log(chunk.result);
}
```

### Chatterbox TTS Engine (Voice Cloning)

Clone voices from reference audio samples with the new Chatterbox engine.

```typescript
const modelId = await loadModel({
  modelSrc,
  modelType: "tts",
  modelConfig: {
    ttsEngine: "chatterbox",
    language: "en",
    ttsTokenizerSrc,
    ttsSpeechEncoderSrc,
    ttsEmbedTokensSrc,
    ttsConditionalDecoderSrc,
    ttsLanguageModelSrc,
    referenceAudioSrc, // Your voice sample
  },
});

const audio = await textToSpeech({
  modelId,
  text: "Hello in a cloned voice!",
  inputType: "text",
  stream: false,
});
```

### Supertonic TTS Engine (General Purpose)

High-quality text-to-speech with adjustable speed and inference steps.

```typescript
const modelId = await loadModel({
  modelSrc,
  modelType: "tts",
  modelConfig: {
    ttsEngine: "supertonic",
    language: "en",
    ttsTokenizerSrc,
    ttsTextEncoderSrc,
    ttsLatentDenoiserSrc,
    ttsVoiceDecoderSrc,
    ttsVoiceSrc,
    ttsSpeed: 1.0,           // Playback speed
    ttsNumInferenceSteps: 5, // Quality vs speed tradeoff
  },
});
```

### CLI SDK Path Option

Explicitly specify the SDK location when running CLI commands:

```bash
qvac --sdk-path /custom/path/to/sdk <command>
```

### Direct Registry Downloads

Model downloads now use `downloadBlob` for more efficient direct registry fetching, improving download performance and resume support.

---

## 🔌 API Changes

### Async Close Handler

The `close()` function is now properly async and awaitable for clean shutdown:

```typescript
import { close } from "@qvac/sdk";

// Now returns a Promise
await close();
```

### Engine-Addon Mapping Utilities

Map between engine names and addon types:

```typescript
import { resolveCanonicalEngine, getAddonFromEngine } from "@qvac/sdk";

const engine = resolveCanonicalEngine("@qvac/llm-llamacpp"); // "llamacpp-completion"
const addon = getAddonFromEngine("llamacpp-completion");     // "llm"
```

---

## 🐞 Bug Fixes

### Windows Compatibility

- **EBUSY on shutdown** — Fixed corestore directory deletion order that caused file lock errors on Windows
- **File descriptor race** — Added proper await for `closeRegistryClient` in `findModelShards` to prevent fd-lock races
- **Download resume** — Corestore storage path is now stable, enabling reliable download resume across sessions

### Security

- **Path traversal protection** — Added validation to prevent directory traversal attacks in file paths

### TTS Improvements

- Empty text input is now rejected with a clear error message
- Addon errors are properly wrapped with context

### Expo/React Native

- Extracted `expo-device` to a stubbable module for easier testing
- Removed persistent `node-rpc-client` truncation from Expo plugin
- SDK package directory is now resolved dynamically in Expo plugins

### RPC Client

- Fixed delegate RPC client connection bugs for more reliable remote model access

---

## ⚙️ Infrastructure

- SDK changelog generation tooling updated with root CHANGELOG.md aggregation
- Test workflows now configured with auth tokens for CI/CD

---

## Migration Checklist

1. **Update model constant imports** — Run a find-and-replace for renamed constants
2. **Update `HyperdriveItem` to `RegistryItem`** — If you use the type directly
3. **Await `close()` calls** — Add `await` if you call `close()` during shutdown
4. **Test on Windows** — Verify clean shutdown with no EBUSY errors

## [0.6.1]

Release Date: 2026-02-10

## 🧹 Chores

- Bump llamacpp dependencies and remove iphone 17 cpu override. (see PR [#213](https://github.com/tetherto/qvac/pull/213))

## ⚙️ Infrastructure

- Update SDK pod changelog generation and shared tooling. (see PR [#155](https://github.com/tetherto/qvac/pull/155))

## [0.6.0]

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

## [0.5.0]

This release introduces a streamlined configuration system, powerful new APIs for batch embeddings and MCP tool integration, and a unified logging experience across all SDK components. We've also improved Android compatibility and fixed several critical audio processing issues.

---

## Breaking Changes

### Configuration is Now File-Based

The SDK now uses a config file instead of the `setConfig()` API. This simplifies initialization—create a `qvac.config.json` in your project root and the SDK handles the rest automatically.

**Before:**

```typescript
import { setConfig, loadModel } from "@qvac/sdk";

await setConfig({
  cacheDirectory: "/custom/cache/path",
});

await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: "llama" });
```

**After:**

```json
// qvac.config.json
{
  "cacheDirectory": "/custom/cache/path",
  "swarmRelays": ["relay-key-1", "relay-key-2"]
}
```

```typescript
import { loadModel } from "@qvac/sdk";

// Config automatically loaded at initialization!
await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: "llama" });
```

#### Config Resolution Order

The SDK searches for configuration in this order:

1. **`QVAC_CONFIG_PATH` environment variable** — Explicit path to config file
2. **Project root** — Auto-discovers `qvac.config.{ts,js,json}`
3. **SDK defaults** — Fallback if no config found

#### Supported Formats

| Format     | Filename           | Notes                        |
| ---------- | ------------------ | ---------------------------- |
| JSON       | `qvac.config.json` | Simplest option              |
| JavaScript | `qvac.config.js`   | Use `export default`         |
| TypeScript | `qvac.config.ts`   | Fully typed with `QvacConfig` |

**TypeScript example:**

```typescript
// qvac.config.ts
import type { QvacConfig } from "@qvac/sdk";

const config: QvacConfig = {
  cacheDirectory: "/custom/cache/path",
  swarmRelays: ["relay-key-1", "relay-key-2"],
};

export default config;
```

#### Migration Steps

1. Remove all `setConfig()` calls from your code
2. Create a config file in your project root
3. *(Optional)* For non-standard locations, set `QVAC_CONFIG_PATH` before importing the SDK

---

### Model Constant Cleanup

Some model constants have been renamed for clarity, and duplicate constants have been removed.

**Changes:**

| Before                     | After                                             |
| -------------------------- | ------------------------------------------------- |
| `WHISPER_SMALL`            | `WHISPER_SMALL_Q8`                                |
| `WHISPER_NORWEGIAN_TINY_1` | *(removed — use `WHISPER_NORWEGIAN_TINY`)*        |
| `WHISPER_TINY_SILERO`      | *(removed — use `WHISPER_TINY`)*                  |
| `MARIAN_OPUS_EN_FR_Q4_0_1` | *(removed — use `MARIAN_OPUS_EN_FR_Q4_0`)*        |
| `MARIAN_OPUS_FR_EN_Q4_0_1` | *(removed — use `MARIAN_OPUS_FR_EN_Q4_0`)*        |
| `MARIAN_OPUS_IT_EN`        | *(removed — use `MARIAN_OPUS_EN_IT`)*             |

All model metadata and hyperdrive keys remain unchanged—only the constant names were affected.

---

### Unified Logging API

The logging stream API has been simplified with consistent naming.

#### Parameter Change

**Before:**

```typescript
for await (const log of loggingStream({ modelId: myModelId })) {
  console.log(log.message);
}
```

**After:**

```typescript
for await (const log of loggingStream({ id: myModelId })) {
  console.log(log.message);
}
```

#### Response Property Change

The response object property also changed from `log.modelId` to `log.id`.

#### Global Log Level Moved to Config

`setGlobalLogLevel()` has been removed from the public API. It only worked in the client process, not the server. Use the config file instead:

```json
{
  "loggerLevel": "debug"
}
```

Or use per-logger control: `logger.setLevel("debug")`.

---

## New APIs

### Config Hot-Reload

You can now update a model's configuration without unloading it. Pass the existing `modelId` to `loadModel()` with new config options—the model stays loaded with zero downtime.

```typescript
// Load model with initial config
const modelId = await loadModel({
  modelSrc: "pear://.../whisper.gguf",
  modelType: "whisper",
  modelConfig: { language: "en" },
});

// Hot-reload with new config (same modelId, no reload delay)
await loadModel({
  modelId,
  modelType: "whisper",
  modelConfig: { language: "es" },
});
```

---

### MCP Tool Integration

The SDK now supports the Model Context Protocol (MCP) for tool integration. Pass MCP clients directly to `completion()` and use `call()` to execute tool calls.

**Using MCP clients:**

```typescript
import { completion } from "@qvac/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Create and connect your MCP client
const mcpClient = new Client({ name: "my-app", version: "1.0.0" });
await mcpClient.connect(transport);

// Pass MCP clients to completion
const result = completion({
  modelId,
  history,
  mcp: [{ client: mcpClient }],
});

// Execute tool calls
for (const toolCall of await result.toolCalls) {
  const response = await toolCall.call();
}

// Clean up when done
await mcpClient.close();
```

**Using inline tools with handlers:**

```typescript
import { z } from "zod";

const result = completion({
  modelId,
  history,
  tools: [
    {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: z.object({ city: z.string() }),
      handler: async (args) => {
        return await fetchWeather(args.city);
      },
    },
  ],
});

for (const toolCall of await result.toolCalls) {
  const response = await toolCall.call(); // Executes your handler
}
```

---

### Batch Embeddings

The `embed()` function now accepts arrays, enabling efficient batch processing. Return types are automatically inferred based on input.

```typescript
// Single text → returns number[]
const embedding = await embed({ modelId, text: "hello" });

// Batch texts → returns number[][]
const embeddings = await embed({ modelId, text: ["a", "b", "c"] });
```

Batch processing uses a default batch size of 1024 for optimal throughput.

---

### Addon Log Streaming

C++ addon logs from llama.cpp, whisper.cpp, and other native libraries are now streamed through the SDK's unified logging system.

**Key features:**

- Logs broadcast to all active SDK loggers per namespace (`llamacpp:llm`, `llamacpp:embed`)
- Automatic buffering during `loadModel()` — logs are flushed when `loggingStream()` connects
- Memory-safe: 100 log limit with 30s expiry
- Console output control via `enableConsole` option

**Run the example:**

```bash
bun run examples/logging-streaming
```

---

## Features

### Unified Addon Logging

All native addons (Whisper, TTS, NMT) now use the same logging infrastructure, providing consistent log output across the entire SDK.

### Android 16KB Page Size Compatibility

Dependencies have been upgraded to comply with Android's 16KB page size requirement, ensuring compatibility with newer Android devices.

### bare-ffmpeg Decoder

The SDK now uses `bare-ffmpeg` for audio decoding, improving compatibility and performance.

### Developer Experience Improvements

- **Changelog generator** with commit/PR validation keeps release notes consistent
- **Non-blocking model update checks** in pre-commit hooks don't slow down your workflow

---

## Bug Fixes

### Audio Processing Fixes

- **Corrupted audio files no longer hang** — The SDK now properly handles malformed audio instead of blocking indefinitely
- **Decoder exit handling** — Fixed process hanging due to decoder not exiting properly
- **Decoder bump** — Updated to latest decoder version

### Whisper Improvements

- **Prompt state isolation** — Whisper prompt state no longer leaks between transcriptions, ensuring consistent results

### Android Compatibility

- **Flash Attention disabled on Android for Embeddings** — Prevents crashes on Android devices that don't support Flash Attention

---

## Documentation & Infrastructure

### Documentation

- Standardized documentation format across all guides
- New `docs:gen-pages` script for building documentation
- New `docs:gen-api` script for API reference generation
- Updated PR template, contributing guide, and README

### Infrastructure

- Automatic git tagging after npm publish
- Publish workflow for `npm-patch-*` branches
- Removed npm lockfile, standardized on Bun
