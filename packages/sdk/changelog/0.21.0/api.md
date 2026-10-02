# 🔌 API Changes v0.21.0

## Opt-in deferred tool loading and tool_search

PR: [#4602](https://github.com/tetherto/qvac/pull/4602)

A tool may set `deferLoading: true` (or an MCP client entry, to defer all its tools). The first prompt then carries only always-loaded tools and a built-in `tool_search` whose description lists the deferred tools by name and description. When the model calls `tool_search`, run `executeToolSearch()` and push its result as a `tool` message; the matching definitions are callable from the next turn. `completion()` stays stateless and reads the loaded set back from history, so keep that message. Tools without the flag are unchanged.

```typescript
import { completion, executeToolSearch, TOOL_SEARCH_NAME } from '@qvac/sdk'

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
import { getLoadedModelInfo } from '@qvac/sdk'

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
import { assessModelFit, getLoadedModelInfo, QWEN3_8B_INST_Q4_K_M } from '@qvac/sdk'

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

## Auto-install addon platform packages for mobile bundles

PR: [#4688](https://github.com/tetherto/qvac/pull/4688)

```typescript
import { bundleSdk, ensureHostPrebuilds } from '@qvac/sdk/commands'

await ensureHostPrebuilds({ projectRoot, hosts: ['android-arm64'] })
await bundleSdk({
  projectRoot,
  hosts: ['android-arm64'],
  installMissingPrebuilds: true
})
```

```json
{
  "expo": {
    "plugins": [["@qvac/sdk/expo-plugin", { "installMissingPrebuilds": true }]]
  }
}
```

`qvac bundle sdk` installs by default; `--no-install` skips it. New error codes: `HOST_PREBUILDS_INSTALL_REFUSED` (50615), `HOST_PREBUILDS_INSTALL_FAILED` (50616).

---

## Check engines.bare against the Bare runtime each host runs

PR: [#4710](https://github.com/tetherto/qvac/pull/4710)

```typescript
import { verifyBundle, formatEnginesAdvice } from '@qvac/sdk/commands'

const result = await verifyBundle({
  projectRoot,
  addonsSource: 'qvac/worker.bundle.js',
  hosts: ['android-arm64'],
  network: true,
  onProgress: (message) => console.error(message)
})
result.runtimes // per host group: Bare version and where it came from
for (const advice of result.advice ?? []) console.log(formatEnginesAdvice(advice).join('\n'))
```

Android/iOS hosts resolve Bare from `react-native-bare-kit`. The check runs after `qvac bundle sdk` (warning), in `qvac verify bundle` and the Expo plugin (error), and as a `qvac doctor` project check. `--offline` skips network steps.

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
} from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: TTS_DELAY_LLM_MOSS_TTS_F16,
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'moss',
    mossCodecDecoderModelSrc: TTS_CODEC_DECODER_MOSS_TTS_F16,
    mossCodecEncoderModelSrc: TTS_CODEC_ENCODER_MOSS_TTS_F16,
    referenceAudioSrc: '/voices/speaker-24k.wav',
    streamChunkTokens: 25
  }
})

const result = textToSpeech({
  modelId,
  text: 'Hold on [pause 1.0s] here it comes.'
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
} from '@qvac/sdk'

const server = await startRpcServer({
  host: '10.0.0.2',
  allowNonLoopbackHost: true,
  discoveryTopic: 'my-private-rpc-group'
})

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

---

## Stage the Audio8 Core ML codec sidecar on Apple and report where the codec ran

PR: [#4799](https://github.com/tetherto/qvac/pull/4799)

```typescript
import {
  loadModel,
  textToSpeech,
  TTS_LM_MULTILINGUAL_AUDIO8_Q8_0,
  TTS_CODEC_DECODER_AUDIO8_Q8_0
} from '@qvac/sdk'

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
