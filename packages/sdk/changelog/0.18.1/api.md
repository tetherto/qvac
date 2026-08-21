# 🔌 API Changes v0.18.1

## Describe llamacpp modelConfig fields and export config schemas

PR: [#3975](https://github.com/tetherto/qvac/pull/3975)

```typescript
import { llamacppCompletionConfigSchema } from '@qvac/sdk/schemas'

llamacppCompletionConfigSchema.shape.ctx_size.description
// "Context window size in tokens; `0` uses the model's trained context length. Default 1024."
```

---

