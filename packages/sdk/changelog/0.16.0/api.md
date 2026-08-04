# 🔌 API Changes v0.16.0

## Add Ideogram 4 diffusion support

PR: [#3287](https://github.com/tetherto/qvac/pull/3287)

```typescript
const modelId = await loadModel({
  modelSrc: IDEOGRAM_MODEL_URL,
  modelType: 'sdcpp-generation',
  modelConfig: {
    llmModelSrc: QWEN3_VL_MODEL_URL,
    vaeModelSrc: VAE_MODEL_URL,
    uncondModelSrc: IDEOGRAM_UNCOND_MODEL_URL
  }
})
```

---

## Add per-phase diffusion timing stats

PR: [#3317](https://github.com/tetherto/qvac/pull/3317)

```typescript 
const { stats } = await result
console.log(stats.conditionerMs) // prompt conditioning time (ms)
console.log(stats.denoiseMs)     // denoising loop time (ms)
console.log(stats.vaeMs)         // VAE decode time (ms)
console.log(stats.postProcessMs) // encode/upscale/mux time (ms)
console.log(stats.stepsPerSecond) // denoising throughput (steps/s)
```

---

## Full-fidelity Python SDK client

PR: [#3354](https://github.com/tetherto/qvac/pull/3354)

> **Note:** Not yet published — this client has landed in the SDK source but is not yet available as an installable package.

```python
from tetherto.qvac_sdk import Client, load_model, completion
from tetherto.qvac_sdk.models import LLAMA_3_2_1B_INST_Q4_0

async with Client() as client:
    t = client.transport
    model_id = await load_model(t, model_src=LLAMA_3_2_1B_INST_Q4_0)
    run = completion(t, model_id=model_id, history=[{"role": "user", "content": "hi"}])
    async for event in run.events:
        ...
    final = await run.final
```

---

## First-class GR00T exposure in VLA SDK (registry + hparams + docs)

PR: [#3362](https://github.com/tetherto/qvac/pull/3362)

```ts
import { loadModel, vlaHparams, vla, vlaPadState } from '@qvac/sdk'

const modelId = await loadModel({ modelSrc, modelType: 'ggml-vla' })
const { hparams } = await vlaHparams({ modelId })

if (hparams.imageInputMode === 'patches') {
  // GR00T: each images[] entry is a pre-patchified buffer of imagePatchElems floats
  const images = Array.from({ length: hparams.numCameras }, () =>
    new Float32Array(hparams.imagePatchElems)
  )
  const state = vlaPadState(robotState, hparams.maxStateDim)
  const noise = new Float32Array(hparams.chunkSize * hparams.maxActionDim)

  const { actions, actionDim, chunkSize } = await vla({
    modelId,
    images,
    imgWidth: hparams.visionImageSize,
    imgHeight: hparams.visionImageSize,
    state,
    tokens, // Qwen3-VL tokens, length hparams.tokenizerMaxLength
    mask,
    noise
  })
}
```

---

