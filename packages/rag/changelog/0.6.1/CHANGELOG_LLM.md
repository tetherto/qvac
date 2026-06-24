# QVAC RAG v0.6.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.6.1

This patch restores Pear/CJS compatibility for RAG adapters and adds a lightweight `./errors` subpath so SDK consumers can import error codes without pulling in the full package entry.

---

## 🐞 Fixes

### Pear/CJS compatibility (#2284)

RAG adapters now load hard dependencies (`hyperdb`, `hyperschema`, `llm-splitter`, `#fetch`) via synchronous `require()` instead of dynamic `await import()`. This fixes `MODULE_NOT_FOUND` failures when running RAG under Pear, where ESM dynamic imports are unavailable in the CJS module graph.

---

## 🔌 API

### `@qvac/rag/errors` subpath (#2303)

Consumers can now import RAG error codes and the error class from a dedicated subpath that does not transitively load `HyperDBAdapter` or other heavy runtime deps:

```typescript
import { ERR_CODES, QvacErrorRAG } from "@qvac/rag/errors";

if (err instanceof QvacErrorRAG && err.code === ERR_CODES.OPERATION_CANCELLED) {
  // handle cancellation
}
```

Existing `import { ERR_CODES } from "@qvac/rag"` continues to work unchanged.
