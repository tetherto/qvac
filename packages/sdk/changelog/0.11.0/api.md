# 🔌 API Changes v0.11.0

## Expose split-mode and tensor-split in SDK LLM config

PR: [#1759](https://github.com/tetherto/qvac/pull/1759)

```typescript
// LLM — LoadModelOptions.modelConfig now accepts:
{
  "split-mode": "none" | "layer" | "row",    // optional, default none
  "tensor-split": "1,1",                     // optional, proportional split across GPUs
  "main-gpu": 0 | "integrated" | "dedicated" // optional, primary GPU selection
}

// Embed — LoadModelOptions.modelConfig now accepts:
{
  splitMode: "none" | "layer" | "row",       // optional, default none
  tensorSplit: "1,1",                        // optional, proportional split across GPUs
  mainGpu: 0 | "integrated" | "dedicated"   // optional, primary GPU selection (was already supported)
}
```

---

## Add FLUX.2 multi-reference fusion and LoRA adapter support to diffusion API

PR: [#1838](https://github.com/tetherto/qvac/pull/1838)

```typescript
// FLUX.2 multi-reference fusion (mutually exclusive with init_image)
const refA = fs.readFileSync("scientist-a.jpg");
const refB = fs.readFileSync("scientist-b.jpg");
const { outputs } = diffusion({
  modelId,
  prompt: "a portrait using most visual traits from @image1 and the eyes from @image2",
  init_images: [refA, refB],
  width: 768,
  height: 768,
});

// Per-call LoRA adapter (absolute path required)
const { outputs } = diffusion({
  modelId,
  prompt: "a watercolor cat",
  lora: "/home/user/loras/watercolor.safetensors",
});

// LoRA persistence mode is selected at loadModel time
await loadModel(modelSrc, {
  modelType: "diffusion",
  modelConfig: { prediction: "flux2_flow", lora_apply_mode: "immediately" },
});
```

---

## Expose whisper VAD and end-of-turn events in transcribeStream

PR: [#1848](https://github.com/tetherto/qvac/pull/1848)

```typescript
// NEW overload
export function transcribeStream(
  params: TranscribeStreamClientParams & { emitVadEvents: true },
  options?: RPCOptions,
): Promise<TranscribeStreamConversationSession>;
```

```typescript
type TranscribeStreamClientParams = {
  modelId: string;
  prompt?: string;
  metadata?: boolean;
  // NEW:
  emitVadEvents?: boolean;
  endOfTurnSilenceMs?: number;
  vadRunIntervalMs?: number;
};
```

```typescript
export type VadStateEvent = { speaking: boolean; probability: number };
export type EndOfTurnEvent = { silenceDurationMs: number };

export type TranscribeStreamEvent =
  | { type: "text"; text: string }
  | { type: "segment"; segment: TranscribeSegment }
  | ({ type: "vad" } & VadStateEvent)
  | ({ type: "endOfTurn" } & EndOfTurnEvent);

export interface TranscribeStreamConversationSession {
  write(audioChunk: Buffer): void;
  end(): void;
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterator<TranscribeStreamEvent>;
}
```

``` typescript
import { transcribeStream } from "@tetherto/qvac-sdk";

const session = await transcribeStream({
  modelId: "whisper-base",
  emitVadEvents: true,
  endOfTurnSilenceMs: 800,
  vadRunIntervalMs: 100,
});

for await (const event of session) {
  if (event.type === "vad") console.log("speaking:", event.speaking, event.probability);
  else if (event.type === "endOfTurn") console.log("turn ended after", event.silenceDurationMs, "ms");
  else if (event.type === "text") process.stdout.write(event.text);
}

session.write(audioChunk);
session.end();
```

---

## Add harmony tool-call dialect (gpt-oss)

PR: [#1878](https://github.com/tetherto/qvac/pull/1878)

```typescript
import { completion, type ToolDialect } from "@qvac/sdk";

// New dialect value (existing override parameter, fourth enum value).
const result = completion({
  modelId,         // gpt-oss-20b-Q4_K_M auto-routes to "harmony"
  history,
  tools,
  toolDialect: "harmony", // optional explicit override
});

// `ToolDialect` is now "hermes" | "pythonic" | "json" | "harmony".
const dialect: ToolDialect = "harmony";
```

---

## Add ESRGAN upscale support to SDK diffusion

PR: [#1930](https://github.com/tetherto/qvac/pull/1930)

```typescript
const modelId = await loadModel({
  modelSrc: SD_V2_1_1B_Q8_0,
  modelType: "diffusion",
  modelConfig: {
    prediction: "v",
    upscaler: {
      type: "esrgan",
      model_src: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth",
      tile_size: 128,
      direct: false,
      offload_params_to_cpu: false,
      threads: -1,
    },
  },
});

const { outputs } = diffusion({
  modelId,
  prompt: "an illustrated red fox portrait",
  width: 128,
  height: 128,
  upscale: { repeats: 2 },
});
```

---

## Introduce request lifecycle primitives with signal-based cancel

PR: [#1949](https://github.com/tetherto/qvac/pull/1949)

```ts
const run = sdk.completion({ model: "...", prompt: "..." });

// requestId is available immediately on the run handle
const requestId = run.requestId;

// new targeted cancellation path
await sdk.cancel({ requestId });

// existing broad-cancel escape hatch remains
await sdk.cancel({ modelId: "my-model-id" });
```

---

## Add Qwen3.5, Gemma4 tool-call dialects and reasoning_budget param

PR: [#1974](https://github.com/tetherto/qvac/pull/1974)

```ts
import { loadModel, completion } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: "/models/Qwen3.5-7B-Instruct-Q4_K_M.gguf",
  modelType: "llm",
  modelConfig: { ctx_size: 4096, tools: true },
});

const run = completion({
  modelId,
  history: [{ role: "user", content: "What's the weather in Paris?" }],
  tools: [weatherTool],
  // toolDialect: "qwen35" — auto-detected; override only if needed
});
```

```ts
const modelId = await loadModel({
  modelSrc: "/models/gemma-4-9b-it-Q4_K_M.gguf",
  modelType: "llm",
  modelConfig: { ctx_size: 4096, tools: true },
});

const run = completion({
  modelId,
  history: [{ role: "user", content: "What's the weather in Paris?" }],
  tools: [weatherTool],
  // toolDialect: "gemma4" — auto-detected; override only if needed
});
```

```ts
// -1 = unrestricted thinking, 0 = disabled
const modelId = await loadModel({
  modelSrc: "/models/Qwen3.5-7B-Instruct-Q4_K_M.gguf",
  modelType: "llm",
  modelConfig: { ctx_size: 4096, reasoning_budget: -1 },
});

const run = completion({
  modelId,
  history: [{ role: "user", content: "Think step by step." }],
  generationParams: { reasoning_budget: 0 }, // override per-request
});
```

---

## Add standalone image upscaling support to the SDK

PR: [#1990](https://github.com/tetherto/qvac/pull/1990)

```typescript
import { upscale, loadModel, REALESRGAN_X4PLUS_ANIME_6B } from "@qvac/sdk";

// Load the ESRGAN model in standalone-upscale mode.
const modelId = await loadModel(REALESRGAN_X4PLUS_ANIME_6B, {
  modelType: "diffusion",
  modelConfig: {
    mode: "upscale",
    upscaler: { tile_size: 128 }, // optional tuning
  },
});

// Run an upscale job.
const { outputs, stats } = upscale({
  modelId,
  image: pngBytes,   // Uint8Array (PNG/JPEG)
  repeats: 1,        // optional, defaults to 1; each pass multiplies dims by the model's native scale factor
});

const [upscaledPng] = await outputs;
console.log(await stats); // { upscaleMs, totalUpscaleMs, width, height, totalPixels, repeats, ... }
```

---

## Wire qvac verify bundle into Expo plugin

PR: [#2000](https://github.com/tetherto/qvac/pull/2000)

```
node "<…>/@qvac/cli/dist/index.js" verify bundle \
  --addons-source "<…>/qvac/worker.bundle.js" \
  --host android-arm64 --host ios-arm64 \
  --host ios-arm64-simulator --host ios-x64-simulator \
  --config "<…>/qvac.config.json"
```

---

## Typed cancel outcomes on the wire + atomic KV-cache via KvCacheSession

PR: [#2007](https://github.com/tetherto/qvac/pull/2007)

```
bun lint        # eslint + tsc, clean
bun run build   # clean
bun run test:unit  # 10/10 files, all asserts pass
```

```typescript
import { completion, cancel, InferenceCancelledError } from "@qvac/sdk";

const run = completion({ modelId, history, stream: true });

// Iterating events stays unchanged — events end naturally with the
// cancelled terminator on cancel, no thrown error:
for await (const event of run.events) {
  if (event.type === "completionDone" && event.stopReason === "cancelled") {
    // request was cancelled — handle here if you want
  }
}

// Awaiting promise-aggregates throws InferenceCancelledError on cancel:
try {
  await cancel({ requestId: run.requestId });
  const text = await run.text;
  // ...
} catch (err) {
  if (err instanceof InferenceCancelledError) {
    console.log(`cancelled: requestId=${err.requestId}, partial=${err.partial.text}`);
    // err.partial.toolCalls and err.partial.stats are also available
  }
}
```

---

## Add unloadModel autoClose option, default-off on Bare

PR: [#2024](https://github.com/tetherto/qvac/pull/2024)

```typescript
import { unloadModel } from "@qvac/sdk";

await unloadModel({ modelId });
// RPC connection closed → Bare worker host terminated. Long-lived workers
// had to avoid unloadModel or work around the auto-close.
```

```typescript
import { unloadModel } from "@qvac/sdk";

await unloadModel({ modelId });
// Connection stays open, worker survives. Opt in to closing explicitly:
await unloadModel({ modelId, autoClose: true });
```

```typescript
await unloadModel({ modelId });

await unloadModel({ modelId, autoClose: true });

await unloadModel({ modelId, autoClose: false });
```

---

## Cancel capability + per-handler cancel scope + structured logging

PR: [#2036](https://github.com/tetherto/qvac/pull/2036)

```
[request-lifecycle] begin  requestId=<id> kind=<kind> modelId=<id|"-"> state=running
[request-lifecycle] cancel requestId=<id> kind=<kind> modelId=<id|"-"> state=cancelling
[request-lifecycle] end    requestId=<id> kind=<kind> modelId=<id|"-"> state=<terminal> durationMs=<n>
```

```
bun run lint        # eslint + tsc, clean
bun run test:unit   # all files, all asserts pass
```

```typescript
import { definePlugin, defineHandler } from "@qvac/sdk";

definePlugin({
  manifestVersion: 1,
  handlers: {
    myStream: defineHandler({
      requestSchema,
      responseSchema,
      streaming: true,
      cancel: { scope: "model", hard: true }, // <-- new
      handler: async function* (request, ctx) { /* ... */ },
    }),
  },
});
```

```typescript
import { RequestRejectedByPolicyError } from "@qvac/sdk";

try {
  for await (const e of sdk.completion({ ... })) { /* ... */ }
} catch (err) {
  if (err instanceof RequestRejectedByPolicyError) {
    showBusy({ modelId: err.modelId, reason: err.reason });
  } else {
    throw err;
  }
}
```

```typescript
import { getRequestRegistry } from "@/server/bare/runtime";

const registry = getRequestRegistry();
registry.policy({ kind: "embeddings", oneAtATimePerModel: true });

await using ctx = registry.begin({ requestId, kind: "embeddings", modelId });
// ...
```

```typescript
import { getRequestRegistry, withRequestContext } from "@/server/bare/runtime";
import { getServerLogger } from "@/logging";

const registry = getRequestRegistry();
await using ctx = registry.begin({ requestId, kind: "completion", modelId });
const logger = withRequestContext(getServerLogger(), ctx);

logger.info("starting work"); // -> "[request-lifecycle completion requestId=... modelId=...] starting work"
```

---

## Inference-handler migrations

PR: [#2058](https://github.com/tetherto/qvac/pull/2058)

```typescript
import { v4 as uuid } from "uuid";

const id = uuid();

// Embed
const embed = sdk.embed({ modelId, text: "hello", requestId: id });
await sdk.cancel({ requestId: id });

// Transcribe (single shot)
const t = sdk.transcribe({ modelId, audioChunk, requestId: id });

// Transcribe (duplex stream)
const stream = sdk.transcribeStream({ modelId, requestId: id });

// Translate (LLM and NMT both accept the field)
const tr = sdk.translate({
  modelId, text: "hi", from: "en", to: "fr", stream: true,
  modelType: "llm", requestId: id,
});

// Finetune
const ft = sdk.finetune({ modelId, options, requestId: id });
```

```typescript
await sdk.cancel({ operation: "embeddings", modelId });
```

```typescript
// Targeted: works for all four migrated kinds, today, end-to-end
await sdk.cancel({ requestId: id });

// Server-internal broad cancel: anyone holding a `RequestRegistry`
// reference (handlers, the cancel op, future bridges) can fan out
// across kinds without touching the wire schema
getRequestRegistry().cancel({ modelId, kind: "transcribe" });
getRequestRegistry().cancel({ modelId, kind: "translate" });
getRequestRegistry().cancel({ modelId, kind: "finetune" });
```

---

## Non-inference migrations + decorated-promise requestId

PR: [#2060](https://github.com/tetherto/qvac/pull/2060)

```typescript
const modelId: string = await sdk.loadModel({ modelSrc: "..." });
// No way to cancel this specific call without grabbing the modelId
// out-of-band and calling cancel({ operation: "inference", modelId })
// (which is broad-cancel — kills every in-flight request on that model).
```

```typescript
const op = sdk.loadModel({ modelSrc: "..." });
op.requestId;                              // ← synchronously available, before await
const modelId: string = await op;          // ← legacy unwrap still works

// Stop button → exactly this load, nothing else on the model:
stopButton.onclick = () => sdk.cancel({ requestId: op.requestId });
```

```typescript
const op = sdk.downloadAsset({ assetSrc: "https://example.com/big.gguf" });
setTimeout(() => sdk.cancel({ requestId: op.requestId }), 1000);
await op; // rejects with InferenceCancelledError if cancelled
```

```typescript
const requestId = crypto.randomUUID();
const result = sdk.rag({
  type: "rag",
  operation: "ingest",
  workspace: "ws-a",
  modelId: "m1",
  documents: [...],
  requestId, // optional on the wire; legacy clients omit it and the server generates one
});

await sdk.cancel({ requestId });
```

---

