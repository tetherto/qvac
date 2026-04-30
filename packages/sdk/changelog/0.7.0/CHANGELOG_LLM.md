# QVAC SDK v0.7.0 Release Notes

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
