# QVAC Inference v0.23.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.23.0

QVAC Inference 0.23.0 is the engine `@qvac/sdk@0.23.0` depends on. Vector indexing now comes from the standalone `@qvac/turbovec-ggml` addon, llama.cpp completion, embedding and decision models accept CPU polling controls, and the CosyVoice3 Q4 model loads with a complete companion set at less than half the download size of the Q8 set.

## Breaking Changes

### Vector indexing moves to `@qvac/turbovec-ggml`

`@qvac/embed-llamacpp` 0.50 no longer exports `IdMapIndex`. The embedding plugin now imports it from `@qvac/turbovec-ggml`, a new optional peer, and the `@qvac/embed-llamacpp` peer moves to `^0.50.0`. Hosts that install the peers themselves must add `@qvac/turbovec-ggml` and upgrade `@qvac/embed-llamacpp` to use the embedding plugin. `@qvac/sdk` 0.23 depends on both, so SDK users have nothing to change.

**Before:**

```json
{
  "dependencies": {
    "@qvac/inference": "^0.22.0",
    "@qvac/embed-llamacpp": "^0.48.1"
  }
}
```

**After:**

```json
{
  "dependencies": {
    "@qvac/inference": "^0.23.0",
    "@qvac/embed-llamacpp": "^0.50.0",
    "@qvac/turbovec-ggml": "^0.1.1"
  }
}
```

## New APIs

### CPU polling controls

CPU workers could busy-spin while a llama.cpp model ran on the GPU. The llama.cpp addons now let workers sleep by default, and completion, embedding and Laya decision configs accept `poll` and `pollBatch`, integers from 0 to 100. Unset values keep the native default. Higher values can reduce wake latency and use more CPU during GPU work. `pollBatch` maps to the native `poll-batch` parameter.

```typescript
import { loadModel } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: '/path/to/model.gguf',
  modelType: 'llamacpp-completion',
  modelConfig: {
    poll: 50,
    pollBatch: 0
  }
})
```

`threads-batch` now applies only to steps that process several tokens, such as prompt processing, parallel decoding and speculative verification. Single-sequence generation uses `threads` and `cpu-mask`. `cpu-mask-batch` inherits `cpu-mask` when no batch thread count is set.

## Model Changes

### Lighter CosyVoice3 set

`TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0` was in the catalog without a complete companion set, so loading it meant placing its files by hand. It now resolves the Q4 LLM with Q4 flow and F16 HiFT weights, plus the original tokenizer and English voice, and downloads all six files into one cache directory. The set is 1,057,658,782 bytes (0.985 GiB), 55.84% smaller than the Q8 set. `TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0` is unchanged.

```typescript
const modelId = await loadModel({
  modelSrc: TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0,
  modelType: 'tts-ggml',
  modelConfig: { ttsEngine: 'cosyvoice3' }
})
```

### Updated

```
TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0
```
