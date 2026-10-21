# QVAC SDK v0.23.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.23.0

QVAC SDK 0.23.0 sits on `@qvac/inference@0.23.0`. llama.cpp completion, embedding and decision models accept CPU polling controls, vector indexing comes from the standalone `@qvac/turbovec-ggml` addon, the CosyVoice3 Q4 model loads with a complete companion set, and the Node client keeps its worker socket in a folder only the current user can open.

The committed range is `^0.23.0`. `tetherto-qvac-sdk` publishes at the same version.

## New APIs

### CPU polling controls

CPU workers could busy-spin while a llama.cpp model ran on the GPU. The llama.cpp addons now let workers sleep by default, and completion, embedding and Laya decision configs accept `poll` and `pollBatch`, integers from 0 to 100. Unset values keep the native default. Higher values can reduce wake latency and use more CPU during GPU work. The Python and Kotlin clients carry the same fields.

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

## Features

### Standalone TurboVec addon

`@qvac/embed-llamacpp` 0.50 no longer carries the vector index. The SDK now depends on `@qvac/turbovec-ggml` for it, so embeddings and TurboVec-backed RAG keep working with no code change.

## Bug Fixes

### Private worker socket on Linux and macOS

The Node client listened for its worker on a Unix socket in the system temp folder, with permissions taken from the process umask. On Linux, where `/tmp` is shared, another local user could connect first and receive every request, or return forged results. The socket now sits in a new folder that only the current user can open, and the folder is removed with the socket on every shutdown path. Windows keeps its named pipe. The Python and Kotlin clients are unchanged.

## Model Changes

### Lighter CosyVoice3 set

`TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0` was in the catalog without a complete companion set, so loading it meant placing its files by hand. It now resolves the Q4 LLM with Q4 flow and F16 HiFT weights, plus the original tokenizer and English voice, and downloads all six files into one cache directory. The set is 1,057,658,782 bytes (0.985 GiB), 55.84% smaller than the Q8 set. `TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0` is unchanged.

```typescript
import { loadModel, TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0 } from '@qvac/sdk'

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
