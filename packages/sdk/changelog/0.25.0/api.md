# 🔌 API Changes v0.25.0

## Forward diffusion performance profile options

PR: [#5577](https://github.com/tetherto/qvac/pull/5577)

```typescript
const modelId = await loadModel({
  modelSrc: LTX_2_3_22B_Q5_K_M,
  modelType: 'diffusion',
  modelConfig: {
    mode: 'video',
    // ...LTX-2 companion sources
    performance_profile: 'auto', // the default; 'off' keeps the engine defaults
    performance_max_width: 512,
    performance_max_height: 320,
    performance_max_frames: 97
  }
})
```

---

## Expose TurboVec IVF search controls in the SDK

PR: [#5745](https://github.com/tetherto/qvac/pull/5745)

```typescript
import { createVectorIndex, VectorIndexStorage } from '@qvac/sdk'

await using index = await createVectorIndex({ dim: 768, storage: VectorIndexStorage.TURBOVEC_Q4 })
await index.add({ ids, vectors })

await index.setIvf({ nLists: 64, nProbe: 8 })
console.log(index.ivf) // { nLists: 64, nProbe: 8, built: true }

const hits = await index.search({ query, k: 10 })
const wider = await index.search({ query, k: 10, nProbe: 32 }) // per-call override

await index.setIvf(null) // back to a full scan
```

---

## Expose BridgeDepth stereo depth through the SDK

PR: [#5795](https://github.com/tetherto/qvac/pull/5795)

```typescript
import { loadModel, estimateDisparity, unloadModel, ModelType } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: '/models/bridgedepth-vits-f32.gguf',
  modelType: ModelType.ggmlStereoDepth
})

const { width, height, disparity, stats } = await estimateDisparity({
  modelId,
  left: fs.readFileSync('left.png'),
  right: fs.readFileSync('right.png')
})

// depth (m) = focalPx * baselineMeters / disparity
const centre = disparity[(height >> 1) * width + (width >> 1)]
await unloadModel({ modelId })
```

---

## Bound shared-runtime operations with deadlines

PR: [#5850](https://github.com/tetherto/qvac/pull/5850)

```ts
const run = completion({
  modelId,
  history,
  stream: true,
  rpcOptions: { deadline: { queueMs: 10_000, idleMs: 90_000, runMs: 600_000 } }
})
// rejects with DeadlineExceededError { boundary: 'idle', timeoutMs: 90000, capability: 'completion' }
```

```json
{
  "deadlines": {
    "capabilities": {
      "default": { "queueMs": 120000, "idleMs": 60000 },
      "video-generation": { "idleMs": null }
    },
    "load": { "loadMs": 300000 }
  }
}
```

---

## Report the runtime's capability contracts and major versions

PR: [#5851](https://github.com/tetherto/qvac/pull/5851)

```ts
import { CAPABILITY_CONTRACTS, getRuntimeCapabilities } from '@qvac/sdk'

const capabilities = await getRuntimeCapabilities()
// [{ id: 'transcription', version: 1, operations: ['transcribe'], partialOperations: ['transcribeStream'] }, ...]
const { id, version } = CAPABILITY_CONTRACTS.transcription
const ok = capabilities.some((c) => c.id === id && c.version === version)
```

---

## Deprecate history attachments in favor of ordered content parts

PR: [#5858](https://github.com/tetherto/qvac/pull/5858)

```typescript
// Deprecated: every image is sent before the text
{ role: 'user', content: 'Compare these.', attachments: [{ path: a }, { path: b }] }

// Ordered parts: each image stays where the text refers to it
{
  role: 'user',
  content: [
    { type: 'text', text: 'Compare ' },
    { type: 'media', path: a },
    { type: 'text', text: ' with ' },
    { type: 'media', path: b }
  ]
}
```

---

## Judge model fit on shared memory and report why a fit is unknown

PR: [#5860](https://github.com/tetherto/qvac/pull/5860)

```typescript
const result = await assessModelFit({
  models: [
    { modelSrc: TTS_EN_SUPERTONIC_Q8_0, modelConfig: { ttsEngine: 'supertonic', language: 'en' } }
  ]
})
result.models[0].reason // 'the engine fitter could not size this load', present when status is 'unknown'

try {
  await assessModelFit({ models: [{ modelSrc: MMPROJ_QWEN3_8_27B_MULTIMODAL_F16 }] })
} catch (error) {
  error.code // SDK_SERVER_ERROR_CODES.MODEL_FIT_REJECTED (52213)
}
```

---

## Add qvac fit

PR: [#5861](https://github.com/tetherto/qvac/pull/5861)

```bash
qvac fit QWEN3_8B_INST_Q4_K_M QWEN3_600M_INST_Q4 --set QWEN3_8B_INST_Q4_K_M:ctx_size=0
qvac fit BERGAMOT_DE_EN --set engine=Bergamot --set from=de --set to=en --json
qvac fit --catalog --set llamacpp-completion:ctx_size=0 --json
```

```jsonc
// POST /qvac/v1/models/fit, models[] entry
{
  "model": "TTS_EN_SUPERTONIC_Q8_0",
  "status": "unknown",
  "devices": [],
  "stats": {},
  "reason": "the engine fitter could not size this load"
}
```

---

## Enforce capability grants for each runtime session

PR: [#5872](https://github.com/tetherto/qvac/pull/5872)

```ts
import { openSession, capabilityPermissions, CAPABILITY_CONTRACTS } from '@qvac/sdk'

const skills = openSession({
  name: 'skill-runner',
  grant: ['transcription/transcribe', ...capabilityPermissions(CAPABILITY_CONTRACTS.translation)]
})
await skills.transcribe({ modelId, audioChunk }) // allowed
await skills.transcribeStream({ modelId }) // CapabilityNotGrantedError
```

---

## Forward the Core ML FFN load options for Qwen3.5

PR: [#5879](https://github.com/tetherto/qvac/pull/5879)

```typescript
const modelId = await loadModel({
  modelSrc: QWEN3_5_2B_MULTIMODAL_Q4_K_M,
  modelType: 'llm',
  modelConfig: {
    'coreml-ffn': true,
    'coreml-ffn-cache': '/path/to/app/cache/coreml-ffn', // optional
    'coreml-ffn-split': '3072x1' // optional override of the automatic 2048x1
  }
})
```

---

## Move the SDK onto the fabric 0.31 addon set with the new speech addons

PR: [#5880](https://github.com/tetherto/qvac/pull/5880)

```typescript
import { ASR_BACKEND_IDS } from '@qvac/sdk'

ASR_BACKEND_IDS.WebGPU // 5, reported in stats.backendId by asr-ggml 0.13.0
```

---

## Support TranslatePsy-AfriNano and -EuroNano Bergamot packs

PR: [#5908](https://github.com/tetherto/qvac/pull/5908)

```typescript
import { loadModel, translate } from '@qvac/sdk'

// Local HF download: vocab.spm is found beside the model, ##SW is added for you.
const modelId = await loadModel({
  modelSrc: '/models/TranslatePsy-AfriNano/en-xx/Base/intgemm/model.intgemm.alphas.bin',
  modelType: 'nmt',
  modelConfig: { engine: 'Bergamot', from: 'en', to: 'sw' }
})
const { text } = translate({ modelId, text: 'Good morning', modelType: 'nmt', stream: false })

// A renamed or bundled copy of an en-xx pack: opt in explicitly.
await loadModel({
  modelSrc: '/app/assets/afri-en/model.intgemm.alphas.bin',
  modelType: 'nmt',
  modelConfig: { engine: 'Bergamot', from: 'en', to: 'yo', targetTag: true }
})
```

---

## Run Stable Diffusion on Core ML through the SDK with diffusion-cpp 0.38.0

PR: [#5928](https://github.com/tetherto/qvac/pull/5928)

```typescript
const modelId = await loadModel({
  modelSrc: SD_V2_1_1B_Q8_0,
  modelType: 'diffusion',
  modelConfig: {
    prediction: 'eps', // the SD 2.1-base sidecar predicts epsilon
    coremlUnetModelSrc: '/models/sd21base_unet_p6.mlmodelc',
    taesdModelSrc: '/models/taesd.safetensors',
    coremlTaeDecoderModelSrc: '/models/taesd_decoder.mlmodelc'
  }
})
```

---

## Accept spec_type 'draft-dspark' and 'auto' in the SDK

PR: [#5945](https://github.com/tetherto/qvac/pull/5945)

```typescript
const modelId = await loadModel({
  modelSrc: DEEPSEEK_V4_1_552B_A16B_MULTIMODAL_Q4_K_M_SHARD,
  modelType: 'llm',
  modelConfig: {
    spec_type: 'draft-dspark', // or "auto" to read the type from the draft model
    draftModelSrc: DEEPSEEK_V4_1_552B_A16B_DSPARK_Q8_0
  }
})
```

---

## Stage the full TranscribePsy EU Core ML bundles through the SDK

PR: [#5956](https://github.com/tetherto/qvac/pull/5956)

```typescript
import { loadModel, transcribe, PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0 } from '@qvac/sdk'

// On macOS and iOS the model's published Core ML bundles are staged beside the GGUF.
const modelId = await loadModel({
  modelSrc: PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0,
  modelType: 'parakeet-transcription',
  modelConfig: { language: 'auto' }
})

const call = transcribe({ modelId, audioChunk: '/path/to/recording.wav' })
const stats = await call.stats
stats?.encoderUsedCoreml // 1 when this run encoded on Core ML
stats?.decoderUsedCoreml // new: 1 when every transcription decoded on the Core ML decoder
```

```typescript
import { getModelCacheLayout } from '@qvac/inference/model-cache-layout'

// New optional darwinMajor: 24 (macOS 15, iOS 18) lists the shared-weight bundle, 23 the fixed encoders.
const layout = getModelCacheLayout(model, 'darwin', shortHash, 23)
```

---

## Python and Kotlin clients

Hand-added from the published-version audit. The clients ship at the SDK's version and have no changelog of their own.

### Python client

```python
from tetherto.qvac_sdk import (
    CapabilityId,
    GetRuntimeCapabilitiesRequest,
    completion,
    get_runtime_capabilities,
    with_deadline,
)

# Capability contracts the runtime provides (#5851)
response = await get_runtime_capabilities(client.transport, GetRuntimeCapabilitiesRequest())
provided = {(c.id, c.version) for c in response.capabilities}
ok = (CapabilityId.transcription.value, 1) in provided

# A session limited to the listed permissions (#5872)
session = await client.open_session("skill-runner", grant=["transcription/transcribe"])
session.grant  # ("transcription/transcribe",); None when unrestricted
# raises SessionGrantInvalidError at open, CapabilityNotGrantedError on a call outside the grant

# Deadlines the runtime enforces (#5850)
bounded = with_deadline(client.transport, queue_ms=10_000, idle_ms=90_000)
run = completion(bounded, model_id=model_id, history=history)
# raises DeadlineExceededError; error.boundary is "queue", "load", "run" or "idle"
```

```python
# IVF search on a vector index (#5745)
ivf_set = await vector_index(
    client.transport,
    VectorIndexRequest.model_validate(
        {
            "type": "vectorIndex",
            "operation": "setIvf",
            "indexId": index_id,
            "ivf": {"nLists": 4, "nProbe": 1},
        }
    ),
)
ivf_set.root.ivf  # n_lists, n_probe, built
```

### Kotlin client

```kotlin
import io.tether.qvac.sdk.declares
import io.tether.qvac.sdk.generated.schema.CapabilityId
import io.tether.qvac.sdk.openSession
import io.tether.qvac.sdk.system

// Capability contracts the runtime provides (#5851)
val capabilities = client.system.runtimeCapabilities()
val ok = capabilities.declares(CapabilityId.TRANSCRIPTION, 1L)

// A session limited to the listed permissions (#5872)
val session = client.openSession(name = "skill-runner", grant = listOf("transcription/transcribe"))
session.grant // null when unrestricted

// Deadlines the runtime enforces (#5850): each request type that registers work takes one
val request = CompletionStreamRequest(
    modelId = modelId,
    history = history,
    deadline = RequestDeadline(queueMs = 10_000, idleMs = 90_000),
)

// IVF search on a vector index (#5745)
val ivfSet = client.vectorIndex(
    VectorIndexRequest.SetIvf(
        VectorIndexRequestSetIvf(indexId = indexId, ivf = VectorIndexIvfSettings(nLists = 4, nProbe = 1)),
    ),
) as VectorIndexResponse.SetIvf
```

```kotlin
// Deprecated (#5858): QvacAttachment, QvacMessage.attachments and QvacMessage.user(content, attachments)
QvacMessage.user("Compare these.", listOf(QvacAttachment(a), QvacAttachment(b)))

// Ordered parts keep each image where the text refers to it
QvacMessage.user(
    listOf(
        QvacContentPart.Text("Compare "),
        QvacContentPart.Media(a),
        QvacContentPart.Text(" with "),
        QvacContentPart.Media(b),
    ),
)
```

`QvacCapability.STEREO_DEPTH` is added to the runtime profile for the `ggml-stereo-depth` plugin (#5795).

---
