# QVAC Inference v0.21.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.21.0

QVAC Inference 0.21.0 is the engine cut that SDK 0.21.0 will depend on. A model can split across machines through llama.cpp's RPC backend, Ternary Bonsai 2 27B runs in QVAC's engine, tools can defer their schemas behind `tool_search`, and TTS/ASR pick up MOSS plus Parakeet Core ML on Apple. Catalog constant names for BitNet, Llama tool-calling, and Indic Parakeet change. `assessModelFit` now takes `loadModel` fields instead of a separate workload object.

Publish this package before `@qvac/sdk@0.21.0`. The SDK release points its `@qvac/inference` range at this version.

## Breaking Changes

### `assessModelFit` uses loadModel parameters

Candidates are described the same way as a load: `modelSrc`, `modelType`, and `modelConfig`. The old `model` / `workload` / `artifacts` object is rejected.

**Before:**

```typescript
await assessModelFit({
  models: [
    {
      model: LLAMA_3_2_1B,
      workload: { kind: 'llm', contextTokens: 4096 },
      artifacts: [MMPROJ_F16]
    }
  ]
})
```

**After:**

```typescript
await assessModelFit({
  models: [
    {
      modelSrc: LLAMA_3_2_1B,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 4096, projectionModelSrc: MMPROJ_F16 }
    }
  ]
})
```

`modelType` is required. A load whose sources are all config fields may omit `modelSrc`. Audio `workload.windowMs` becomes `modelConfig.duration_ms`. `workload.batch` has no equivalent and is gone: no engine takes a batch size at load time.

### Catalog constant names

BitNet instructed TQ2_0 exports are retagged as base. Llama tool-calling 1B moves from `Q4_K` to `Q4_K_M`. Indic Parakeet Conformer CTC constants are replaced by the 600M GGUFs.

**Before:**

```typescript
import { BITNET_0_7B_INST_TQ2_0 } from '@qvac/inference'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K } from '@qvac/inference'
import { PARAKEET_INDIC_CONFORMER_CTC_Q4_0 } from '@qvac/inference'
```

**After:**

```typescript
import { BITNET_0_7B_BASE_TQ2_0 } from '@qvac/inference'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K_M } from '@qvac/inference'
import { PARAKEET_INDIC_CONFORMER_600M_Q4_0 } from '@qvac/inference'
```

## New APIs

### Clustered inference over RPC

`startRpcServer` starts a worker-owned llama.cpp RPC server. `discoverRpcServers` finds peers on a private topic and `getRpcDeviceMap` builds the `devices` string `loadModel` expects. One model splits across several machines, phones included, by layer or within a layer. Only the initiator needs the model file.

```typescript
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

const selected = (await discoverRpcServers({ topic: 'my-private-rpc-group' }))
  .sort((a, b) => a.url.localeCompare(b.url))
  .slice(0, 2)
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

Workers bind to loopback unless `allowNonLoopbackHost` is set. The channel is unauthenticated. Prebuilds use TCP; RDMA needs client and worker rebuilt on Linux with RDMA enabled. The current limit is 16 devices.

`@qvac/inference/rpc-server-provider` and `@qvac/inference/ggml-rpc-server/provider` are new subpath exports. `registerRpcServerProvider` and `RpcServerOperationError` are on the public surface.

### Deferred tool loading

Set `deferLoading: true` on a tool (or on an MCP client entry) so the first prompt carries only always-loaded tools, a built-in `tool_search`, and a short catalog of names and one-line descriptions grouped by `group`. The model searches once, the engine appends the matching definitions as a tool result, and the model calls them natively on its next step. Tools without the flag work as they do today. `completion()` stays stateless and reads loaded tools back from history, so reopened chats keep them and concurrent chats cannot mix.

```typescript
completion({
  modelId,
  history,
  tools: [
    { type: 'function', name: 'get_weather', description: '...', parameters },
    {
      type: 'function',
      name: 'create_issue',
      description: 'Open a new issue on a repository',
      group: 'github',
      deferLoading: true,
      parameters
    }
  ]
})
```

`tool_search` is reserved. `generationParams.tool_choice` cannot name a deferred tool.

### MOSS TTS

`tts-ggml` 0.10.0 adds the MOSS engine. MOSS-TTS-v1.5 is directable (explicit pause and duration, Pinyin/IPA, optional voice cloning). MOSS-TTSD synthesizes 1 to 5 speakers in one pass. The Delay engine streams chunks so playback can start while generation continues.

```typescript
import {
  loadModel,
  textToSpeech,
  TTS_DELAY_LLM_MOSS_TTS_F16,
  TTS_CODEC_DECODER_MOSS_TTS_F16,
  TTS_CODEC_ENCODER_MOSS_TTS_F16
} from '@qvac/inference'

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

On Apple, Audio8 now stages its Core ML codec sidecar and reports `codecSidecarLoaded` / `codecOnCoreml` on synthesis stats.

### ABot-World layer streaming

World-mode `modelConfig.world` accepts `paramsBackend`, `maxVram`, `streamLayers`, and the rest of the placement fields so an ABot-World graph can stream layers the same way other diffusion loads do.

```typescript
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

### Loaded-model fit probe

`getLoadedModelInfo` can include `fitProbe`: verdict, per-device projection, and the placement the fitter resolved, judged against the memory the system reports free.

### BCI stream placement and diagnostics

`bciTranscribe` terminal frames can carry `diagnostics`. Streamed BCI segments expose `windowStartTimestep` so window-local timestamps can be placed on the stream timeline.

## Features

Ternary Bonsai 2 27B (PTQ1_0 at 5.95 GB, PQ2_0 at 7.21 GB) loads through the qvac-fabric engine with the matching rotation applied at run time. CPU (x86 AVX2/VNNI, ARM, portable fallback), Metal, CUDA, HIP, and Vulkan are in scope. A load-time check refuses rotated files on architectures that cannot apply the rotation.

Parakeet GGUFs on Apple download their Core ML sidecars beside the weights. ACE-Step AudioGen packings and additional CosyVoice3 flow/hift/LLM constants are on the catalog.

Llama `gpu_layers` is unset by default so qvac-fabric can place layers to free device memory. Setting `gpu_layers` still pins the count and aborts that fit.

Hyperdrive model downloads stay inside the model cache. NMT `translate()` stats are per-request. Fused TTS export names come from registry tags. `bare-runtime` is `^1.30.3` so a retained lockfile cannot keep 1.24.x next to `engines.bare` `>=1.30.3`.

## Bug Fixes

Loaded deferred tools run under the tool-call grammar instead of text parsing on the search-to-call step.

## Model Changes

### Added

```
AUDIOGEN_ACESTEP_5HZ_LM_0_6B_BF16
AUDIOGEN_ACESTEP_V15_BASE_Q4_K_M
BITNET_0_7B_BASE_TQ2_0
BITNET_1B_BASE_TQ2_0
BITNET_B1_58_3B_BASE_TQ2_0
LLAMA_TOOL_CALLING_1B_INST_Q4_K_M
PARAKEET_INDIC_CONFORMER_600M_F16
PARAKEET_INDIC_CONFORMER_600M_Q4_0
PARAKEET_INDIC_CONFORMER_600M_Q8_0
PARAKEET_TDT_1_1B_F16
PARAKEET_TDT_1_1B_Q8_0
TERNARY_BONSAI_2_27B_MULTIMODAL_PQ2_0
TERNARY_BONSAI_2_27B_MULTIMODAL_PTQ1_0
TTS_CODEC_DECODER_MOSS_TTS_F16
TTS_CODEC_ENCODER_MOSS_TTS_F16
TTS_COSYVOICE3_FLOW_COSYVOICE_BF16
TTS_COSYVOICE3_FLOW_COSYVOICE_FP16
TTS_COSYVOICE3_FLOW_COSYVOICE_Q4_0
TTS_COSYVOICE3_FLOW_COSYVOICE_Q8_0
TTS_COSYVOICE3_HIFT_COSYVOICE_FP16
TTS_COSYVOICE3_LLM_COSYVOICE_FUSED_Q8_0
TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0
TTS_DELAY_LLM_MOSS_TTS_F16
```

### Removed

```
BITNET_0_7B_INST_TQ2_0
BITNET_1B_INST_TQ2_0
BITNET_B1_58_3B_INST_TQ2_0
LLAMA_TOOL_CALLING_1B_INST_Q4_K
PARAKEET_INDIC_CONFORMER_CTC_F16
PARAKEET_INDIC_CONFORMER_CTC_Q4_0
PARAKEET_INDIC_CONFORMER_CTC_Q8_0
```

Peer floors that move with this cut: `@qvac/llm-llamacpp` `0.55.0`, `@qvac/asr-ggml` `^0.7.0`, `@qvac/tts-ggml` `^0.10.0`, `@qvac/audiogen-ggml` `^0.5.0`, `@qvac/bci-whispercpp` `^0.10.0`, `@qvac/decoder-audio` `^0.7.0`, `@qvac/translation-nmtcpp` `0.18.0`, `@qvac/ggml-rpc-server` `0.1.0`.
