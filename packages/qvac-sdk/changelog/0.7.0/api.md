# 🔌 API Changes v0.7.0

## Model Registry API

PR: [#323](https://github.com/tetherto/qvac/pull/323)

New functions for model discovery and search directly through the SDK:

```typescript
import {
  modelRegistryList,
  modelRegistrySearch,
  modelRegistryGetModel,
  type ModelRegistryEntry,
} from "@qvac/sdk";

// List all available models
const models = await modelRegistryList();

// Search by engine type
const llmModels = await modelRegistrySearch({ engine: "@qvac/llm-llamacpp" });

// Search by text filter
const whisperModels = await modelRegistrySearch({ filter: "whisper" });

// Search by quantization
const q4Models = await modelRegistrySearch({ quantization: "q4" });

// Get a specific model
const specific = await modelRegistryGetModel(registryPath, registrySource);
```

### Engine-addon mapping utilities

```typescript
import { resolveCanonicalEngine, getAddonFromEngine, ENGINE_TO_ADDON } from "@qvac/sdk";

const engine = resolveCanonicalEngine("@qvac/llm-llamacpp"); // "llamacpp-completion"
const addon = getAddonFromEngine("llamacpp-completion"); // "llm"
```

---

## Harden node rpc socket lifecycle and async close handling

PR: [#263](https://github.com/tetherto/qvac/pull/263)

```typescript
import { close } from "@qvac/sdk";

close();
```

```typescript
import { close } from "@qvac/sdk";

await close();
```

---

## Add Plugins

PR: [#327](https://github.com/tetherto/qvac/pull/327)

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
      handler: async (request) => ({ type: "pluginInvoke", result: ... }),
    }),
  },
});
```

---

## Add Chatterbox and Supertonic TTS engines

PR: [#375](https://github.com/tetherto/qvac/pull/375)

```typescript
import { 
  PLUGIN_TTS, 
  SDK_DEFAULT_PLUGINS, 
  type BuiltinPlugin 
} from "qvac-sdk";
```

```typescript
// Chatterbox TTS (voice cloning)
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

// Supertonic TTS (general-purpose)
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
    ttsSpeed: 1.0,           // optional
    ttsNumInferenceSteps: 5, // optional
  },
});

// Text-to-speech usage (same for both engines)
const result = textToSpeech({
  modelId,
  text: "Your text here",
  inputType: "text",
  stream: false,
});
```

```typescript
export type TtsChatterboxConfig = z.infer<typeof ttsChatterboxConfigSchema>;
export type TtsSupertonicConfig = z.infer<typeof ttsSupertonicConfigSchema>;
export type TtsConfig = z.infer<typeof ttsConfigSchema>; // Now a union
```

---

