# 💥 Breaking Changes v0.7.0

## Convert @qvac/rag to TypeScript ESM

PR: [#3718](https://github.com/tetherto/qvac/pull/3718)

**BEFORE:**

```js
const { RAG, HyperDBAdapter } = require('@qvac/rag')
```

**AFTER:**

```ts
import { RAG, HyperDBAdapter } from '@qvac/rag'
```

---
