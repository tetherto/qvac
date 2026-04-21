# 🔌 API Changes v0.9.0

## Add duplex streaming transcription API (transcribeStream)

PR: [#999](https://github.com/tetherto/qvac/pull/999)

```typescript
import { transcribe, transcribeStream } from "@qvac/sdk";

// Batch: send full audio, get text back
const text = await transcribe({ modelId, audioChunk: buffer });

// Duplex streaming: bidirectional session — stream audio in, stream text out
const session = await transcribeStream({ modelId });
session.write(audioChunk);   // feed raw audio incrementally
session.end();               // signal end of audio
for await (const text of session) {
  console.log(text);         // transcription segments as VAD detects speech
}
session.destroy();           // tear down both streams (optional cleanup)

// Deprecated (still works, logs warning — use transcribe() instead)
for await (const text of transcribeStream({ modelId, audioChunk: buffer })) {
  console.log(text);
}
```

---

## SDK diffusion plugin integration

PR: [#1021](https://github.com/tetherto/qvac/pull/1021)

```typescript
import { loadModel, diffusion, SD_V2_1_1B_Q8_0 } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: SD_V2_1_1B_Q8_0,
  modelType: "diffusion",
  modelConfig: { prediction: "v" },
});

const { progressStream, outputs, stats } = diffusion({
  modelId,
  prompt: "a cat sitting on a windowsill",
  width: 512,
  height: 512,
  steps: 20,
});

for await (const { step, totalSteps } of progressStream) {
  console.log(`${step}/${totalSteps}`);
}

const buffers = await outputs;
```

---

## Addon Stats & Stream Profiling

PR: [#1068](https://github.com/tetherto/qvac/pull/1068)

```typescript
// completionStream response
{
  token: string;
  done?: boolean;
  stats?: {
    timeToFirstToken?: number;
    tokensPerSecond?: number;
    cacheTokens?: number;
  };
}

// transcribeStream response
{
  text: string;
  done?: boolean;
  stats?: {
    audioDuration?: number;
    realTimeFactor?: number;
    tokensPerSecond?: number;
    totalTokens?: number;
    totalSegments?: number;
    whisperEncodeTime?: number;
    whisperDecodeTime?: number;
    melSpecTime?: number;
  };
}

// translate response
{
  token: string;
  done?: boolean;
  stats?: {
    timeToFirstToken?: number;
    tokensPerSecond?: number;
    totalTokens?: number;
    cacheTokens?: number;
    encodeTime?: number;
    decodeTime?: number;
    totalTime?: number;
  };
}

// textToSpeech response
{
  buffer: number[];
  done?: boolean;
  stats?: {
    audioDuration?: number;
    totalSamples?: number;
  };
}

// embed response
{
  embedding: number[];
  stats?: {
    totalTime?: number;
    tokensPerSecond?: number;
    totalTokens?: number;
  };
}
```

---

## Add RPC health probe and centralize stale-connection cleanup for delegation

PR: [#1149](https://github.com/tetherto/qvac/pull/1149)

```typescript
await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  modelType: "llm",
  delegate: {
    topic: topicHex,
    providerPublicKey,
    timeout: 30_000,
    healthCheckTimeout: 2000, // optional, defaults to 1500ms
  },
});
```

---

## Add delegated cancellation for inference and remote downloads

PR: [#1153](https://github.com/tetherto/qvac/pull/1153)

```typescript
// Cancel delegated inference (no API change — routes automatically via model registry)
await cancel({ operation: "inference", modelId: "delegated-model-id" });

// Cancel delegated remote download (new: optional delegate field)
await cancel({
  operation: "downloadAsset",
  downloadKey: "download-key",
  delegate: { topic: "topicHex", providerPublicKey: "peerHex" },
});
```

---

## Refactor JS interface in TTS package

PR: [#1170](https://github.com/tetherto/qvac/pull/1170)

```bash
cd packages/qvac-lib-infer-onnx-tts
npm run test:unit
```

```typescript
// Illustrative — old patterns varied; many callers used infer-base / loader,
// relative paths resolved in JS, and/or downloadWeights / legacy option shapes.
const model = new ONNXTTS({
  loader: myLoader,
  tokenizerPath: "./models/chatterbox/tokenizer.json",
  // ... other *Path keys, engine-specific top-level options
})
await model.downloadWeights?.(...)
await model.load()
```

```typescript
import path from "bare-path"

const modelDir = path.resolve("path/to/bundle")
const model = new ONNXTTS({
  files: {
    modelDir,
    // or explicit absolute paths; optional engine: "chatterbox" | "supertonic"
  },
  exclusiveRun: true, // recommended when you must serialize run/reload/unload
})
await model.load()
// No downloadWeights on ONNXTTS — download or resolve files yourself first.
```

```typescript
// Prefer files + modelDir; paths must be absolute.
const tts = new ONNXTTS({
  files: {
    modelDir: "/abs/path/to/supertonic-bundle",
  },
  engine: "supertonic",
  voiceName: "F1",
  exclusiveRun: true,
  opts: { stats: true },
})
await tts.load()
const response = await tts.run({ type: "text", input: "Hello" })
await response.await()
```

---

## Add finetuning support to the SDK

PR: [#1479](https://github.com/tetherto/qvac/pull/1479)

```typescript
import { finetune } from "@qvac/sdk";

const finetuneOptions = {
  trainDatasetDir: "./dataset/train",
  validation: { type: "dataset", path: "./dataset/eval" },
  outputParametersDir: "./artifacts/lora",
  numberOfEpochs: 2,
};

// Default behavior: let the add-on choose start vs resume automatically.
const autoHandle = finetune({
  modelId,
  options: finetuneOptions,
});
for await (const progress of autoHandle.progressStream) {
  console.log(progress.global_steps, progress.loss);
}
const autoResult = await autoHandle.result;
console.log(autoResult.status, autoResult.stats);

// Explicitly start a fresh run.
const startHandle = finetune({
  modelId,
  operation: "start",
  options: finetuneOptions,
});
await startHandle.result;

// Inspect the current finetune state without starting work.
const state = await finetune({
  modelId,
  operation: "getState",
  options: finetuneOptions,
});
console.log(state.status);

// Pause an active run.
const pauseResult = await finetune({
  modelId,
  operation: "pause",
});
console.log(pauseResult.status);

// Resume a paused run.
const resumeHandle = finetune({
  modelId,
  operation: "resume",
  options: finetuneOptions,
});
for await (const progress of resumeHandle.progressStream) {
  console.log(progress.global_steps, progress.loss);
}
const resumeResult = await resumeHandle.result;
console.log(resumeResult.status, resumeResult.stats);

// Cancel an active run.
const cancelResult = await finetune({
  modelId,
  operation: "cancel",
});
console.log(cancelResult.status);
```

---

## Expose backendDevice stat in SDK for LLM and embed addons

PR: [#1495](https://github.com/tetherto/qvac/pull/1495)

```typescript
const vectors = await embed({ modelId, text: "hello" });
```

```typescript
const { embedding, stats } = await embed({ modelId, text: "hello" });
console.log(stats?.backendDevice); // "cpu" | "gpu" | undefined
```

```typescript
// CompletionStats
{
  timeToFirstToken?: number
  tokensPerSecond?: number
  cacheTokens?: number
  backendDevice?: "cpu" | "gpu"  // NEW
}

// EmbedStats (newly re-exported from SDK root)
{
  totalTime?: number
  tokensPerSecond?: number
  totalTokens?: number
  backendDevice?: "cpu" | "gpu"  // NEW
}

// LlmConfig — new optional fields
{
  openclCacheDir?: string     // camelCase
  'cache-type-k'?: string     // kebab-case
  'cache-type-v'?: string     // kebab-case
}

// EmbedConfig — new optional field
{
  openclCacheDir?: string
}
```

---

## Add suspend/resume lifecycle

PR: [#1511](https://github.com/tetherto/qvac/pull/1511)

```ts
import { suspend, resume } from '@qvac/sdk'

// App/runtime background handler
await suspend()

// App/runtime foreground handler
await resume()
```

---

