# 🔌 API Changes v0.6.2

## Add `./errors.js` export alias

TypeScript compiles `@qvac/rag/errors` imports to `@qvac/rag/errors.js` in ESM output. This release adds a matching export entry so consumers (notably `@qvac/sdk` re-exporting `RAG_ERROR_CODES`) resolve correctly at runtime.

```typescript
import { ERR_CODES } from "@qvac/rag/errors";
// compiled dist may import "@qvac/rag/errors.js" — both now resolve
```

---
