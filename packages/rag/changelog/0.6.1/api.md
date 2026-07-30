# 🔌 API Changes v0.6.1

## Expose @qvac/rag/errors subpath for consumers

PR: [#2303](https://github.com/tetherto/qvac/pull/2303)

```typescript
import { ERR_CODES, QvacErrorRAG } from '@qvac/rag/errors'

if (err instanceof QvacErrorRAG && err.code === ERR_CODES.OPERATION_CANCELLED) {
  // handle cancellation
}
```

---
