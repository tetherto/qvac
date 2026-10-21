# 🔌 API Changes v0.23.0

## Expose CPU polling controls for llama.cpp models

PR: [#5216](https://github.com/tetherto/qvac/pull/5216)

Completion, embedding and decision configs accept `poll` and `pollBatch`, integers from 0 to 100. The Python and Kotlin clients carry the same fields.

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

The `threads-batch`, `cpu-mask` and `cpu-mask-batch` descriptions now match `@qvac/llm-llamacpp` 0.61.2: `threads-batch` applies to steps that process several tokens and no longer overrides `threads` or `cpu-mask` for single-sequence generation.

---
