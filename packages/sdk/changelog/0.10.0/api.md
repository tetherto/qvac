# 🔌 API Changes v0.10.0

## Update SDK nmtcpp plugin for @qvac/translation-nmtcpp 2.0.1

PR: [#1563](https://github.com/tetherto/qvac/pull/1563)

```typescript
// NMT addon constructor (2.0.1) — called by SDK plugin
new TranslationNmtcpp({
  files: {
    model: '/path/to/model.bin',
    srcVocab: '/path/to/vocab.spm',
    dstVocab: '/path/to/vocab.spm',
    pivotModel: '/path/to/pivot.bin',       // optional
    pivotSrcVocab: '/path/to/pivot-vocab.spm', // optional
    pivotDstVocab: '/path/to/pivot-vocab.spm', // optional
  },
  params: { srcLang: 'en', dstLang: 'fr' },
  config: {
    modelType: TranslationNmtcpp.ModelTypes.Bergamot,
    beamsize: 4,
    pivotConfig: { beamsize: 4, topk: 100 }, // optional
  },
  logger,
  opts: { stats: true },
})
```

---

## Add sentence-level streaming for onnx text-to-speech

PR: [#1590](https://github.com/tetherto/qvac/pull/1590)

```typescript
import { loadModel, textToSpeech, unloadModel } from "@qvac/sdk";

const modelId = await loadModel({ /* ...Supertonic ONNX TTS config... */ });

const result = textToSpeech({
  modelId,
  text: "Your long passage here.",
  inputType: "text",
  stream: true,
  sentenceStream: true,
  sentenceStreamLocale: "en",
});

for await (const chunk of result.chunkUpdates!) {
  // chunk.buffer      -> int16 PCM samples for this sentence
  // chunk.chunkIndex  -> 0-based sentence index
  // chunk.sentenceChunk -> source text for this chunk
}

await result.done;
await unloadModel({ modelId });
```

```typescript
import { completion, textToSpeechStream } from "@qvac/sdk";

const session = await textToSpeechStream({
  modelId: ttsModelId,
  inputType: "text",
  accumulateSentences: true,
  sentenceDelimiterPreset: "latin", // "latin" | "cjk" | "multilingual"
  flushAfterMs: 400,
});

(async () => {
  for await (const delta of completion({ modelId: llmModelId, /* ... */ }).tokenStream) {
    session.write(delta);
  }
  session.end();
})();

for await (const chunk of session) {
  // chunk.buffer       -> int16 PCM for this sentence / flush window
  // chunk.chunkIndex   -> optional sentence index
  // chunk.sentenceChunk-> optional source text
  if (chunk.done) break;
}
```

---

## Support the new llm addon cache api in sdk

PR: [#1633](https://github.com/tetherto/qvac/pull/1633)

```ts
import {
  completion,
  deleteCache,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  unloadModel,
  VERBOSITY,
} from "@qvac/sdk";

type ChatMessage = {
  role: string;
  content: string;
};

const cacheKey = "trip-planner";

const modelId = await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  modelType: "llm",
  modelConfig: {
    ctx_size: 4096,
    verbosity: VERBOSITY.ERROR,
  },
});

async function run(history: ChatMessage[]) {
  const result = completion({
    modelId,
    history,
    stream: true,
    kvCache: cacheKey,
  });

  let text = "";
  for await (const token of result.tokenStream) {
    text += token;
  }

  return text.trim();
}

const firstReply = await run([
  { role: "system", content: "You are a concise travel assistant." },
  { role: "user", content: "I like museums and seafood. Plan a day in Lisbon." },
]);

const followUpReply = await run([
  { role: "system", content: "You are a concise travel assistant." },
  { role: "user", content: "I like museums and seafood. Plan a day in Lisbon." },
  { role: "assistant", content: firstReply },
  { role: "user", content: "Now make it a rainy-day itinerary." },
]);

console.log(followUpReply);

await deleteCache({ kvCacheKey: cacheKey });
await unloadModel({ modelId, clearStorage: false });
```

---

## Add img2img support to SDK diffusion API

PR: [#1662](https://github.com/tetherto/qvac/pull/1662)

```typescript
import { loadModel, diffusion, SD_V2_1_1B_Q8_0 } from "@qvac/sdk";
import fs from "fs";

const modelId = await loadModel({ modelSrc: SD_V2_1_1B_Q8_0, modelType: "diffusion" });

// SD / SDXL — SDEdit
const initImage = new Uint8Array(fs.readFileSync("input.png"));
const { outputs } = diffusion({
  modelId,
  prompt: "oil painting style, vibrant colors",
  init_image: initImage,
  strength: 0.5, // 0 = keep source, 1 = ignore source
});

// FLUX.2 — in-context conditioning
// NOTE: requires `prediction: "flux2_flow"` set on the model config at loadModel time.
// `strength` is ignored on this path.
const { outputs: fluxOutputs } = diffusion({
  modelId,
  prompt: "turn into watercolor",
  init_image: initImage,
});

const buffers = await outputs;
fs.writeFileSync("out.png", buffers[0]!);
```

---

## Harden suspend with lifecycle gate and add state() api

PR: [#1691](https://github.com/tetherto/qvac/pull/1691)

```typescript
import { state, suspend, resume, type LifecycleState } from "@qvac/sdk";

await suspend();

const current: LifecycleState = await state();
// "active" | "suspending" | "suspended" | "resuming"

if (current !== "active") {
  await resume();
}
```

---

## Propagate whisper per-segment metadata to SDK users

PR: [#1701](https://github.com/tetherto/qvac/pull/1701)

```typescript
// Batch — returns TranscribeSegment[] instead of string
const segments = await transcribe({
  modelId,
  audioChunk: audioFilePath,
  metadata: true,
});
for (const s of segments) {
  console.log(`[${s.startMs}ms → ${s.endMs}ms] id=${s.id} append=${s.append} ${s.text}`);
}

// Duplex streaming — session iterator yields TranscribeSegment
const session = await transcribeStream({ modelId, metadata: true });
session.write(audioChunk);
for await (const segment of session) {
  console.log(segment.startMs, segment.endMs, segment.text);
}
session.end();
```

```typescript
type TranscribeSegment = {
  text: string;
  startMs: number;
  endMs: number;
  append: boolean;
  id: number;
};
```

---

## Make auto KV-cache reuse completed turn history

PR: [#1705](https://github.com/tetherto/qvac/pull/1705)

```typescript
// New: `final.cacheableAssistantContent` — the canonical assistant
// string the SDK persisted to the auto-cache key on this turn.
// Push it back into `history` verbatim to guarantee a next-turn hit.
const run = completion({ modelId, history, kvCache: true });
for await (const _ of run.tokenStream) { /* stream */ }
const final = await run.final;
const nextHistory = [
  ...history,
  {
    role: "assistant",
    // Falls back to contentText for tool-call turns, which can't
    // be auto-cached today and therefore omit the field.
    content: final.cacheableAssistantContent ?? final.contentText,
  },
  { role: "user", content: "follow-up question" },
];
```

---

## Propagate registry download retries and expose stream timeout

PR: [#1743](https://github.com/tetherto/qvac/pull/1743)

```ts
import { setSDKConfig } from "@qvac/sdk";

setSDKConfig({
  // Retry REQUEST_TIMEOUT failures up to N times before giving up.
  // Set to 0 to disable retries entirely.
  registryDownloadMaxRetries: 5,

  // Raise the per-block stream timeout for slow/high-latency links
  // (default: 60_000 ms).
  registryStreamTimeoutMs: 180_000,
});
```

---

## Improve model type & capability system

PR: [#1748](https://github.com/tetherto/qvac/pull/1748)

```typescript
import type { LoadModelOptions } from "@qvac/sdk";

const opts: LoadModelOptions = {
  modelSrc: "/path/foo",
  modelType: "my-custom-plugin",
  modelConfig: { whatever: 1 },
};
await loadModel(opts);
```

```typescript
import type { LoadCustomPluginModelOptions } from "@qvac/sdk";

// Generic must be supplied; it pins the literal plugin string.
const opts: LoadCustomPluginModelOptions<"my-custom-plugin"> = {
  modelSrc: "/path/foo",
  modelType: "my-custom-plugin",
  modelConfig: { whatever: 1 },
};
await loadModel(opts);

// Or just drop the annotation — TS picks the right overload.
```

```typescript
import { SDK_SERVER_ERROR_CODES } from "@qvac/sdk";

try {
  await transcribe({ modelId: llmModelId /* ... */ });
} catch (e) {
  if ((e as { code?: number })?.code === SDK_SERVER_ERROR_CODES.PLUGIN_HANDLER_NOT_FOUND) {
    /* ... */
  }
}
```

```typescript
import { SDK_SERVER_ERROR_CODES } from "@qvac/sdk";

try {
  await transcribe({ modelId: llmModelId /* ... */ });
} catch (e) {
  if ((e as { code?: number })?.code === SDK_SERVER_ERROR_CODES.MODEL_OPERATION_NOT_SUPPORTED) {
    // Message includes the requested operation, the loaded model type,
    // supported operations on the loaded model, and suggested model types.
  }
}
```

```typescript
// Loaded an NMT model, but called translate with modelType: "llm".
// Worker routed to the NMT plugin (modelId-based) but treated the input as LLM-style. Confusing failures.
await translate({ modelId: nmtModelId, modelType: "llm", text: "..." });
```

```typescript
// Drop modelType; the registered type drives behavior.
await translate({ modelId: nmtModelId, text: "..." });

// Or keep it — but it must match the loaded type, otherwise:
//   ModelTypeMismatchError: expected "nmtcpp-translation", got "llamacpp-completion"
await translate({ modelId: nmtModelId, modelType: "nmt", text: "..." });
```

```typescript
import { getLoadedModelInfo, transcribe } from "@qvac/sdk";

// Introspect a loaded modelId (local or delegated). Discriminated on `isDelegated`.
const info = await getLoadedModelInfo({ modelId });

// Preflight a built-in SDK call before sending the RPC.
// Local: handlers + modelType are authoritative.
// Delegated: handlers is [] and preflight defers to the provider.
if (info.isDelegated || info.handlers.includes("transcribeStream")) {
  await transcribe({ modelId /* ... */ });
}

if (!info.isDelegated) {
  // info.modelType, info.loadedAt
  // info.displayName?, info.addonPackage?  (from the plugin)
  // info.name?, info.path?                 (from the model file)
}

// Throws ModelNotFoundError if modelId isn't loaded.
```

---

## Add responseFormat for structured output

PR: [#1768](https://github.com/tetherto/qvac/pull/1768)

```typescript
import { completion } from "@qvac/sdk";

const run = completion({
  modelId,
  history: [{ role: "user", content: "Extract person info: I'm Alice, 30, data engineer." }],
  stream: true,
  responseFormat: {
    type: "json_schema",
    json_schema: {
      name: "Person",
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
          occupation: { type: "string" },
        },
        required: ["name", "age", "occupation"],
        additionalProperties: false,
      },
    },
  },
});

for await (const event of run.events) {
  if (event.type === "contentDelta") process.stdout.write(event.text);
}
const final = await run.final;
JSON.parse(final.contentText); // guaranteed schema-valid
```

---

## Sdk "dynamic" tools mode

PR: [#1779](https://github.com/tetherto/qvac/pull/1779)

```typescript              
  import { loadModel, completion, TOOLS_MODE, QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";
                                                                                                                                                                                                                                                      
  // Opt into dynamic tools by setting `toolsMode` on the model config.
  const modelId = await loadModel({                                                                                                                                                                                                                   
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelType: "llm",                                                                                                                                                                                                                                 
    modelConfig: {
      ctx_size: 4096,                                                                                                                                                                                                                                 
      tools: true,           
      toolsMode: TOOLS_MODE.dynamic, // or the literal string "dynamic"
    },                                                                                                                                                                                                                                                
  });
                                                                                                                                                                                                                                                      
  const kvCache = `dynamic-tools-${Date.now()}`;
  const history = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What's the weather in Tokyo?" },                                                                                                                                                                                        
  ];
                                                                                                                                                                                                                                                      
  // Turn 1 — weather tools available.
  const turn1 = completion({
    modelId,                                                                                                                                                                                                                                          
    history,
    kvCache,                                                                                                                                                                                                                                          
    stream: true,            
    tools: [{ name: "get_weather", description: "...", parameters: weatherSchema }],
  });                                                                                                                                                                                                                                                 
   
  // Turn 2 — same kvCache, completely different tools. The addon trims the                                                                                                                                                                           
  // previous tool block from the cache, so this rotation is free.
  history.push({ role: "user", content: "Now check my horoscope for Aquarius." });
  const turn2 = completion({                                                                                                                                                                                                                          
    modelId,
    history,                                                                                                                                                                                                                                          
    kvCache,                 
    stream: true,
    tools: [{ name: "get_horoscope", description: "...", parameters: horoscopeSchema }],
  });                                                                                                                                                                                                                                                 
  ```

---

## Pre-terminate cleanup hook + stabilise mobile smoke

PR: [#1797](https://github.com/tetherto/qvac/pull/1797)

```typescript
// Mobile auto-close path (unchanged from caller perspective):
await close(); // now awaits worker cleanup ack before terminating worklet
```

---

## Add native tool-call dialect routing (hermes, pythonic, json) with override

PR: [#1802](https://github.com/tetherto/qvac/pull/1802)

```typescript
// New optional `toolDialect` parameter on completion() — force a specific
// parser chain when the SDK can't auto-detect from the model name.
import { completion } from "@qvac/sdk";

const result = completion({
  modelId,
  history,
  tools,
  stream: true,
  toolDialect: "pythonic", // "hermes" | "pythonic" | "json"
});

Common override case: Llama 3.x tool-calling fine-tunes that emit the native pythonic header (`<|start_header_id|>tool_call<|end_header_id|>...<|eot_id|>`). Auto-routing keeps these on `hermes` because most observed Llama 3.x tool-calling tunes empirically emit JSON, not pythonic — pass `toolDialect: "pythonic"` for tunes that do emit the native framing
```

```typescript
import type { ToolDialect } from "@qvac/sdk";
```

---

