# 🔌 API Changes v0.21.0

## Opt-in deferred tool loading and tool_search

PR: [#4602](https://github.com/tetherto/qvac/pull/4602)

A tool may set `deferLoading: true` (or an MCP client entry, to defer all its tools). The first prompt then carries only always-loaded tools and a built-in `tool_search` whose description lists the deferred tools by name and description. When the model calls `tool_search`, run `executeToolSearch()` and push its result as a `tool` message; the matching definitions are callable from the next turn. `completion()` stays stateless and reads the loaded set back from history, so keep that message. Tools without the flag are unchanged.

```typescript
import { completion, executeToolSearch, TOOL_SEARCH_NAME } from '@qvac/inference'

const tools = [
  { name: 'get_weather', description: '...', parameters },
  {
    name: 'create_issue',
    description: 'Open a new issue on a repository',
    parameters,
    deferLoading: true,
    group: 'github'
  }
]

const run = completion({ modelId, history, tools })
history.push({ role: 'assistant', content: (await run.final).raw.fullText })
for (const call of await run.toolCalls) {
  const content =
    call.name === TOOL_SEARCH_NAME
      ? executeToolSearch(tools, call.arguments, history)
      : await runTool(call)
  history.push({ role: 'tool', content })
}

// Defer every tool an MCP client exposes
completion({ modelId, history, mcp: [{ client, deferLoading: true, group: 'github' }] })
```

New options: `deferLoading` and `group` on tools and on `McpClientInput`.
New exports: `TOOL_SEARCH_NAME`, `executeToolSearch(tools, args, history)`, `loadedToolNames(history)`, `searchDeferredTools(deferred, query, limit?)`, `buildToolSearchTool(deferred)`.

`tool_search` is reserved. `generationParams.tool_choice` cannot name a deferred tool; force `tool_search` or drop `deferLoading` from that tool.

---

## Close the gaps against @qvac/bci-whispercpp 0.9.1

PR: [#4565](https://github.com/tetherto/qvac/pull/4565)

Batch `bciTranscribe` terminal frames can carry `diagnostics` with the same backend-selection payload other engines attach. Streamed BCI segments expose `windowStartTimestep` so window-local `startMs` / `endMs` can be placed on the stream timeline (`windowStartTimestep * 20` ms).

---

## Expose ABot-World layer streaming in the SDK

PR: [#4637](https://github.com/tetherto/qvac/pull/4637)

```ts
world: {
  backend: 'metal',
  paramsBackend: 'diffusion=cpu',
  maxVram: 2,
  streamLayers: true,
  verbosity: 3,
  kvCache: true,
  seed: 42,
  threads: 8,
  frameJpegQuality: 85
}
```

```ts
modelConfig: {
  mode: 'world',
  world: {
    paramsBackend: 'diffusion=cpu',
    maxVram: 2,
    streamLayers: true,
    verbosity: 3
  }
}
```

---

## Judge a projected fit against the memory the system reports free

PR: [#4669](https://github.com/tetherto/qvac/pull/4669)

```typescript
import { getLoadedModelInfo } from '@qvac/inference'

const info = await getLoadedModelInfo({ modelId })

info.fitProbe?.verdict // 'fit' | 'does-not-fit' | 'unknown'
info.fitProbe?.projection?.deviceBytes
info.fitProbe?.projection?.hostBytes
info.fitProbe?.plan // the placement the fitter resolved
```

---

## Dispatch the fit probe to every engine

PR: [#4671](https://github.com/tetherto/qvac/pull/4671)

The load-time fit probe and `assessModelFit`'s native-fit path run on every engine that ships a fitter, not llama.cpp only. `assessModelFit` infers `modelType` from `modelSrc` when omitted. Each model result can carry `device` (`gpu` or `cpu`) and `reasons`. `getLoadedModelInfo().fitProbe.projection` is a flat byte breakdown. `fitStubBudgetMs` on config (default 40000) is the registry-fetch budget for the weightless description.

```typescript
import { assessModelFit, getLoadedModelInfo, QWEN3_8B_INST_Q4_K_M } from '@qvac/inference'

const result = await assessModelFit({
  models: [{ modelSrc: QWEN3_8B_INST_Q4_K_M, modelConfig: { ctx_size: 8192 } }]
})
result.models[0].device // 'gpu' | 'cpu', where the load resolved
result.models[0].reasons

const info = await getLoadedModelInfo({ modelId })
info.fitProbe?.projection?.deviceBytes
info.fitProbe?.projection?.hostBytes
info.fitProbe?.projection?.report
```

---

## Update @qvac/tts-ggml to 0.10.0 and add the MOSS engine

PR: [#4723](https://github.com/tetherto/qvac/pull/4723)

```typescript
import {
  loadModel,
  textToSpeech,
  TTS_DELAY_LLM_MOSS_TTS_F16,
  TTS_CODEC_DECODER_MOSS_TTS_F16,
  TTS_CODEC_ENCODER_MOSS_TTS_F16
} from '@qvac/inference'

// MOSS-TTS: directable speech, optional voice cloning, native chunk streaming.
const modelId = await loadModel({
  modelSrc: TTS_DELAY_LLM_MOSS_TTS_F16,
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'moss',
    mossCodecDecoderModelSrc: TTS_CODEC_DECODER_MOSS_TTS_F16,
    mossCodecEncoderModelSrc: TTS_CODEC_ENCODER_MOSS_TTS_F16, // only to clone
    referenceAudioSrc: '/voices/speaker-24k.wav', // optional, 24 kHz
    streamChunkTokens: 25 // a chunk every 2 s of audio
  }
})

const result = textToSpeech({
  modelId,
  text: 'Hold on [pause 1.0s] here it comes.'
})
for await (const sample of result.bufferStream) {
  // 24 kHz PCM, arriving while the backbone is still generating
}

// MOSS-TTSD: multi-speaker dialogue. The text opens with each reference's
// transcript under its tag: '[S1] … [S2] … [S1] new line [S2] new line'.
await loadModel({
  modelSrc: '/models/moss-ttsd-f16.gguf',
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'moss',
    mossCodecDecoderModelSrc: TTS_CODEC_DECODER_MOSS_TTS_F16,
    mossCodecEncoderModelSrc: TTS_CODEC_ENCODER_MOSS_TTS_F16,
    dialogueReferenceSrcs: ['/voices/alice.wav', '/voices/bob.wav']
  }
})
```

---

## Add SDK-managed RPC servers and discovery

PR: [#4774](https://github.com/tetherto/qvac/pull/4774)

```ts
import {
  startRpcServer,
  stopRpcServer,
  discoverRpcServers,
  getRpcDeviceMap,
  loadModel,
  unloadModel
} from '@qvac/inference'

const server = await startRpcServer({
  host: '10.0.0.2',
  allowNonLoopbackHost: true,
  discoveryTopic: 'my-private-rpc-group'
})

// On the initiator, use exactly this endpoint order for this load.
const selected = (await discoverRpcServers({ topic: 'my-private-rpc-group' }))
  .sort((a, b) => a.url.localeCompare(b.url))
  .slice(0, 2)
if (selected.length !== 2) throw new Error('Two idle servers are required')
const devices = getRpcDeviceMap(selected)
const modelId = await loadModel({
  modelSrc,
  modelConfig: {
    device: 'gpu',
    'rpc-servers': selected.map((s) => s.url).join(','),
    devices: devices.map((d) => d.alias).join(','),
    'split-mode': 'layer',
    'tensor-split': devices.map(() => '1').join(',')
  }
})
await unloadModel({ modelId })
await stopRpcServer({ serverId: server.serverId })
```

Workers bind to loopback unless `allowNonLoopbackHost` is set. The channel is unauthenticated. Prebuilds use TCP; RDMA needs client and worker rebuilt on Linux with RDMA enabled. The current limit is 16 devices. Only the machine loading the model needs the model file.

New package exports: `@qvac/inference/rpc-server-provider` and `@qvac/inference/ggml-rpc-server/provider`. `registerRpcServerProvider` and `RpcServerOperationError` are on the public surface.

---

## Stage the Audio8 Core ML codec sidecar on Apple and report where the codec ran

PR: [#4799](https://github.com/tetherto/qvac/pull/4799)

```typescript
import {
  loadModel,
  textToSpeech,
  TTS_LM_MULTILINGUAL_AUDIO8_Q8_0,
  TTS_CODEC_DECODER_AUDIO8_Q8_0
} from '@qvac/inference'

// On macOS / iOS the decoder now downloads with its Core ML bundle beside it.
const modelId = await loadModel({
  modelSrc: TTS_LM_MULTILINGUAL_AUDIO8_Q8_0,
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: TTS_CODEC_DECODER_AUDIO8_Q8_0
  }
})

const result = textToSpeech({ modelId, text: 'Hello', stream: false })
const stats = await result.stats
stats?.codecSidecarLoaded // 1 while the Core ML codec sidecar is attached
stats?.codecOnCoreml // 1 when this synthesis ran its codec on Core ML, 0 on ggml
```
