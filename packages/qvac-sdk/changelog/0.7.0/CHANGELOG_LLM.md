# QVAC SDK v0.7.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.7.0

This release integrates the Model Registry directly into the SDK, enabling model discovery and search without external dependencies. It also introduces a Plugin system for extending the SDK with custom model types and handlers, adds two new TTS engines (Chatterbox and Supertonic), and includes numerous stability fixes across Windows, Expo, and RPC layers.

---

## 💥 Breaking Changes

### Model Registry Integration

The model registry is now built into the SDK. As part of this integration, model constant names have been normalized for consistency and the metadata type has been renamed.

#### Constant Renames

Many model constants have been renamed to follow cleaner naming conventions. The main patterns:

- **Bergamot**: language code pairs are now separated with underscores (`BERGAMOT_AREN` → `BERGAMOT_AR_EN`)
- **Whisper**: verbose author/repo prefixes removed (`WHISPER_ENGLISH_BASE_OPENAI_WHISPER_BASE_F16` → `WHISPER_EN_BASE_Q0F16`)
- **LLM**: version prefixes normalized (`QWEN_3_8B_INST_Q4_K_M` → `QWEN3_8B_INST_Q4_K_M`)
- **OCR**: language-specific `CRAFT_` prefix dropped where redundant (`OCR_CRAFT_JAPANESE_RECOGNIZER` → `OCR_JAPANESE_RECOGNIZER`)
- **Marian**: `Q0F16` quantization label simplified to `F16`

See the full rename table in `breaking.md` for all affected constants.

#### `HyperdriveItem` → `RegistryItem`

The model metadata type has been renamed. The shape also changed — `hyperdriveKey`/`hyperbeeKey` fields are replaced by `registryPath`, `registrySource`, `blobCoreKey`, and new metadata fields (`engine`, `quantization`, `params`).

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

#### Registry Operations via SDK

New functions for model discovery and search are available directly through the SDK:

```typescript
import {
  modelRegistryList,
  modelRegistrySearch,
  modelRegistryGetModel,
} from "@qvac/sdk";

const allModels = await modelRegistryList();
const llmModels = await modelRegistrySearch({ engine: "@qvac/llm-llamacpp" });
const whisperModels = await modelRegistrySearch({ filter: "whisper" });
const q4Models = await modelRegistrySearch({ quantization: "q4" });
const specific = await modelRegistryGetModel(registryPath, registrySource);
```

#### Engine-Addon Mapping Utilities

```typescript
import { resolveCanonicalEngine, getAddonFromEngine } from "@qvac/sdk";

const engine = resolveCanonicalEngine("@qvac/llm-llamacpp"); // "llamacpp-completion"
const addon = getAddonFromEngine("llamacpp-completion"); // "llm"
```

---

## 🔌 New APIs

### Plugin System

The SDK now supports plugins, allowing you to extend it with custom model types and handlers. Plugins can handle both request/reply and streaming interactions.

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

Two new text-to-speech engines are now available, each suited for different use cases.

**Chatterbox** excels at voice cloning, requiring a reference audio sample to replicate a target voice:

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
    referenceAudioSrc,
  },
});
```

**Supertonic** is a general-purpose TTS engine with configurable speed and inference quality:

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
```

Both engines use the same inference API:

```typescript
const result = textToSpeech({
  modelId,
  text: "Your text here",
  inputType: "text",
  stream: false,
});
```

### `close()` is Now Async

The SDK `close()` function now returns a Promise, ensuring all RPC sockets and resources are fully cleaned up before your process exits.

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

---

## ✨ Features

### CLI `--sdk-path` Option

The CLI now accepts an explicit `--sdk-path` option for specifying the SDK location, useful in monorepo setups or non-standard project layouts where automatic resolution may not find the correct package.

### Pear `pear.pre` Hook

Added support for auto-generating a worker entry point via the `pear.pre` build hook, simplifying Pear application setup.

---

## 🐞 Bug Fixes

- **Windows EBUSY on cleanup** — Fixed corestore directory deletion order that caused `EBUSY` errors on Windows when cleaning up after model operations.
- **Path traversal protection** — Added validation to prevent path traversal attacks when resolving model file paths.
- **TTS empty input handling** — The SDK now rejects empty text input in TTS calls with a clear error instead of silently failing, and addon errors are properly wrapped.
- **Expo device module** — Extracted `expo-device` into a stubbable module, fixing build issues and adding Android build config plugin support.
- **Expo plugin truncation** — Removed persistent `node-rpc-client` truncation from the Expo plugin that was corrupting RPC messages.
- **Expo SDK path resolution** — SDK package directory is now resolved dynamically in Expo plugins, fixing failures when the SDK is installed in non-standard locations.
- **Delegate RPC client** — Fixed connection bugs in the delegate RPC client that could cause dropped messages or failed reconnections.
- **Registry download resume** — Switched to a stable corestore storage path so interrupted registry downloads can properly resume instead of restarting from scratch.
- **Windows fd-lock race** — Added proper `await` on `closeRegistryClient` in `findModelShards` to prevent file descriptor lock races on Windows.
