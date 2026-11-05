# 🔌 API Changes v0.23.0

## Let a log subscription be closed with an abort signal

PR: [#4959](https://github.com/tetherto/qvac/pull/4959)

`loggingStream()` takes `AbortableRPCOptions` (`RPCOptions` plus `signal`). Aborting ends the stream without an error and unregisters the subscription at once, even for a model that logs nothing more. `subscribeServerLogs()`'s `unsubscribe()` and unloading a model now release their subscriptions the same way. Other APIs do not take `signal`; stop an inference run with `cancel`. `untilAborted`, `AbortSignalLike` and `AbortableRPCOptions` are exported.

```typescript
import { AbortController } from 'bare-abort-controller'
import { loggingStream, subscribeServerLogs } from '@qvac/inference'

const controller = new AbortController()

for await (const log of loggingStream({ id: modelId }, { signal: controller.signal })) {
  console.log(log.message)
}

// elsewhere
controller.abort()

// Unchanged signature; now releases the subscription without waiting for another log.
const unsubscribe = subscribeServerLogs((log) => console.log(log.message))
unsubscribe()
```

---

## Assess ESRGAN and ABot world memory fit

PR: [#5038](https://github.com/tetherto/qvac/pull/5038)

The diffusion fitter now assesses ESRGAN upscalers and ABot-World loads. `world.fitSteps` (default 100) sets the walk length the fit covers; it does not limit generation or retained history.

```typescript
await loadModel({
  modelSrc: ABOT_WORLD_0_5B_Q8_0,
  modelConfig: {
    mode: 'world',
    taehvModelSrc: ABOT_WORLD_0_5B_LF_TAEHV_VAE,
    sceneSrc: '/path/to/scene.safetensors',
    world: { fitSteps: 200 }
  }
})
```

---

## Expose the prompt-cache keys in the llm load config

PR: [#5124](https://github.com/tetherto/qvac/pull/5124)

New llm `modelConfig` keys: `cache_checkpoints` (0–1024), `cache_checkpoints_max_bytes`, `cache_checkpoint_storage` (`'memory'` or `'disk'`), `cache_checkpoint_dir` and `cache_ram_mib`. Unset keys keep the addon defaults.

```typescript
await loadModel({
  modelSrc: QWEN3_5_0_8B_MULTIMODAL_Q8_0,
  modelConfig: {
    ctx_size: 8192,
    cache_checkpoints: 2, // also serve an edit of the last user message (default 1)
    cache_checkpoints_max_bytes: 512 * 1024 * 1024,
    cache_checkpoint_storage: 'disk',
    cache_checkpoint_dir: appCacheDir,
    cache_ram_mib: 1024 // keep switched-away kvCache conversations in RAM
  }
})
```

---

## Expose CPU polling controls for llama.cpp models

PR: [#5216](https://github.com/tetherto/qvac/pull/5216)

Completion, embedding, decision and rerank configs accept `poll` and `pollBatch` (integers 0–100). The llama.cpp addons now default to sleeping CPU workers; higher values may reduce wake latency but use more CPU during GPU work.

With these addon versions, `threads-batch` applies only to steps that process several tokens (prompt processing, parallel decoding, speculative verification); single-sequence generation uses `threads`. `cpu-mask` always applies to generation, and `cpu-mask-batch` inherits `cpu-mask` when the batch thread count is unset. A config that set only `threads-batch` to size generation should set `threads` as well.

```typescript
import { loadModel } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: '/path/to/model.gguf',
  modelType: 'llamacpp-completion',
  modelConfig: {
    poll: 50,
    pollBatch: 0
  }
})
```

---

## Expose llm-llamacpp speculative decoding

PR: [#5261](https://github.com/tetherto/qvac/pull/5261)

New llm `modelConfig` keys: `spec_type` (`'none'`, `'draft-mtp'`, `'draft-dflash'`), `spec_draft_n_max`, `spec_draft_n_min`, `spec_draft_p_min` and `draftModelSrc`. A load that sets `draftModelSrc` without a drafting `spec_type` is rejected before the draft model downloads. Completion stats report `draftTokens` and `draftAcceptedTokens`.

```typescript
const modelId = await loadModel({
  modelSrc: QWEN3_5_4B_MULTIMODAL_Q4_K_M,
  modelType: 'llm',
  modelConfig: {
    spec_type: 'draft-dflash', // or 'draft-mtp': the model's own MTP layers, or an external head as draftModelSrc
    draftModelSrc: QWEN3_5_4B_DFLASH_Q8_0,
    spec_draft_n_max: 15
  }
})

const { stats } = await completion({ modelId, history }).final
stats?.draftTokens // drafted
stats?.draftAcceptedTokens // kept by the model
```

---

## Add reranking with a llamacpp-rerank model type and rerank()

PR: [#5285](https://github.com/tetherto/qvac/pull/5285)

The `llamacpp-rerank` model type runs reranker GGUFs on `@qvac/embed-llamacpp`, and `rerank({ modelId, query, documents })` returns one raw score per document, in input order. Scores are the model's raw classifier output, so compare them within one model only. The model registry has no reranker yet, so pass your own reranker GGUF as a path or URL.

Each model runs one rerank at a time and queues up to 64 calls; beyond that a call rejects with `RequestRejectedByPolicyError`. The returned promise carries a `requestId` for `cancel()`, and `rerank` is a cancel kind. The load config accepts `device` (default `'gpu'`), `gpu_layers`, `batch_size`, `backend`, threads, polling and the multi-GPU keys, and rejects anything else.

New exports: `rerank`, `rerankPlugin` (`@qvac/inference/llamacpp-rerank/plugin`), `PLUGIN_RERANK`, `rerankConfigBaseSchema`, and the types `RerankParams`, `RerankScores`, `RerankConfig` and `RerankConfigInput`. `PLUGIN_RERANK` is in `BUILTIN_PLUGINS`.

```typescript
import { registerPlugin, loadModel, rerank, unloadModel } from '@qvac/inference'
import { rerankPlugin } from '@qvac/inference/llamacpp-rerank/plugin'

registerPlugin(rerankPlugin)

// User-supplied reranker GGUF: the registry has no reranker constant.
const modelId = await loadModel({ modelSrc: '/models/reranker.gguf', modelType: 'llamacpp-rerank' })
const documents = ['Paris is the capital of France.', 'Plants convert sunlight into energy.']
// One score per document, in input order; higher is more relevant.
const scores = await rerank({ modelId, query: 'What is the capital of France?', documents })
await unloadModel({ modelId })
```

---

## Support Qwen-Image-2.1 generation and reference editing

PR: [#5302](https://github.com/tetherto/qvac/pull/5302)

`modelConfig.projectionModelSrc` loads the vision projector for the LLM encoder; Qwen-Image-2.1 reference editing requires it and `llmModelSrc`. `init_images` takes ordered references for models that support reference editing, including FLUX.2 and Qwen-Image-2.1. Qwen-Image-2.1 needs width and height in multiples of 32. The registry has no Qwen-Image-2.1 constants, so load the files from your own paths. One generation runs per model at a time (see [breaking changes](./breaking.md)).

```typescript
const modelId = await loadModel({
  modelSrc: '/models/qwen_image_2.1-Q4_K.gguf',
  modelType: 'sdcpp-generation',
  modelConfig: {
    llmModelSrc: '/models/Qwen3VL-8B-Instruct-Q4_K_M.gguf',
    projectionModelSrc: '/models/mmproj-Qwen3VL-8B-Instruct-F16.gguf',
    vaeModelSrc: '/models/qwen_image_2.1_vae_bf16.safetensors'
  }
})

const { outputs } = diffusion({
  modelId,
  prompt: 'Place the two referenced people together in one office.',
  init_images: [refA, refB],
  width: 512,
  height: 512
})
```

---

## Prime system prompts and tools through completion

PR: [#5312](https://github.com/tetherto/qvac/pull/5312)

`prefill: true` evaluates the prompt and tools without generating an answer, so the next turn with the same prefix only processes the new message. It requires an enabled `kvCache` and cannot be combined with a forced `tool_choice`. An auto cache key (`kvCache: true`) now includes the tools until the first assistant reply.

```typescript
await completion({
  modelId,
  history,
  tools,
  stream: false,
  kvCache: 'chat',
  prefill: true
}).final

const answer = await completion({
  modelId,
  history: [...history, { role: 'user', content: 'What is the weather in Lugano?' }],
  tools,
  stream: false,
  kvCache: 'chat'
}).final
```

---

## Add TranscribePsy transcription

PR: [#5347](https://github.com/tetherto/qvac/pull/5347)

Parakeet loads accept `longFormWindowFrames` and `longFormContextFrames` (80 ms encoder frames) for long offline recordings. `PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0` loads only on macOS and iOS; elsewhere the load is refused before download and names `PARAKEET_TRANSCRIBEPSY_250M_Q8_0`. Requires `@qvac/asr-ggml` `^0.11.1`.

```typescript
import {
  loadModel,
  transcribe,
  PARAKEET_TRANSCRIBEPSY_250M_Q8_0,
  PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0
} from '@qvac/inference'

// Long recordings: 30 s windows with 25 % overlap instead of the model's 60 s default.
const modelId = await loadModel({
  modelSrc: PARAKEET_TRANSCRIBEPSY_250M_Q8_0,
  modelType: 'parakeet-transcription',
  modelConfig: { longFormWindowFrames: 375, longFormContextFrames: 47 }
})
const text = await transcribe({ modelId, audioChunk: 'session.wav' })

// macOS / iOS: the Core ML distribution, encoder and decoder on the Neural Engine.
const coreml = await loadModel({
  modelSrc: PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0,
  modelType: 'parakeet-transcription'
})
```

---

## Report a missing registry model as ModelRegistryModelNotFoundError

PR: [#5356](https://github.com/tetherto/qvac/pull/5356)

`modelRegistryGetModel()` throws `ModelRegistryModelNotFoundError` (`QVAC_MODEL_REGISTRY_MODEL_NOT_FOUND`, 53951) with `registrySource` and `registryPath` when the registry has no such model (see [breaking changes](./breaking.md)).

```typescript
import { modelRegistryGetModel } from '@qvac/inference'
import { ModelRegistryModelNotFoundError } from '@qvac/inference/surface'

try {
  await modelRegistryGetModel('org/missing.gguf', 'hf')
} catch (err) {
  if (err instanceof ModelRegistryModelNotFoundError)
    console.log(err.registrySource, err.registryPath)
}
```

---
