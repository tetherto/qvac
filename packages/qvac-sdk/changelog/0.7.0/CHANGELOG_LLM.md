# QVAC SDK v0.7.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.7.0

This release introduces the Model Registry—a centralized way to discover, search, and load models directly through the SDK. It also adds a plugin system for extensibility and two new TTS engines for voice synthesis.

---

## Breaking Changes

### Model Constant Naming Standardization

Model constants have been renamed for consistency and clarity. If you import model constants directly, you'll need to update your imports.

**Before:**

```typescript
import { BERGAMOT_AREN, WHISPER_TINY_Q5_1 } from "@qvac/sdk";

await loadModel({ modelSrc: BERGAMOT_AREN.src, modelType: "translation" });
```

**After:**

```typescript
import { BERGAMOT_AR_EN, WHISPER_TINY_Q5_1 } from "@qvac/sdk";

await loadModel({ modelSrc: BERGAMOT_AR_EN.src, modelType: "translation" });
```

The naming changes follow these patterns:

- **Bergamot translation models**: Language codes now use underscores (`BERGAMOT_AREN` → `BERGAMOT_AR_EN`)
- **Whisper models**: Author/repo names removed (`WHISPER_ENGLISH_BASE_OPENAI_WHISPER_BASE_F16` → `WHISPER_EN_BASE_Q0F16`)
- **LLM models**: Version prefixes normalized (`QWEN_3_1_7B_INST_Q4` → `QWEN3_1_7B_INST_Q4`)
- **OCR models**: Dropped redundant `CRAFT_` prefix (`OCR_CRAFT_JAPANESE_RECOGNIZER` → `OCR_JAPANESE_RECOGNIZER`)
- **Marian models**: Simplified quantization suffix (`MARIAN_EN_HI_INDIC_1B_Q0F16` → `MARIAN_EN_HI_INDIC_1B_F16`)

### HyperdriveItem Type Renamed to RegistryItem

The model metadata type has been renamed and its shape updated to reflect the new registry architecture.

**Before:**

```typescript
import type { HyperdriveItem } from "@qvac/sdk";

function getSize(model: HyperdriveItem): number {
  return model.expectedSize;
}
```

**After:**

```typescript
import type { RegistryItem } from "@qvac/sdk";

function getSize(model: RegistryItem): number {
  return model.expectedSize;
}
```

The new `RegistryItem` type includes additional fields like `registryPath`, `registrySource`, `engine`, `quantization`, and `params`.

---

## New Features

### Model Registry Integration

You can now discover and search models directly through the SDK without depending on the registry client package separately.

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

// Search by keyword
const whisperModels = await modelRegistrySearch({ filter: "whisper" });

// Search by quantization
const q4Models = await modelRegistrySearch({ quantization: "q4" });

// Get a specific model
const model = await modelRegistryGetModel(registryPath, registrySource);
```

### Plugin System

Extend the SDK with custom model types and handlers using the new plugin architecture.

```typescript
import { invokePlugin, invokePluginStream, definePlugin, defineHandler } from "@qvac/sdk";

// Invoke a plugin handler (request/reply)
const result = await invokePlugin<MyResponse>({
  modelId,
  handler: "myHandler",
  params: { key: "value" },
});

// Invoke a plugin handler (streaming)
for await (const chunk of invokePluginStream<MyStreamResponse>({
  modelId,
  handler: "myStreamHandler",
  params: { key: "value" },
})) {
  console.log(chunk.result);
}

// Define a custom plugin
const myPlugin = definePlugin({
  modelType: "custom-type",
  displayName: "Custom Plugin",
  addonPackage: "@my/addon",
  createModel: (params) => ({ model, loader }),
  handlers: {
    myHandler: defineHandler({
      requestSchema: myRequestSchema,
      responseSchema: myResponseSchema,
      streaming: false,
      handler: async (request) => ({ type: "pluginInvoke", result: "..." }),
    }),
  },
});
```

### Chatterbox and Supertonic TTS Engines

Two new text-to-speech engines are now available:

**Chatterbox** — Voice cloning TTS that can mimic a reference audio sample:

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
    referenceAudioSrc, // Audio sample to clone
  },
});
```

**Supertonic** — General-purpose TTS with speed and inference step controls:

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
    ttsSpeed: 1.0,
    ttsNumInferenceSteps: 5,
  },
});

const result = textToSpeech({
  modelId,
  text: "Your text here",
  inputType: "text",
  stream: false,
});
```

### Direct Registry Downloads

Model downloads now use `downloadBlob` for more efficient direct registry downloads, improving download performance and reliability.

### CLI SDK Path Option

The CLI now supports `--sdk-path` to explicitly specify the SDK location, useful for monorepo setups or custom installations.

### Pear Worker Entry Generation

A new `pear.pre` hook automatically generates worker entry files for Pear applications, simplifying the build process.

---

## API Changes

### Async Close Handling

The `close()` function is now properly async and should be awaited to ensure clean shutdown.

**Before:**

```typescript
import { close } from "@qvac/sdk";

close();
```

**After:**

```typescript
import { close } from "@qvac/sdk";

await close();
```

### Engine-Addon Mapping Utilities

New utilities for mapping between engine identifiers and addon types:

```typescript
import { resolveCanonicalEngine, getAddonFromEngine, ENGINE_TO_ADDON } from "@qvac/sdk";

const engine = resolveCanonicalEngine("@qvac/llm-llamacpp"); // "llamacpp-completion"
const addon = getAddonFromEngine("llamacpp-completion"); // "llm"
```

---

## Bug Fixes

- **Windows stability**: Fixed EBUSY errors from corestore directory deletion order and fd-lock race conditions during registry client close
- **Security**: Added path traversal protection to prevent directory escape attacks
- **TTS reliability**: Empty text input is now rejected with a clear error, and addon errors are properly wrapped
- **Expo/React Native**: Fixed SDK package directory resolution, device module extraction, and RPC client truncation issues
- **Download resumption**: Registry downloads now use stable corestore storage paths, enabling proper resume after interruption
- **RPC connections**: Fixed delegate RPC client connection bugs for more reliable multi-client setups

---

## Maintenance

- Updated llama.cpp dependencies and removed iPhone 17 CPU override
- Updated `@qvac/registry-client` to 0.2.0
- Consolidated registry core key constants and improved corestore cache scoping
